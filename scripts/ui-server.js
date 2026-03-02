"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { URL } = require("node:url");
const { runTask } = require("../src/coordinator");
const {
  createThread: createChatSession,
  updateThreadMode,
  updateThreadMeta,
  readMessages,
  readThreadMeta,
  listThreads: listChatSessions,
  sendChatMessage,
} = require("../src/engine/chat-session");
const { getModes, getMode, isValidMode, advanceWorkflowNode, WORKFLOW_NODES } = require("../src/modes/mode-registry");
const {
  // Thread API (new)
  createThread,
  readThread,
  updateThread,
  archiveThread,
  deleteThread,
  listThreads,
  listSessions,
  touchThread,
  ensureDefaultThread,
  validateAndRepairIndex,
  // Project API (backward compat)
  createProject,
  readProject,
  updateProject,
  deleteProject,
  listProjects,
  ensureDefaultProject,
} = require("../src/engine/project-manager");

const ROOT = path.resolve(__dirname, "..");
const UI_ROOT = path.join(ROOT, "ui");
const LOGS_ROOT = path.join(ROOT, "logs");
const CONFIG_ROOT = path.join(ROOT, "config");
const ROLE_CONFIG_FILE = path.join(CONFIG_ROOT, "role-config.json");
const PORT = Number(process.env.UI_PORT || 4173);
const HOST = process.env.UI_HOST || "127.0.0.1";
const ACTIVE_TASK_RUNS = new Map();
const ACTIVE_CHAT_RUNS = new Map(); // key = threadId, value = { controller, started_at }
const DEFAULT_PROJECT_ID = path.basename(ROOT).toLowerCase();
const DEFAULT_PROJECT_NAME = path
  .basename(ROOT)
  .split(/[-_]/g)
  .filter(Boolean)
  .map((x) => x.slice(0, 1).toUpperCase() + x.slice(1))
  .join(" ");
const THREAD_FALLBACK_ENABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.THREAD_FALLBACK_ENABLED || "1").trim()
);
const THREAD_FALLBACK_DISABLE_ON =
  String(process.env.THREAD_FALLBACK_DISABLE_ON || "2026-04-15").trim() || "2026-04-15";
const THREAD_FALLBACK_DISABLE_TS = (() => {
  const parsed = Date.parse(`${THREAD_FALLBACK_DISABLE_ON}T00:00:00.000Z`);
  const fallback = Date.parse("2026-04-15T00:00:00.000Z");
  return Number.isFinite(parsed) ? parsed : fallback;
})();

const STAGES = ["coder", "reviewer", "tester"];
const SUPPORTED_PROVIDERS = new Set(["claude-cli", "codex-cli", "gemini-cli"]);
const DEFAULT_STAGE_DUTY = Object.freeze({
  coder: "CoreDev",
  reviewer: "Reviewer",
  tester: "Tester",
});
const ROLE_DUTY_OPTIONS = Object.freeze(["CoreDev", "Reviewer", "Tester"]);

const DEFAULT_ROLE_CONFIG = Object.freeze({
  version: 3,
  models: [
    { id: "claude", name: "Claude", provider: "claude-cli" },
    { id: "codex", name: "Codex", provider: "codex-cli" },
    { id: "glm", name: "GLM", provider: "claude-cli", settings_file: "~/.claude/settings_glm.json" },
  ],
  stage_assignment: {
    coder: "claude",
    reviewer: "codex",
    tester: "glm",
  },
  role_profiles: {
    coder: {
      display_name: "Codex",
      role_title: "CoreDev",
      nickname: "小码",
    },
    reviewer: {
      display_name: "Claude",
      role_title: "Reviewer",
      nickname: "评审官",
    },
    tester: {
      display_name: "Claude",
      role_title: "Tester",
      nickname: "测试员",
    },
  },
});

const LIVE_SESSIONS = new Map(); // key = task_id/thread_id
const LIVE_STREAM_SUBSCRIBERS = new Map(); // key = task_id/thread_id -> Set<ServerResponse>
const TASK_RESOLVE_CACHE_TTL_MS = Math.max(1000, Number(process.env.TASK_RESOLVE_CACHE_TTL_MS || 8000));
const LONG_REQUEST_TRACE_ENABLED = /^(1|true|yes|on)$/i.test(
  String(process.env.LONG_REQUEST_TRACE_ENABLED || "1").trim()
);
const LONG_REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.LONG_REQUEST_TIMEOUT_MS || 180000));
const DEFAULT_ALLOWED_TEST_COMMANDS = String(process.env.ALLOWED_TEST_COMMANDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const DEFAULT_TESTER_BLOCKED_POLICY = String(process.env.TESTER_BLOCKED_POLICY || "").trim();
const TASK_RESOLVE_CACHE = {
  expires_at: 0,
  entries: [],
  by_task_id: new Map(),
  logged_hits: new Set(),
  logged_misses: new Set(),
};

function nowTs() {
  return Date.now();
}

function nowIsoUtc() {
  return new Date().toISOString();
}

function createTaskId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function sanitizeRequestId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 80);
}

function createRequestId() {
  return `req-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function extractRequestIdFromBody(body) {
  if (!body || typeof body !== "object") return "";
  const candidates = [
    body.request_id,
    body.requestId,
    body.client_request_id,
    body.clientRequestId,
    body.client_message_id,
    body.clientMessageId,
  ];
  for (const candidate of candidates) {
    const normalized = sanitizeRequestId(candidate);
    if (normalized) return normalized;
  }
  return "";
}

function isLongRequestTraceTarget(method, reqPath) {
  if (!LONG_REQUEST_TRACE_ENABLED || String(method || "").toUpperCase() !== "POST") return false;
  if (reqPath === "/api/chat") return true;
  if (/^\/api\/tasks\/[^/]+\/followup$/.test(reqPath)) return true;
  if (/^\/api\/tasks\/[^/]+\/rerun$/.test(reqPath)) return true;
  return false;
}

function createRequestTraceContext(req, reqPath) {
  const method = String(req?.method || "").toUpperCase();
  const pathName = String(reqPath || "");
  const startedAt = Date.now();
  const startedIso = new Date(startedAt).toISOString();
  const headerRequestId = sanitizeRequestId(req?.headers?.["x-request-id"] || req?.headers?.["x-requestid"]);
  return {
    tracked: isLongRequestTraceTarget(method, pathName),
    method,
    path: pathName,
    started_at: startedAt,
    started_iso: startedIso,
    request_id: headerRequestId || createRequestId(),
    timeout_logged: false,
    completed: false,
    timeout_timer: null,
  };
}

function bindRequestTrace(req, res, trace) {
  if (!trace?.tracked) return;
  req.__traceContext = trace;
  req.__traceResponse = res;
  if (!res.headersSent) {
    res.setHeader("x-request-id", trace.request_id);
  }
  process.stdout.write(
    `[http-trace] ts=${trace.started_iso} stage=start request_id=${trace.request_id} method=${trace.method} path=${trace.path}\n`
  );
  const finalizeTrace = (stage, statusCode) => {
    if (trace.completed) return;
    trace.completed = true;
    if (trace.timeout_timer) {
      clearTimeout(trace.timeout_timer);
      trace.timeout_timer = null;
    }
    const endedAt = Date.now();
    const endedIso = new Date(endedAt).toISOString();
    const safeStatus = Number.isFinite(statusCode) ? statusCode : 0;
    process.stdout.write(
      `[http-trace] ts=${endedIso} stage=${stage} request_id=${trace.request_id} method=${trace.method} path=${trace.path} status=${safeStatus} started_at=${trace.started_iso} ended_at=${endedIso} duration_ms=${endedAt - trace.started_at}\n`
    );
  };
  if (LONG_REQUEST_TIMEOUT_MS > 0) {
    trace.timeout_timer = setTimeout(() => {
      trace.timeout_logged = true;
      process.stdout.write(
        `[http-trace] ts=${nowIsoUtc()} stage=timeout_hint request_id=${trace.request_id} method=${trace.method} path=${trace.path} timeout_ms=${LONG_REQUEST_TIMEOUT_MS} elapsed_ms=${Date.now() - trace.started_at}\n`
      );
    }, LONG_REQUEST_TIMEOUT_MS);
    if (typeof trace.timeout_timer.unref === "function") {
      trace.timeout_timer.unref();
    }
  }
  res.on("finish", () => finalizeTrace("finish", res.statusCode));
  res.on("close", () => finalizeTrace("close", res.statusCode));
}

function updateTraceRequestId(req, body) {
  const trace = req?.__traceContext;
  if (!trace?.tracked) return;
  const bodyRequestId = extractRequestIdFromBody(body);
  if (!bodyRequestId || bodyRequestId === trace.request_id) return;
  const oldRequestId = trace.request_id;
  trace.request_id = bodyRequestId;
  const res = req.__traceResponse;
  if (res && !res.headersSent) {
    res.setHeader("x-request-id", bodyRequestId);
  }
  process.stdout.write(
    `[http-trace] ts=${nowIsoUtc()} stage=request_id_override old_request_id=${oldRequestId} request_id=${trace.request_id} method=${trace.method} path=${trace.path}\n`
  );
}

function threadFallbackState(now = nowTs()) {
  if (!THREAD_FALLBACK_ENABLED) {
    return { allowed: false, reason: "disabled", disable_on: THREAD_FALLBACK_DISABLE_ON };
  }
  if (Number.isFinite(THREAD_FALLBACK_DISABLE_TS) && now >= THREAD_FALLBACK_DISABLE_TS) {
    return { allowed: false, reason: "expired", disable_on: THREAD_FALLBACK_DISABLE_ON };
  }
  return { allowed: true, reason: null, disable_on: THREAD_FALLBACK_DISABLE_ON };
}

function locateSessionThread(sessionId, hintedThreadId = null) {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;
  const hint = String(hintedThreadId || "").trim();
  if (hint) {
    const hintedMeta = readThreadMeta(LOGS_ROOT, sid, hint);
    if (hintedMeta) return hintedMeta.parent_thread || hint;
  }
  const legacyMeta = readThreadMeta(LOGS_ROOT, sid);
  if (legacyMeta?.parent_thread) {
    const parent = String(legacyMeta.parent_thread).trim();
    if (parent && readThread(LOGS_ROOT, parent)) return parent;
  }
  const allThreads = listThreads(LOGS_ROOT);
  for (const thread of allThreads) {
    const tid = String(thread?.thread_id || "").trim();
    if (!tid) continue;
    const maybeSessionDir = path.join(LOGS_ROOT, "threads", tid, "sessions", sid);
    if (fs.existsSync(maybeSessionDir)) return tid;
  }
  return null;
}

function assertThreadId(payload, opts = {}) {
  const source = String(opts.source || "unknown");
  const mode = String(opts.mode || "").trim();
  if (mode !== "chat" && mode !== "container") {
    return {
      ok: false,
      status: 500,
      error: `invalid assertThreadId mode: ${mode || "(missing)"}`,
    };
  }
  const allowFallback = opts.allowFallback !== false;
  const hintedThreadId = String(opts.hintedThreadId || "").trim() || null;
  const sessionId = String(opts.sessionId || "").trim() || null;
  const explicitContainerId = String(payload?.thread_slug || payload?.project_id || "").trim();
  const legacyThreadField = String(payload?.thread_id || "").trim();

  if (mode === "container") {
    const containerCandidate = explicitContainerId || legacyThreadField;
    if (containerCandidate) {
      const resolved = readThread(LOGS_ROOT, containerCandidate);
      if (!resolved) {
        if (!explicitContainerId && legacyThreadField) {
          return {
            ok: false,
            status: 422,
            error: "thread_id is session-scoped on chat routes; use thread_slug/project_id for container routes",
          };
        }
        return {
          ok: false,
          status: 404,
          error: `thread not found: ${containerCandidate}`,
        };
      }
      return { ok: true, threadId: containerCandidate, thread: resolved, fallback_used: false };
    }
  } else if (explicitContainerId) {
    const resolved = readThread(LOGS_ROOT, explicitContainerId);
    if (!resolved) {
      return {
        ok: false,
        status: 404,
        error: `thread not found: ${explicitContainerId}`,
      };
    }
    return { ok: true, threadId: explicitContainerId, thread: resolved, fallback_used: false };
  }

  if (sessionId) {
    const inferred = locateSessionThread(sessionId, hintedThreadId);
    if (inferred) {
      const existing = readThread(LOGS_ROOT, inferred);
      if (existing) return { ok: true, threadId: inferred, thread: existing, fallback_used: false };
    }
  }

  const fallback = threadFallbackState();
  if (allowFallback && fallback.allowed) {
    const fallbackThread = readThread(LOGS_ROOT, DEFAULT_PROJECT_ID);
    if (!fallbackThread) {
      return {
        ok: false,
        status: 500,
        error: `fallback thread not found: ${DEFAULT_PROJECT_ID}`,
      };
    }
    process.stdout.write(
      `[thread-fallback] source=${source} thread=${DEFAULT_PROJECT_ID} disable_on=${THREAD_FALLBACK_DISABLE_ON}\n`
    );
    return { ok: true, threadId: DEFAULT_PROJECT_ID, thread: fallbackThread, fallback_used: true };
  }

  const error =
    fallback.reason === "expired"
      ? `thread_id is required; fallback disabled on ${THREAD_FALLBACK_DISABLE_ON}`
      : "thread_id is required";
  return {
    ok: false,
    status: 422,
    error,
    fallback: {
      enabled: THREAD_FALLBACK_ENABLED,
      disable_on: THREAD_FALLBACK_DISABLE_ON,
      reason: fallback.reason || "disabled",
    },
  };
}

function initialLiveAgent({ agentKey, role, stage, displayName }) {
  return {
    agent_key: String(agentKey || role || "agent"),
    role: String(role || "agent"),
    stage: String(stage || role || "agent"),
    display_name: String(displayName || agentKey || role || "agent"),
    state: "idle",
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
    tool_calls: 0,
    run_id: null,
    error: null,
    last_preview: "",
    updated_at: nowTs(),
  };
}

function isWorkflowMode(mode) {
  return String(mode || "").trim().toLowerCase() === "workflow";
}

function ensureLiveSession(taskId, opts = {}) {
  const key = String(taskId || "").trim();
  if (!key) return null;
  const roleConfig = opts.roleConfig ? normalizeRoleConfig(opts.roleConfig) : null;
  let session = LIVE_SESSIONS.get(key);
  if (!session) {
    session = {
      task_id: key,
      mode: opts.mode || null,
      running: !!opts.running,
      current_stage: opts.current_stage || null,
      final_outcome: null,
      updated_at: nowTs(),
      agents: {},
    };
    if (roleConfig && isWorkflowMode(opts.mode)) {
      const profiles = stageRoleProfiles(roleConfig);
      for (const stage of STAGES) {
        const p = profiles[stage] || {};
        session.agents[stage] = initialLiveAgent({
          agentKey: stage,
          role: stage,
          stage,
          displayName: p.display_name || stage,
        });
      }
    }
    LIVE_SESSIONS.set(key, session);
  }
  if (opts.mode) session.mode = opts.mode;
  // Keep live agent dimensions consistent:
  // - workflow mode uses stage agents (coder/reviewer/tester)
  // - chat-like modes use dynamic cat agents keyed by cat name
  if (!isWorkflowMode(session.mode)) {
    for (const stage of STAGES) {
      const agent = session.agents?.[stage];
      if (!agent) continue;
      if (String(agent.role || stage) === stage) {
        delete session.agents[stage];
      }
    }
  }
  if (opts.current_stage) session.current_stage = opts.current_stage;
  if (opts.running !== undefined) session.running = !!opts.running;
  session.updated_at = nowTs();
  publishLiveSnapshot(key);
  return session;
}

function ensureLiveAgent(session, agentKey, defaults = {}) {
  if (!session) return null;
  const key = String(agentKey || defaults.role || "agent");
  if (!session.agents[key]) {
    session.agents[key] = initialLiveAgent({
      agentKey: key,
      role: defaults.role || key,
      stage: defaults.stage || defaults.role || key,
      displayName: defaults.display_name || key,
    });
  }
  const agent = session.agents[key];
  if (defaults.role) agent.role = String(defaults.role);
  if (defaults.stage) agent.stage = String(defaults.stage);
  if (defaults.display_name) agent.display_name = String(defaults.display_name);
  agent.updated_at = nowTs();
  return agent;
}

function applyUsageToLiveAgent(agent, usage = {}) {
  const inTokens = Number(usage?.usage?.input_tokens);
  const outTokens = Number(usage?.usage?.output_tokens);
  const cost = Number(usage?.total_cost_usd);
  if (Number.isFinite(inTokens)) agent.input_tokens = inTokens;
  if (Number.isFinite(outTokens)) agent.output_tokens = outTokens;
  if (Number.isFinite(cost)) agent.cost_usd = cost;
}

function patchLiveAgent(taskId, agentKey, patch = {}, defaults = {}) {
  const session = ensureLiveSession(taskId, { running: true });
  if (!session) return;
  const agent = ensureLiveAgent(session, agentKey, defaults);
  if (!agent) return;
  if (patch.state) agent.state = String(patch.state);
  if (patch.stage) {
    agent.stage = String(patch.stage);
    session.current_stage = String(patch.stage);
  }
  if (patch.run_id !== undefined) agent.run_id = patch.run_id || null;
  if (patch.error !== undefined) agent.error = patch.error || null;
  if (patch.last_preview !== undefined) {
    agent.last_preview = String(patch.last_preview || "").slice(0, 200);
  }
  if (Number.isFinite(Number(patch.input_tokens))) agent.input_tokens = Number(patch.input_tokens);
  if (Number.isFinite(Number(patch.output_tokens))) agent.output_tokens = Number(patch.output_tokens);
  if (Number.isFinite(Number(patch.cost_usd))) agent.cost_usd = Number(patch.cost_usd);
  if (Number.isFinite(Number(patch.tool_calls))) agent.tool_calls = Number(patch.tool_calls);
  agent.updated_at = nowTs();
  session.updated_at = nowTs();
  publishLiveSnapshot(taskId);
}

function looksLikeToolSignal(event) {
  if (!event || typeof event !== "object") return false;
  if (event.type === "provider.ndjson") {
    const obj = event.data?.obj;
    if (obj?.type === "tool_use" || obj?.type === "tool_result") return true;
    if (obj?.type === "assistant" && Array.isArray(obj?.message?.content)) {
      return obj.message.content.some((p) => p?.type === "tool_use" || p?.type === "tool_result");
    }
  }
  const raw =
    event.type === "run.stderr.chunk"
      ? String(event.data?.text || "")
      : event.type === "run.stderr.line"
        ? String(event.data?.line || "")
        : event.type === "run.stdout.line"
          ? String(event.data?.line || "")
          : "";
  if (!raw) return false;
  return /(tool|command|bash|shell|apply_patch|editing|running tests|npm test|pnpm test|yarn test)/i.test(raw);
}

function applyLiveEvent(taskId, agentKey, event, defaults = {}) {
  const session = ensureLiveSession(taskId, { running: true, current_stage: defaults.stage || null });
  if (!session) return;
  const agent = ensureLiveAgent(session, agentKey, defaults);
  if (!agent) return;
  if (event?.type === "run.started") {
    agent.state = "thinking";
    agent.error = null;
  } else if (event?.type === "assistant.text") {
    agent.state = "replying";
    const txt = String(event?.data?.text || "").trim();
    if (txt) agent.last_preview = txt.slice(0, 200);
  } else if (event?.type === "run.usage") {
    applyUsageToLiveAgent(agent, event?.data || {});
  } else if (event?.type === "run.failed") {
    agent.state = "error";
    agent.error = String(event?.data?.message || "run_failed");
  } else if (event?.type === "run.completed") {
    const code = Number(event?.data?.code);
    agent.state = Number.isFinite(code) && code !== 0 ? "error" : "done";
  } else if (looksLikeToolSignal(event)) {
    agent.state = "tool";
    agent.tool_calls = Number(agent.tool_calls || 0) + 1;
  }
  if (defaults.stage) {
    agent.stage = String(defaults.stage);
    session.current_stage = String(defaults.stage);
  }
  if (defaults.display_name) agent.display_name = String(defaults.display_name);
  agent.updated_at = nowTs();
  session.updated_at = nowTs();
  publishLiveSnapshot(taskId);
}

function finalizeLiveSession(taskId, outcome = "idle") {
  const key = String(taskId || "").trim();
  if (!key) return;
  const session = LIVE_SESSIONS.get(key);
  if (!session) return;
  session.running = false;
  session.final_outcome = String(outcome || "idle");
  session.updated_at = nowTs();
  for (const agent of Object.values(session.agents || {})) {
    if (!agent || typeof agent !== "object") continue;
    if (agent.state !== "error") {
      agent.state = "idle";
    }
    agent.updated_at = nowTs();
  }
  publishLiveSnapshot(key);
}

function buildFallbackLiveFromMessages(taskId, bundle) {
  const messages = Array.isArray(bundle?.messages) ? bundle.messages : [];
  const agents = {};
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    if (m.role === "task") continue;
    const isChat = m.role === "chat";
    const agentKey = isChat
      ? `chat:${String(m.cat_name || m.role_label || "chat")}`
      : String(m.role || "agent");
    if (!agents[agentKey]) {
      agents[agentKey] = initialLiveAgent({
        agentKey,
        role: isChat ? "chat" : (m.role || "agent"),
        stage: isChat ? "chat" : (m.role || "agent"),
        displayName: isChat
          ? String(m.role_label || m.cat_name || "猫猫")
          : String(m.role_display_name || m.role_label || m.role || agentKey),
      });
    }
    const agent = agents[agentKey];
    if (Number.isFinite(m.ts) && m.ts > Number(agent.updated_at || 0)) {
      agent.updated_at = Number(m.ts);
      agent.last_preview = String(m.text || "").trim().slice(0, 200);
    }
    if (Number.isFinite(m.input_tokens)) agent.input_tokens += Number(m.input_tokens);
    if (Number.isFinite(m.output_tokens)) agent.output_tokens += Number(m.output_tokens);
    if (Number.isFinite(m.cost_usd)) agent.cost_usd += Number(m.cost_usd);
    if (m.ok === false) {
      agent.state = "error";
      agent.error = "last_message_failed";
    }
  }
  return {
    task_id: String(taskId || ""),
    mode: bundle?._thread_mode || null,
    running: false,
    current_stage: bundle?.current_stage || bundle?._thread_mode || null,
    final_outcome: bundle?.final_outcome || null,
    updated_at: nowTs(),
    agents,
  };
}

function liveSessionSnapshot(taskId, fallbackBundle = null) {
  const key = String(taskId || "").trim();
  if (!key) return null;
  const live = LIVE_SESSIONS.get(key);
  if (live) return JSON.parse(JSON.stringify(live));
  if (fallbackBundle) return buildFallbackLiveFromMessages(key, fallbackBundle);
  return {
    task_id: key,
    mode: null,
    running: false,
    current_stage: null,
    final_outcome: null,
    updated_at: nowTs(),
    agents: {},
  };
}

function addLiveSubscriber(taskId, res) {
  const key = String(taskId || "").trim();
  if (!key || !res) return;
  if (!LIVE_STREAM_SUBSCRIBERS.has(key)) {
    LIVE_STREAM_SUBSCRIBERS.set(key, new Set());
  }
  LIVE_STREAM_SUBSCRIBERS.get(key).add(res);
}

function removeLiveSubscriber(taskId, res) {
  const key = String(taskId || "").trim();
  if (!key || !res) return;
  const set = LIVE_STREAM_SUBSCRIBERS.get(key);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) LIVE_STREAM_SUBSCRIBERS.delete(key);
}

function publishLiveSnapshot(taskId) {
  const key = String(taskId || "").trim();
  if (!key) return;
  const subs = LIVE_STREAM_SUBSCRIBERS.get(key);
  if (!subs || subs.size === 0) return;
  const payload = liveSessionSnapshot(key);
  const data = `event: live\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...subs]) {
    try {
      res.write(data);
    } catch {
      removeLiveSubscriber(key, res);
    }
  }
}

function sendJson(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendText(res, code, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": contentType });
  res.end(text);
}

function sendMarkdown(res, code, text, filename = "report.md") {
  res.writeHead(code, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
  res.end(text);
}

function safeTouchThreadActivity(threadId, source = "") {
  const tid = String(threadId || "").trim();
  if (!tid) return;
  try {
    touchThread(LOGS_ROOT, tid);
  } catch (err) {
    const head = `[thread-touch] failed source=${source || "-"} thread=${tid} message=${err?.message || String(err)}\n`;
    process.stderr.write(head);
    if (err?.stack) process.stderr.write(`${String(err.stack)}\n`);
  }
}

function safeReadJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function cloneDefaultRoleConfig() {
  return JSON.parse(JSON.stringify(DEFAULT_ROLE_CONFIG));
}

function clip(s, max = 64) {
  return String(s || "").trim().slice(0, max);
}

function parseCommandList(value) {
  if (Array.isArray(value)) {
    return value.map((x) => String(x || "").trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((x) => x.trim()).filter(Boolean);
  }
  return [];
}

function resolveAllowedTestCommands(body, summary = null) {
  const bodyCommands = parseCommandList(body?.allowed_test_commands ?? body?.allowedTestCommands);
  if (bodyCommands.length) return bodyCommands;
  const summaryCommands = parseCommandList(summary?.allowed_test_commands ?? summary?.allowedTestCommands);
  if (summaryCommands.length) return summaryCommands;
  return DEFAULT_ALLOWED_TEST_COMMANDS.length ? [...DEFAULT_ALLOWED_TEST_COMMANDS] : undefined;
}

function resolveTesterBlockedPolicy(body, summary = null) {
  const bodyPolicy = String(body?.tester_blocked_policy ?? body?.testerBlockedPolicy ?? "").trim();
  if (bodyPolicy) return bodyPolicy;
  const summaryPolicy = String(summary?.tester_blocked_policy || "").trim();
  if (summaryPolicy) return summaryPolicy;
  return DEFAULT_TESTER_BLOCKED_POLICY || undefined;
}

function normalizeRoleConfig(input) {
  const fallback = cloneDefaultRoleConfig();
  if (!input || typeof input !== "object") return fallback;

  const inModels = Array.isArray(input.models) ? input.models : [];
  const mergedModels = fallback.models.map((base) => {
    const found = inModels.find((m) => m && m.id === base.id) || {};
    return {
      id: base.id,
      name: found.name || base.name,
      provider: found.provider || base.provider,
      model: found.model || base.model || undefined,
      settings_file: found.settings_file || base.settings_file || undefined,
    };
  });
  // Add any input models not in fallback (e.g. glm)
  for (const m of inModels) {
    if (!m || !m.id) continue;
    if (mergedModels.some((x) => x.id === m.id)) continue;
    mergedModels.push({
      id: m.id,
      name: m.name || m.id,
      provider: m.provider || "claude-cli",
      model: m.model || undefined,
      settings_file: m.settings_file || undefined,
    });
  }

  const validIds = new Set(mergedModels.map((m) => m.id));
  const stageIn = input.stage_assignment && typeof input.stage_assignment === "object"
    ? input.stage_assignment
    : {};
  const stage = {};
  for (const key of ["coder", "reviewer", "tester"]) {
    const candidate = String(stageIn[key] || "").trim();
    stage[key] = validIds.has(candidate) ? candidate : fallback.stage_assignment[key];
  }

  const oldModelRoles = new Map(
    inModels
      .filter((x) => x && typeof x.id === "string" && typeof x.role === "string")
      .map((x) => [x.id, clip(x.role)])
  );

  function fallbackProfile(stageKey) {
    const fromDefault = fallback.role_profiles[stageKey] || {};
    const modelId = stage[stageKey];
    const model = mergedModels.find((m) => m.id === modelId);
    const displayName = clip(fromDefault.display_name || model?.name || stageKey);
    const roleTitleRaw = clip(oldModelRoles.get(modelId) || fromDefault.role_title || DEFAULT_STAGE_DUTY[stageKey]);
    const roleTitle = ROLE_DUTY_OPTIONS.includes(roleTitleRaw) ? roleTitleRaw : DEFAULT_STAGE_DUTY[stageKey];
    const nickname = clip(fromDefault.nickname || displayName);
    return { display_name: displayName, role_title: roleTitle, nickname };
  }

  const profilesIn = input.role_profiles && typeof input.role_profiles === "object" ? input.role_profiles : {};

  function legacyNickname(stageKey, fallbackNickname) {
    for (const source of STAGES) {
      if (source === stageKey) continue;
      const sourceProfile = profilesIn[source];
      if (!sourceProfile || typeof sourceProfile !== "object") continue;
      const aliases = sourceProfile.aliases && typeof sourceProfile.aliases === "object" ? sourceProfile.aliases : {};
      const old = aliases[stageKey];
      if (String(old || "").trim()) return clip(old);
    }
    return clip(fallbackNickname);
  }

  const roleProfiles = {};
  for (const stageKey of STAGES) {
    const baseProfile = fallbackProfile(stageKey);
    const inP = profilesIn[stageKey] && typeof profilesIn[stageKey] === "object" ? profilesIn[stageKey] : {};
    const roleTitleRaw = clip(inP.role_title || inP.role || baseProfile.role_title || DEFAULT_STAGE_DUTY[stageKey]);
    const roleTitle = ROLE_DUTY_OPTIONS.includes(roleTitleRaw) ? roleTitleRaw : DEFAULT_STAGE_DUTY[stageKey];
    const displayName = clip(inP.display_name || inP.name || baseProfile.display_name);
    const nickname = clip(inP.nickname || inP.alias || legacyNickname(stageKey, baseProfile.nickname || displayName));
    roleProfiles[stageKey] = {
      display_name: displayName,
      role_title: roleTitle,
      nickname: nickname || displayName,
    };
  }

  return {
    version: input.version || 3,
    models: mergedModels,
    stage_assignment: stage,
    role_profiles: roleProfiles,
    cats: input.cats && typeof input.cats === "object" ? input.cats : undefined,
  };
}

function validateNicknameUniqueness(roleConfig) {
  const cfg = normalizeRoleConfig(roleConfig);
  const seen = new Map();

  for (const stage of STAGES) {
    const nick = clip(cfg.role_profiles?.[stage]?.nickname);
    if (!nick) {
      return {
        ok: false,
        roleConfig: cfg,
        error: `role_profiles.${stage}.nickname 不能为空`,
      };
    }
    const key = nick.toLowerCase();
    const prevStage = seen.get(key);
    if (prevStage && prevStage !== stage) {
      return {
        ok: false,
        roleConfig: cfg,
        error: `昵称“${nick}”重复：${prevStage} 与 ${stage}`,
      };
    }
    seen.set(key, stage);
  }

  return { ok: true, roleConfig: cfg, error: "" };
}

function readRoleConfig() {
  const parsed = safeReadJson(ROLE_CONFIG_FILE);
  return normalizeRoleConfig(parsed);
}

function writeRoleConfig(nextConfig) {
  const checked = validateNicknameUniqueness(nextConfig);
  if (!checked.ok) {
    throw new Error(checked.error);
  }
  const normalized = checked.roleConfig;
  fs.mkdirSync(CONFIG_ROOT, { recursive: true });
  fs.writeFileSync(ROLE_CONFIG_FILE, JSON.stringify(normalized, null, 2) + "\n", "utf8");
  return normalized;
}

function modelById(roleConfig) {
  const m = new Map();
  for (const x of roleConfig.models || []) m.set(x.id, x);
  return m;
}

function stageAssignmentToRoleProviders(roleConfig) {
  const map = modelById(roleConfig);
  const out = {};
  for (const stage of STAGES) {
    const modelId = roleConfig?.stage_assignment?.[stage];
    const model = map.get(modelId);
    out[stage] = {
      model_id: modelId || null,
      provider: model?.provider || "claude-cli",
      model: model?.model || null,
      settings_file: model?.settings_file || null,
    };
  }
  return out;
}

function validateTaskProviders(defaultProvider, roleProviders) {
  const issues = [];
  const fallbackProvider = String(defaultProvider || "").trim();
  if (fallbackProvider && !SUPPORTED_PROVIDERS.has(fallbackProvider)) {
    issues.push({
      stage: "default",
      provider: fallbackProvider,
      model_id: null,
    });
  }
  for (const stage of STAGES) {
    const cfg = roleProviders?.[stage] || {};
    const provider = String(cfg.provider || "").trim();
    if (!provider || SUPPORTED_PROVIDERS.has(provider)) continue;
    issues.push({
      stage,
      provider,
      model_id: cfg.model_id || null,
    });
  }
  if (!issues.length) return { ok: true, issues: [] };
  const detailText = issues
    .map((x) => `${x.stage}(model_id=${x.model_id || "-"}, provider=${x.provider || "-"})`)
    .join("; ");
  return {
    ok: false,
    code: "provider_unsupported",
    issues,
    error: `Unsupported provider in role config: ${detailText}. Supported providers: ${Array.from(SUPPORTED_PROVIDERS).join(", ")}`,
  };
}

function stageRoleProfiles(roleConfig) {
  const cfg = normalizeRoleConfig(roleConfig);
  const out = {};
  for (const stage of STAGES) {
    const p = cfg.role_profiles?.[stage] || {};
    const roleTitle = clip(p.role_title || DEFAULT_STAGE_DUTY[stage]);
    out[stage] = {
      display_name: clip(p.display_name || stage),
      role_title: ROLE_DUTY_OPTIONS.includes(roleTitle) ? roleTitle : DEFAULT_STAGE_DUTY[stage],
      nickname: clip(p.nickname || p.display_name || stage),
    };
  }
  return out;
}

function createLiveHooks(taskId, opts = {}) {
  const key = String(taskId || "").trim();
  if (!key) return null;
  const mode = opts.mode || null;
  const roleConfig = opts.roleConfig || null;
  ensureLiveSession(key, { mode, roleConfig, running: true, current_stage: opts.current_stage || null });
  return {
    onAgentState(payload = {}) {
      const agentKey = String(payload.agent_key || payload.role || "agent");
      patchLiveAgent(
        key,
        agentKey,
        payload,
        {
          role: payload.role || agentKey,
          stage: payload.stage || payload.role || agentKey,
          display_name: payload.display_name || payload.role || agentKey,
        }
      );
    },
    onAgentEvent(payload = {}) {
      const agentKey = String(payload.agent_key || payload.role || "agent");
      applyLiveEvent(
        key,
        agentKey,
        payload.event || null,
        {
          role: payload.role || agentKey,
          stage: payload.stage || payload.role || agentKey,
          display_name: payload.display_name || payload.role || agentKey,
        }
      );
    },
  };
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk.toString("utf8");
      if (data.length > 2 * 1024 * 1024) {
        reject(new Error("request body too large"));
      }
    });
    req.on("end", () => {
      if (!data.trim()) {
        updateTraceRequestId(req, {});
        return resolve({});
      }
      try {
        const parsed = JSON.parse(data);
        updateTraceRequestId(req, parsed);
        resolve(parsed);
      } catch {
        reject(new Error("invalid json body"));
      }
    });
    req.on("error", reject);
  });
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

function listDateDirs(rootDir) {
  if (!fs.existsSync(rootDir)) return [];
  return fs
    .readdirSync(rootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse();
}

function invalidateTaskResolveCache() {
  TASK_RESOLVE_CACHE.expires_at = 0;
  TASK_RESOLVE_CACHE.entries = [];
  TASK_RESOLVE_CACHE.by_task_id = new Map();
  TASK_RESOLVE_CACHE.logged_hits = new Set();
  TASK_RESOLVE_CACHE.logged_misses = new Set();
}

function parseLegacyTaskDirName(name) {
  if (name.startsWith("run-")) return name.slice(4);
  if (name.startsWith("task-")) return name.slice(5);
  return null;
}

function parseThreadTaskDirName(name) {
  if (!name.startsWith("task-")) return null;
  return name.slice(5);
}

function collectLegacyTaskDirs() {
  const dates = listDateDirs(LOGS_ROOT);
  const out = [];
  for (const date of dates) {
    const dateDir = path.join(LOGS_ROOT, date);
    let entries = [];
    try {
      entries = fs.readdirSync(dateDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      const taskId = parseLegacyTaskDirName(e.name);
      if (!taskId) continue;
      out.push({
        taskId,
        source: "legacy",
        date,
        thread_id: null,
        dir: path.join(dateDir, e.name),
      });
    }
  }
  return out;
}

function collectThreadTaskDirs() {
  const threadsRoot = path.join(LOGS_ROOT, "threads");
  if (!fs.existsSync(threadsRoot)) return [];
  let threadEntries = [];
  try {
    threadEntries = fs.readdirSync(threadsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const thread of threadEntries) {
    if (!thread.isDirectory() || thread.isSymbolicLink()) continue;
    if (thread.name.startsWith("_")) continue;
    const sessionsDir = path.join(threadsRoot, thread.name, "sessions");
    if (!fs.existsSync(sessionsDir)) continue;
    let sessionEntries = [];
    try {
      sessionEntries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sess of sessionEntries) {
      if (!sess.isDirectory() || sess.isSymbolicLink()) continue;
      const taskId = parseThreadTaskDirName(sess.name);
      if (!taskId) continue;
      out.push({
        taskId,
        source: "thread",
        date: null,
        thread_id: thread.name,
        dir: path.join(sessionsDir, sess.name),
      });
    }
  }
  return out;
}

function candidateSortForResolve(a, b) {
  const tsDiff = (Number(b.updated_ts) || 0) - (Number(a.updated_ts) || 0);
  if (tsDiff !== 0) return tsDiff;
  const aPri = a.source === "thread" ? 2 : 1;
  const bPri = b.source === "thread" ? 2 : 1;
  if (aPri !== bPri) return bPri - aPri;
  return String(a.dir || "").localeCompare(String(b.dir || ""));
}

function hydrateTaskCandidate(base) {
  const summary = safeReadJson(path.join(base.dir, "summary.json"));
  const updatedTs = taskUpdatedTs(summary, base.dir);
  return {
    ...base,
    summary,
    updated_ts: updatedTs,
  };
}

function buildTaskResolveIndex() {
  const candidates = [...collectLegacyTaskDirs(), ...collectThreadTaskDirs()].map(hydrateTaskCandidate);
  const grouped = new Map();
  for (const c of candidates) {
    if (!grouped.has(c.taskId)) grouped.set(c.taskId, []);
    grouped.get(c.taskId).push(c);
  }

  const byTaskId = new Map();
  const entries = [];

  for (const [taskId, group] of grouped.entries()) {
    group.sort(candidateSortForResolve);
    const chosen = group[0];
    byTaskId.set(taskId, chosen);
    entries.push(chosen);
    if (group.length > 1) {
      const candidatesText = group
        .map((g) => `${g.source}:${path.relative(LOGS_ROOT, g.dir)}`)
        .join(", ");
      process.stdout.write(
        `[task-resolve] conflict task=${taskId} picked=${chosen.source}:${path.relative(LOGS_ROOT, chosen.dir)} candidates=[${candidatesText}]\n`
      );
    }
  }

  entries.sort(candidateSortForResolve);
  return { entries, byTaskId };
}

function getTaskResolveIndex(opts = {}) {
  const now = Date.now();
  const force = opts.force === true;
  if (!force && TASK_RESOLVE_CACHE.expires_at > now) {
    return {
      entries: TASK_RESOLVE_CACHE.entries,
      byTaskId: TASK_RESOLVE_CACHE.by_task_id,
    };
  }
  const index = buildTaskResolveIndex();
  TASK_RESOLVE_CACHE.entries = index.entries;
  TASK_RESOLVE_CACHE.by_task_id = index.byTaskId;
  TASK_RESOLVE_CACHE.expires_at = now + TASK_RESOLVE_CACHE_TTL_MS;
  TASK_RESOLVE_CACHE.logged_hits = new Set();
  TASK_RESOLVE_CACHE.logged_misses = new Set();
  return index;
}

function logTaskResolveHit(hit) {
  const key = `${hit.taskId}:${hit.dir}`;
  if (TASK_RESOLVE_CACHE.logged_hits.has(key)) return;
  TASK_RESOLVE_CACHE.logged_hits.add(key);
  process.stdout.write(
    `[task-resolve] found task=${hit.taskId} source=${hit.source} path=${path.relative(LOGS_ROOT, hit.dir)}\n`
  );
}

function logTaskResolveMiss(taskId) {
  const id = String(taskId || "").trim();
  if (!id) return;
  if (TASK_RESOLVE_CACHE.logged_misses.has(id)) return;
  TASK_RESOLVE_CACHE.logged_misses.add(id);
  process.stdout.write(`[task-resolve] miss task=${id}\n`);
}

function taskRelativePath(taskDir) {
  try {
    const rel = path.relative(LOGS_ROOT, taskDir);
    if (!rel || rel.startsWith("..")) return null;
    return rel;
  } catch {
    return null;
  }
}

function resolveTaskById(taskId, opts = {}) {
  const id = String(taskId || "").trim();
  if (!id) return null;
  const retryOnce = opts.retryOnce !== false;
  const index = getTaskResolveIndex();
  let hit = index.byTaskId.get(id) || null;
  if (hit && fs.existsSync(hit.dir)) {
    logTaskResolveHit(hit);
    return hit;
  }
  if (retryOnce) {
    const retryIndex = getTaskResolveIndex({ force: true });
    hit = retryIndex.byTaskId.get(id) || null;
    if (hit && fs.existsSync(hit.dir)) {
      logTaskResolveHit(hit);
      return hit;
    }
  }
  logTaskResolveMiss(id);
  return null;
}

function firstNonEmptyLine(text) {
  const lines = String(text || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  return lines.length ? lines[0] : "";
}

function taskUpdatedTs(summary, taskDir) {
  const events = Array.isArray(summary?.state_events) ? summary.state_events : [];
  if (events.length) {
    const last = events[events.length - 1];
    if (Number.isFinite(last?.ts)) return last.ts;
  }
  try {
    const st = fs.statSync(path.join(taskDir, "summary.json"));
    return st.mtimeMs;
  } catch {
    return Date.now();
  }
}

function taskLastPreview(taskDir, summary) {
  const rounds = Array.isArray(summary?.rounds) ? summary.rounds : [];
  const roundNums = rounds
    .map((r) => r?.round)
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => b - a);

  for (const round of roundNums) {
    const roundDir = path.join(taskDir, "rounds", String(round).padStart(2, "0"));
    const candidates = ["tester_raw.md", "reviewer_raw.md", "coder_output.md"];
    for (const name of candidates) {
      const p = path.join(roundDir, name);
      if (!fs.existsSync(p)) continue;
      const line = firstNonEmptyLine(fs.readFileSync(p, "utf8"));
      if (line) return line;
    }
  }
  return "";
}

function taskPromptPreview(taskDir, maxLen = 28) {
  const p = path.join(taskDir, "task.md");
  if (!fs.existsSync(p)) return "";
  const first = firstNonEmptyLine(fs.readFileSync(p, "utf8"));
  if (!first) return "";
  return first.length > maxLen ? `${first.slice(0, maxLen)}...` : first;
}

function toneFromOutcome(outcome) {
  const s = String(outcome || "").toLowerCase();
  if (!s) return "neutral";
  if (s.includes("approved") || s.includes("pass") || s.includes("success")) return "positive";
  if (s.includes("max_iterations") || s.includes("changes_requested")) return "warning";
  if (s.includes("failed") || s.includes("invalid") || s.includes("error") || s.includes("schema")) {
    return "negative";
  }
  return "neutral";
}

function mapThreadsById(threads) {
  const map = new Map();
  for (const thread of Array.isArray(threads) ? threads : []) {
    const threadId = String(thread?.thread_id || "").trim();
    if (!threadId) continue;
    map.set(threadId, thread);
  }
  return map;
}

function listTasks(threadById = null) {
  const threadLookup = threadById instanceof Map ? threadById : mapThreadsById(listThreads(LOGS_ROOT));
  return getTaskResolveIndex().entries
    .map((t) => {
      const summary = t.summary || safeReadJson(path.join(t.dir, "summary.json"));
      if (!summary) return null;
      const unresolved = Array.isArray(summary.unresolved_must_fix) ? summary.unresolved_must_fix : [];
      const tone = toneFromOutcome(summary.final_outcome);
      const preview = taskLastPreview(t.dir, summary);
      const updatedTs = Number.isFinite(t.updated_ts) ? t.updated_ts : taskUpdatedTs(summary, t.dir);
      const rawThreadId = clip(summary.thread_id || t.thread_id || "", 64) || null;
      const threadId = rawThreadId && threadLookup.has(rawThreadId) ? rawThreadId : null;
      const threadMeta = threadId ? threadLookup.get(threadId) : null;
      const projectId = threadId || (clip(summary.project_id || summary.project || "", 64) || null);
      const projectName = threadMeta
        ? (clip(threadMeta.name || summary.project_name || summary.workspace_name || "", 96) || threadMeta.name || null)
        : null;
      const alertCount =
        unresolved.length +
        (tone === "negative" ? 1 : 0) +
        ((summary.final_outcome || "") === "max_iterations_reached" ? 1 : 0);
      const date = t.date || new Date(updatedTs || Date.now()).toISOString().slice(0, 10);
      return {
        task_id: summary.task_id || t.taskId,
        project_id: projectId,
        thread_id: threadId,
        project_name: projectName,
        date,
        provider: summary.provider || "unknown",
        final_status: summary.final_status || null,
        final_outcome: summary.final_outcome || null,
        task_title: taskPromptPreview(t.dir),
        rounds: Array.isArray(summary.rounds) ? summary.rounds.length : 0,
        unresolved_must_fix: unresolved.length,
        status_tone: tone,
        updated_ts: updatedTs,
        last_preview: preview,
        alert_count: alertCount,
        task_dir: t.dir,
        task_path: taskRelativePath(t.dir),
        task_source: t.source,
        timeline_file: summary.timeline_file || path.join(t.dir, "task-timeline.json"),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const ts = (b.updated_ts || 0) - (a.updated_ts || 0);
      if (ts !== 0) return ts;
      return String(a.task_id || "").localeCompare(String(b.task_id || ""));
    });
}

function dedupeTasksByLatest(tasks) {
  const deduped = new Map();
  for (const item of Array.isArray(tasks) ? tasks : []) {
    const id = String(item?.task_id || "").trim();
    if (!id) continue;
    const prev = deduped.get(id);
    if (!prev || (Number(item.updated_ts) || 0) > (Number(prev.updated_ts) || 0)) {
      deduped.set(id, item);
    }
  }
  return Array.from(deduped.values()).sort((a, b) => {
    const ts = (Number(b.updated_ts) || 0) - (Number(a.updated_ts) || 0);
    if (ts !== 0) return ts;
    return String(a.task_id || "").localeCompare(String(b.task_id || ""));
  });
}

function buildVisibleTaskCatalog(opts = {}) {
  const includeLegacyPreview = opts.includeLegacyPreview !== false;
  const threads = listThreads(LOGS_ROOT);
  const threadById = mapThreadsById(threads);
  const tasks = listTasks(threadById);
  const seenTaskIds = new Set(
    tasks
      .map((t) => String(t?.task_id || "").trim())
      .filter(Boolean)
  );

  // Include legacy chat sessions; keep unbound sessions unassigned instead of forcing them into default thread.
  const legacySessions = listChatSessions(LOGS_ROOT);
  for (const session of legacySessions) {
    const taskId = String(session?.thread_id || "").trim();
    if (!taskId || seenTaskIds.has(taskId)) continue;
    const rawThreadId = clip(session.parent_thread || session.project_id || "", 64) || null;
    const threadId = rawThreadId && threadById.has(rawThreadId) ? rawThreadId : null;
    const threadMeta = threadId ? threadById.get(threadId) : null;
    let title = session.title || "聊天对话";
    let preview = "";
    let updatedTs = Number(session.updated_at || session.created_at || Date.now()) || Date.now();
    if (includeLegacyPreview) {
      const msgs = readMessages(LOGS_ROOT, taskId);
      const lastMsg = msgs[msgs.length - 1];
      const firstUserMsg = msgs.find((m) => m.sender_type === "user");
      title = session.title || (firstUserMsg ? String(firstUserMsg.text || "").slice(0, 28) : "聊天对话");
      preview = lastMsg ? String(lastMsg.text || "").slice(0, 56) : "";
      updatedTs = Number(lastMsg?.ts || session.updated_at || session.created_at || Date.now()) || Date.now();
    }
    tasks.push({
      task_id: taskId,
      project_id: threadId || null,
      thread_id: threadId,
      project_name: threadMeta?.name || null,
      date: new Date(session.created_at || Date.now()).toISOString().slice(0, 10),
      provider: "chat",
      final_status: null,
      final_outcome: null,
      task_title: title.length > 28 ? `${title.slice(0, 28)}...` : title,
      rounds: 0,
      unresolved_must_fix: 0,
      status_tone: "neutral",
      updated_ts: updatedTs,
      last_preview: preview,
      alert_count: 0,
      _is_thread: true,
      _thread_id: taskId,
      _thread_mode: session.mode || "free_chat",
      task_source: threadId ? "legacy_thread_chat" : "legacy_unassigned_chat",
    });
    seenTaskIds.add(taskId);
  }

  // Include thread-scoped sessions (chat + task) not already present in task logs.
  for (const thread of threads) {
    const threadSessions = listSessions(LOGS_ROOT, thread.thread_id);
    for (const sess of threadSessions) {
      const sessionId = String(sess?.session_id || "").trim();
      if (!sessionId || seenTaskIds.has(sessionId)) continue;
      tasks.push({
        task_id: sessionId,
        project_id: thread.thread_id,
        thread_id: thread.thread_id,
        project_name: thread.name || DEFAULT_PROJECT_NAME,
        date: new Date(sess.created_at || Date.now()).toISOString().slice(0, 10),
        provider: sess.type === "task" ? "workflow" : "chat",
        final_status: sess.final_status || null,
        final_outcome: sess.final_outcome || null,
        task_title: (sess.title || "").length > 28 ? `${sess.title.slice(0, 28)}...` : (sess.title || "未命名"),
        rounds: sess.rounds || 0,
        unresolved_must_fix: 0,
        status_tone: sess.type === "task" ? toneFromOutcome(sess.final_outcome) : "neutral",
        updated_ts: sess.updated_at || sess.created_at || Date.now(),
        last_preview: "",
        alert_count: 0,
        _is_thread: sess.type === "chat",
        _thread_id: sessionId,
        _thread_mode: sess.mode || "free_chat",
        task_source: `thread_${sess.type || "session"}`,
      });
      seenTaskIds.add(sessionId);
    }
  }

  return {
    threads,
    tasks: dedupeTasksByLatest(tasks),
  };
}

function filterTasksByThread(tasks, threadId) {
  const filterThreadId = String(threadId || "").trim();
  if (!filterThreadId) return Array.isArray(tasks) ? tasks : [];
  return (Array.isArray(tasks) ? tasks : []).filter((t) => String(t?.thread_id || "") === filterThreadId);
}

function buildThreadVisibleMetrics(threads, tasks) {
  const byThreadId = new Map();
  for (const thread of Array.isArray(threads) ? threads : []) {
    const threadId = String(thread?.thread_id || "").trim();
    if (!threadId) continue;
    byThreadId.set(threadId, {
      visible_count: 0,
      breakdown: {
        scoped: 0,
        legacy: 0,
      },
    });
  }
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const threadId = String(task?.thread_id || "").trim();
    if (!threadId) continue;
    const metric = byThreadId.get(threadId);
    if (!metric) continue;
    metric.visible_count += 1;
    if (String(task?.task_source || "").startsWith("legacy")) {
      metric.breakdown.legacy += 1;
    } else {
      metric.breakdown.scoped += 1;
    }
  }
  return byThreadId;
}

function getTaskDirById(taskId) {
  const resolved = resolveTaskById(taskId);
  return resolved ? resolved.dir : null;
}

function getTaskDetail(taskId) {
  const resolved = resolveTaskById(taskId);
  if (!resolved) return null;
  const taskDir = resolved.dir;
  const summary = safeReadJson(path.join(taskDir, "summary.json"));
  const timeline = safeReadJson(path.join(taskDir, "task-timeline.json"));
  const taskMd = fs.existsSync(path.join(taskDir, "task.md"))
    ? fs.readFileSync(path.join(taskDir, "task.md"), "utf8")
    : "";

  return {
    task_id: taskId,
    task_dir: taskDir,
    task_path: taskRelativePath(taskDir),
    task_source: resolved.source,
    task_md: taskMd,
    summary,
    timeline,
  };
}

function verifyTaskDeleteDir(taskId, taskDir) {
  const expectedBase = `task-${taskId}`;
  if (path.basename(taskDir) !== expectedBase) {
    return { ok: false, status: 403, error: "仅允许删除 task-<id> 目录" };
  }

  try {
    const st = fs.lstatSync(taskDir);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      return { ok: false, status: 403, error: "仅允许删除真实任务目录" };
    }
  } catch {
    return { ok: false, status: 404, error: "task not found" };
  }

  let realLogsRoot;
  let realTaskDir;
  try {
    realLogsRoot = fs.realpathSync(LOGS_ROOT);
    realTaskDir = fs.realpathSync(taskDir);
  } catch {
    return { ok: false, status: 404, error: "task not found" };
  }
  if (!realTaskDir.startsWith(realLogsRoot + path.sep)) {
    return { ok: false, status: 403, error: "禁止删除任务根目录外的文件" };
  }
  if (path.basename(realTaskDir) !== expectedBase) {
    return { ok: false, status: 403, error: "目录解析不安全，拒绝删除" };
  }
  return { ok: true, real_task_dir: realTaskDir };
}

function resolveChatSessionDirForDelete(sessionId, hintedThreadId = null) {
  const sid = String(sessionId || "").trim();
  if (!sid) return null;

  const hinted = String(hintedThreadId || "").trim();
  if (hinted) {
    const scoped = path.join(LOGS_ROOT, "threads", hinted, "sessions", sid);
    if (fs.existsSync(scoped)) return scoped;
  }

  const locatedThread = locateSessionThread(sid, hinted || null);
  if (locatedThread) {
    const scoped = path.join(LOGS_ROOT, "threads", locatedThread, "sessions", sid);
    if (fs.existsSync(scoped)) return scoped;
  }

  const legacyDir = path.join(LOGS_ROOT, "threads", sid);
  const legacyMeta = path.join(legacyDir, "meta.json");
  if (fs.existsSync(legacyMeta)) return legacyDir;

  return null;
}

function verifyChatSessionDeleteDir(sessionId, sessionDir) {
  const expectedBase = String(sessionId || "").trim();
  if (!expectedBase || path.basename(sessionDir) !== expectedBase) {
    return { ok: false, status: 403, error: "仅允许删除会话目录" };
  }

  try {
    const st = fs.lstatSync(sessionDir);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      return { ok: false, status: 403, error: "仅允许删除真实会话目录" };
    }
  } catch {
    return { ok: false, status: 404, error: "session not found" };
  }

  let realLogsRoot;
  let realSessionDir;
  try {
    realLogsRoot = fs.realpathSync(LOGS_ROOT);
    realSessionDir = fs.realpathSync(sessionDir);
  } catch {
    return { ok: false, status: 404, error: "session not found" };
  }

  const realThreadsRoot = path.join(realLogsRoot, "threads");
  if (!realSessionDir.startsWith(realThreadsRoot + path.sep)) {
    return { ok: false, status: 403, error: "禁止删除任务根目录外的文件" };
  }
  if (path.basename(realSessionDir) !== expectedBase) {
    return { ok: false, status: 403, error: "目录解析不安全，拒绝删除" };
  }

  const rel = path.relative(realThreadsRoot, realSessionDir);
  const parts = rel.split(path.sep).filter(Boolean);
  const isLegacy = parts.length === 1 && parts[0] === expectedBase;
  const isScoped = parts.length === 3 && parts[1] === "sessions" && parts[2] === expectedBase;
  if (!isLegacy && !isScoped) {
    return { ok: false, status: 403, error: "会话目录不在允许路径中" };
  }
  return { ok: true, real_session_dir: realSessionDir };
}

function readRoundFiles(taskDir, round) {
  const roundName = String(round).padStart(2, "0");
  const roundDir = path.join(taskDir, "rounds", roundName);
  if (!fs.existsSync(roundDir)) return null;

  function safeText(name) {
    const p = path.join(roundDir, name);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
  }

  return {
    round,
    coder_output: safeText("coder_output.md"),
    reviewer_raw: safeText("reviewer_raw.md"),
    reviewer: safeReadJson(path.join(roundDir, "reviewer.json")),
    reviewer_meta: safeReadJson(path.join(roundDir, "reviewer_meta.json")),
    tester_raw: safeText("tester_raw.md"),
    tester: safeReadJson(path.join(roundDir, "tester.json")),
    tester_meta: safeReadJson(path.join(roundDir, "tester_meta.json")),
    test_results: safeReadJson(path.join(roundDir, "test-results.json")),
    test_results_text: safeText("test-results.txt"),
  };
}

function evidencePath(taskDir, round, role, kind) {
  const roundDir = path.join(taskDir, "rounds", String(round).padStart(2, "0"));
  const maps = {
    coder: {
      output: "coder_output.md",
      events: "coder.events.jsonl",
      raw: "coder.raw.ndjson",
      run: "coder_run.json",
    },
    reviewer: {
      output: "reviewer_raw.md",
      json: "reviewer.json",
      meta: "reviewer_meta.json",
      events: "reviewer.events.jsonl",
      raw: "reviewer.raw.ndjson",
    },
    tester: {
      output: "tester_raw.md",
      json: "tester.json",
      meta: "tester_meta.json",
      events: "tester.events.jsonl",
      raw: "tester.raw.ndjson",
      tests: "test-results.txt",
      tests_json: "test-results.json",
    },
  };

  const byRole = maps[role];
  if (!byRole) return null;
  const file = byRole[kind];
  if (!file) return null;
  return path.join(roundDir, file);
}

function readEvidence(taskDir, round, role, kind) {
  const filePath = evidencePath(taskDir, round, role, kind);
  if (!filePath || !fs.existsSync(filePath)) return null;
  const ext = path.extname(filePath);
  if (ext === ".json") {
    const parsed = safeReadJson(filePath);
    return {
      kind,
      role,
      round,
      file: path.basename(filePath),
      content_type: "application/json",
      content: parsed ? JSON.stringify(parsed, null, 2) : "{}",
    };
  }
  return {
    kind,
    role,
    round,
    file: path.basename(filePath),
    content_type: "text/plain",
    content: fs.readFileSync(filePath, "utf8"),
  };
}

function detectModelFromEvents(events) {
  const usageEvt = events.find((e) => e?.type === "run.usage");
  if (usageEvt?.data?.model) return usageEvt.data.model;
  if (usageEvt?.data?.modelUsage && typeof usageEvt.data.modelUsage === "object") {
    const keys = Object.keys(usageEvt.data.modelUsage);
    if (keys.length) return keys[0];
  }

  const providerEvt = events.find(
    (e) => e?.type === "provider.ndjson" && e?.data?.obj?.type === "system"
  );
  if (providerEvt?.data?.obj?.model) return providerEvt.data.obj.model;

  const stderrModel = events.find(
    (e) => e?.type === "run.stderr.line" && /^model:\s*/i.test(String(e?.data?.line || ""))
  );
  if (stderrModel?.data?.line) return String(stderrModel.data.line).replace(/^model:\s*/i, "").trim();

  return null;
}

function summarizeRunFromEvents(events) {
  if (!events.length) {
    return {
      ts: null,
      provider: null,
      model: null,
      cost_usd: null,
      duration_ms: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      exit_code: null,
      ok: null,
    };
  }

  const started = events.find((e) => e?.type === "run.started");
  const assistant = events.find((e) => e?.type === "assistant.text");
  const usage = [...events].reverse().find((e) => e?.type === "run.usage");
  const completed = [...events].reverse().find((e) => e?.type === "run.completed");
  const failed = [...events].reverse().find((e) => e?.type === "run.failed");
  const anyMeta = events.find((e) => e?.meta) || {};

  const ts = assistant?.ts || completed?.ts || started?.ts || null;
  const exitCode = Number.isFinite(completed?.data?.code) ? completed.data.code : null;
  const ok = failed ? false : exitCode === null ? null : exitCode === 0;
  const usageDuration = usage?.data?.duration_ms;
  const fallbackDuration = (
    Number.isFinite(started?.ts) && Number.isFinite(completed?.ts)
      ? Math.max(0, Number(completed.ts) - Number(started.ts))
      : null
  );

  return {
    ts,
    provider: anyMeta?.meta?.provider || null,
    model: detectModelFromEvents(events),
    cost_usd: usage?.data?.total_cost_usd ?? null,
    duration_ms: Number.isFinite(usageDuration) ? Number(usageDuration) : fallbackDuration,
    input_tokens: usage?.data?.usage?.input_tokens ?? null,
    output_tokens: usage?.data?.usage?.output_tokens ?? null,
    cache_read_input_tokens: usage?.data?.usage?.cache_read_input_tokens ?? null,
    exit_code: exitCode,
    ok,
  };
}

function safeTextOrEmpty(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

function followupsFile(taskDir) {
  return path.join(taskDir, "task-followups.jsonl");
}

function appendFollowup(taskDir, text, messageId = null) {
  const trimmedId = String(messageId || "").trim();
  const line = {
    id: trimmedId || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    ts: Date.now(),
    text: String(text || "").trim(),
  };
  if (!line.text) return null;
  fs.appendFileSync(followupsFile(taskDir), JSON.stringify(line) + "\n", "utf8");
  return line;
}

function readFollowups(taskDir) {
  return readJsonLines(followupsFile(taskDir))
    .filter((x) => x && typeof x.text === "string" && x.text.trim())
    .map((x) => ({
      id: String(x.id || `${x.ts || Date.now()}`),
      ts: Number.isFinite(x.ts) ? x.ts : Date.now(),
      text: String(x.text).trim(),
    }));
}

function normalizeControlText(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000`'"~!@#$%^&*()_\-+=[\]{}|;:,.<>/?，。！？、；：（）【】「」《》“”‘’]/g, "");
}

function isPureConfirmControlMessage(text) {
  const normalized = normalizeControlText(text);
  if (!normalized) return false;
  return [
    "确认",
    "确认实施",
    "确认开始实施",
    "确认按方案实施",
    "按方案实施",
    "开始实施",
    "同意实施",
    "继续实施",
    "confirm",
    "approve",
    "go",
    "ship",
  ].includes(normalized);
}

function buildThreadPrompt(taskDir, opts = {}) {
  const executionMode = opts.executionMode === "implementation" ? "implementation" : "proposal";
  const baseTask = safeTextOrEmpty(path.join(taskDir, "task.md")).trim();
  const followupsRaw = readFollowups(taskDir);
  const followups =
    executionMode === "implementation"
      ? followupsRaw.filter((m) => !isPureConfirmControlMessage(m.text))
      : followupsRaw;
  if (!followups.length) return baseTask;

  const lines = [];
  lines.push(baseTask || "");
  lines.push("");
  lines.push("Follow-up messages from operator (chronological):");
  followups.forEach((m, idx) => {
    lines.push(`${idx + 1}. ${m.text}`);
  });
  lines.push("");
  if (executionMode === "implementation") {
    lines.push("Implementation is confirmed by operator.");
    lines.push("Execute concrete code changes in repository; do not only reply with confirmation or plan text.");
    lines.push("Use follow-ups as context and implement the agreed plan.");
  } else {
    lines.push("Please respond to the latest follow-up while respecting prior context.");
  }
  return lines.join("\n").trim();
}

function roleMessageContent(roundDir, role) {
  if (role === "coder") {
    return safeTextOrEmpty(path.join(roundDir, "coder_output.md"));
  }
  if (role === "reviewer") {
    const raw = safeTextOrEmpty(path.join(roundDir, "reviewer_raw.md"));
    if (raw.trim()) return raw;
    const json = safeReadJson(path.join(roundDir, "reviewer.json"));
    return json ? JSON.stringify(json, null, 2) : "";
  }
  if (role === "tester") {
    const raw = safeTextOrEmpty(path.join(roundDir, "tester_raw.md"));
    if (raw.trim()) return raw;
    const json = safeReadJson(path.join(roundDir, "tester.json"));
    return json ? JSON.stringify(json, null, 2) : "";
  }
  return "";
}

function firstRunFailedMessage(events) {
  const failed = events.find((e) => e?.type === "run.failed");
  const msg = failed?.data?.message;
  return typeof msg === "string" && msg.trim() ? msg.trim() : "";
}

function stageRoleLabel(roleConfig, stage) {
  const fallback = stage.charAt(0).toUpperCase() + stage.slice(1);
  const profile = roleConfig?.role_profiles?.[stage] || {};
  const displayName = clip(profile.display_name || fallback);
  const roleTitle = clip(profile.role_title || fallback);
  return {
    display_name: displayName,
    role_title: roleTitle,
    role_label: `${displayName} · ${roleTitle}`,
  };
}

function roundNumbersFromSummary(summary) {
  const rounds = Array.isArray(summary?.rounds) ? summary.rounds : [];
  return rounds
    .map((r) => r?.round)
    .filter((n) => Number.isFinite(n) && n > 0);
}

function roundNumbersFromDir(taskDir) {
  const root = path.join(taskDir, "rounds");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((d) => Number(d.name))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function mergedRoundNumbers(taskDir, summary) {
  const set = new Set([...roundNumbersFromSummary(summary), ...roundNumbersFromDir(taskDir)]);
  return Array.from(set).sort((a, b) => a - b);
}

function readLiveTransitions(taskDir, timelineObj) {
  if (Array.isArray(timelineObj?.transitions) && timelineObj.transitions.length) {
    return timelineObj.transitions;
  }
  const taskEvents = readJsonLines(path.join(taskDir, "task-events.jsonl"));
  return taskEvents
    .filter((e) => e?.type === "fsm.transition")
    .map((e, idx) => ({
      index: idx,
      ts: e.ts,
      from: e.from ?? null,
      to: e.to ?? null,
      label: String(e.to || "-"),
      reason: e.reason ?? null,
      round: Number.isFinite(e.round) ? e.round : null,
      duration_ms: null,
    }));
}

function computeProgress(summary, timeline) {
  const rounds = Array.isArray(summary?.rounds) ? summary.rounds : [];
  const threadRounds = rounds.length;
  const latestMax = Number.isFinite(summary?.max_iterations) ? Number(summary.max_iterations) : null;
  const transitions = Array.isArray(timeline?.transitions) ? timeline.transitions : [];

  let lastIntakeIdx = -1;
  for (let i = transitions.length - 1; i >= 0; i -= 1) {
    const t = transitions[i];
    if (t?.to === "intake") {
      lastIntakeIdx = i;
      break;
    }
  }
  const seg = lastIntakeIdx >= 0 ? transitions.slice(lastIntakeIdx) : transitions;
  const latestRoundSet = new Set(
    seg.map((x) => x?.round).filter((n) => Number.isFinite(n) && n > 0)
  );

  return {
    rounds_total: threadRounds,
    rounds_max: latestMax,
    thread_rounds: threadRounds,
    latest_run_rounds: latestRoundSet.size,
    latest_run_max: latestMax,
  };
}

function buildTaskMessages(taskId, taskDir) {
  const summary = safeReadJson(path.join(taskDir, "summary.json")) || {};
  const timeline = safeReadJson(path.join(taskDir, "task-timeline.json")) || {};
  const transitions = readLiveTransitions(taskDir, timeline);
  const taskText = safeTextOrEmpty(path.join(taskDir, "task.md")).trim();
  const followups = readFollowups(taskDir);
  const roundNumbers = mergedRoundNumbers(taskDir, summary);
  const roleConfig = normalizeRoleConfig(summary.role_config || readRoleConfig());
  const messages = [];

  if (taskText) {
    messages.push({
      id: `${taskId}-task`,
      role: "task",
      role_label: "铲屎官",
      round: null,
      text: taskText,
      ts: transitions[0]?.ts || Date.now(),
      provider: null,
      model: null,
      cost_usd: null,
      duration_ms: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      exit_code: null,
      ok: true,
    });
  }

  followups.forEach((m, idx) => {
    messages.push({
      id: `${taskId}-followup-${m.id || idx}`,
      role: "task",
      role_label: "铲屎官",
      round: null,
      text: m.text,
      ts: m.ts,
      provider: null,
      model: null,
      cost_usd: null,
      duration_ms: null,
      input_tokens: null,
      output_tokens: null,
      cache_read_input_tokens: null,
      exit_code: null,
      ok: true,
    });
  });

  for (const round of roundNumbers) {
    const roundName = String(round).padStart(2, "0");
    const roundDir = path.join(taskDir, "rounds", roundName);
    if (!fs.existsSync(roundDir)) continue;

    for (const role of STAGES) {
      const text = roleMessageContent(roundDir, role);
      const events = readJsonLines(path.join(roundDir, `${role}.events.jsonl`));
      const meta = summarizeRunFromEvents(events);
      if (!text.trim() && !events.length) continue;
      const failedMsg = firstRunFailedMessage(events);
      const textOut = text.trim() ? text : failedMsg ? `Runtime Error: ${failedMsg}` : text;
      const roleName = stageRoleLabel(roleConfig, role);
      messages.push({
        id: `${taskId}-${round}-${role}`,
        role,
        role_label: roleName.role_label,
        role_display_name: roleName.display_name,
        role_title: roleName.role_title,
        round,
        text: textOut || "",
        ts: meta.ts,
        provider: meta.provider,
        model: meta.model,
        cost_usd: meta.cost_usd,
        duration_ms: meta.duration_ms,
        input_tokens: meta.input_tokens,
        output_tokens: meta.output_tokens,
        cache_read_input_tokens: meta.cache_read_input_tokens,
        exit_code: meta.exit_code,
        ok: meta.ok,
      });
    }
  }

  messages.sort((a, b) => {
    const ta = Number.isFinite(a.ts) ? a.ts : 0;
    const tb = Number.isFinite(b.ts) ? b.ts : 0;
    if (ta !== tb) return ta - tb;
    const ra = Number.isFinite(a.round) ? a.round : -1;
    const rb = Number.isFinite(b.round) ? b.round : -1;
    if (ra !== rb) return ra - rb;
    return String(a.role).localeCompare(String(b.role));
  });

  const latestTestText = (() => {
    for (let i = roundNumbers.length - 1; i >= 0; i -= 1) {
      const p = path.join(taskDir, "rounds", String(roundNumbers[i]).padStart(2, "0"), "test-results.txt");
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    }
    return "";
  })();

  return {
    task_id: taskId,
    final_status: summary.final_status || null,
    final_outcome: summary.final_outcome || null,
    current_stage: transitions.length
      ? transitions[transitions.length - 1].to
      : null,
    progress: computeProgress(
      { ...summary, rounds: roundNumbers.map((n) => ({ round: n })) },
      { transitions }
    ),
    messages,
    latest_test_results: latestTestText,
    unresolved_must_fix: Array.isArray(summary.unresolved_must_fix) ? summary.unresolved_must_fix : [],
    role_config: roleConfig,
  };
}

function buildThreadSummary(threadId, threadMeta) {
  return {
    task_id: threadId,
    final_status: threadMeta?.mode || null,
    final_outcome: null,
    provider: "chat",
    rounds: [],
    state_events: [],
  };
}

function convertThreadMessage(m) {
  const isUser = m?.sender_type === "user";
  const out = {
    id: m?.id,
    role: isUser ? "task" : "chat",
    role_label: isUser ? "铲屎官" : (m?.sender || m?.cat_name || "猫猫"),
    round: null,
    ts: m?.ts || Date.now(),
    text: m?.text || "",
    ok: null,
    cat_name: m?.cat_name || null,
    _is_chat: true,
  };
  if (m?.provider) out.provider = m.provider;
  if (m?.model) out.model = m.model;
  if (Number.isFinite(m?.input_tokens)) out.input_tokens = m.input_tokens;
  if (Number.isFinite(m?.output_tokens)) out.output_tokens = m.output_tokens;
  if (Number.isFinite(m?.cost_usd)) out.cost_usd = m.cost_usd;
  if (Number.isFinite(m?.duration_ms)) out.duration_ms = m.duration_ms;
  return out;
}

function buildThreadMessagesBundle(threadId) {
  const threadMeta = readThreadMeta(LOGS_ROOT, threadId) || {};
  const msgs = readMessages(LOGS_ROOT, threadId);
  const converted = msgs.map(convertThreadMessage);
  return {
    task_id: threadId,
    final_status: threadMeta?.mode || null,
    final_outcome: null,
    current_stage: threadMeta?.mode || null,
    progress: {
      rounds_total: 0,
      rounds_max: null,
      thread_rounds: 0,
      latest_run_rounds: 0,
      latest_run_max: null,
    },
    messages: converted,
    latest_test_results: "",
    unresolved_must_fix: [],
    _is_thread: true,
    _thread_id: threadId,
    _thread_mode: threadMeta?.mode || "free_chat",
  };
}

function buildTaskReportMarkdown(taskId, taskDir) {
  const summary = safeReadJson(path.join(taskDir, "summary.json")) || {};
  const timeline = safeReadJson(path.join(taskDir, "task-timeline.json")) || {};
  const messagesBundle = buildTaskMessages(taskId, taskDir);
  const taskText = safeTextOrEmpty(path.join(taskDir, "task.md")).trim();

  const lines = [];
  lines.push(`# Cat Cafe Task Report`);
  lines.push("");
  lines.push(`- Task ID: \`${taskId}\``);
  lines.push(`- Provider: ${summary.provider || "-"}`);
  lines.push(`- Final Status: ${summary.final_status || "-"}`);
  lines.push(`- Final Outcome: ${summary.final_outcome || "-"}`);
  lines.push(`- Max Iterations: ${summary.max_iterations || "-"}`);
  lines.push(`- Generated At: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Task");
  lines.push("");
  lines.push(taskText || "(empty)");
  lines.push("");

  const transitions = timeline?.transitions || [];
  lines.push("## State Timeline");
  lines.push("");
  if (!transitions.length) {
    lines.push("- (no transitions)");
  } else {
    transitions.forEach((t, idx) => {
      const ts = Number.isFinite(t.ts) ? new Date(t.ts).toISOString() : "-";
      lines.push(
        `${idx + 1}. \`${t.from || "-"} -> ${t.to}\` · round ${t.round ?? "-"} · ${t.reason || "-"} · ${ts}`
      );
    });
  }
  lines.push("");

  lines.push("## Messages");
  lines.push("");
  (messagesBundle.messages || []).forEach((m) => {
    lines.push(`### ${m.role_label} (round ${m.round ?? "-"})`);
    lines.push(`- Time: ${Number.isFinite(m.ts) ? new Date(m.ts).toISOString() : "-"}`);
    lines.push(`- Provider/Model: ${m.provider || "-"} / ${m.model || "-"}`);
    lines.push(
      `- Tokens: in ${m.input_tokens ?? 0} / out ${m.output_tokens ?? 0} / cache ${m.cache_read_input_tokens ?? 0}`
    );
    lines.push(`- Cost: ${Number.isFinite(m.cost_usd) ? `$${m.cost_usd.toFixed(6)}` : "-"}`);
    lines.push(`- Duration: ${m.duration_ms ?? "-"} ms`);
    lines.push("");
    lines.push("```text");
    lines.push(String(m.text || ""));
    lines.push("```");
    lines.push("");
  });

  lines.push("## Unresolved Must-Fix");
  lines.push("");
  const unresolved = Array.isArray(summary.unresolved_must_fix) ? summary.unresolved_must_fix : [];
  if (!unresolved.length) {
    lines.push("- None");
  } else {
    unresolved.forEach((x) => lines.push(`- ${x}`));
  }
  lines.push("");

  return lines.join("\n");
}

function buildThreadReportMarkdown(threadId) {
  const threadMeta = readThreadMeta(LOGS_ROOT, threadId) || {};
  const bundle = buildThreadMessagesBundle(threadId);
  const firstUserMsg = (bundle.messages || []).find((m) => m.role === "task");

  const lines = [];
  lines.push("# Cat Cafe Conversation Report");
  lines.push("");
  lines.push(`- Conversation ID: \`${threadId}\``);
  lines.push(`- Title: ${threadMeta.title || "-"}`);
  lines.push(`- Mode: ${threadMeta.mode || "-"}`);
  lines.push(
    `- Created At: ${Number.isFinite(threadMeta.created_at) ? new Date(threadMeta.created_at).toISOString() : "-"}`
  );
  lines.push(`- Generated At: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Opening Message");
  lines.push("");
  lines.push(firstUserMsg?.text || "(empty)");
  lines.push("");
  lines.push("## Messages");
  lines.push("");
  (bundle.messages || []).forEach((m) => {
    lines.push(`### ${m.role_label} (round ${m.round ?? "-"})`);
    lines.push(`- Time: ${Number.isFinite(m.ts) ? new Date(m.ts).toISOString() : "-"}`);
    lines.push(`- Provider/Model: ${m.provider || "-"} / ${m.model || "-"}`);
    lines.push(`- Duration: ${m.duration_ms ?? "-"} ms`);
    lines.push("");
    lines.push("```text");
    lines.push(String(m.text || ""));
    lines.push("```");
    lines.push("");
  });
  return lines.join("\n");
}

function serveStatic(reqPath, res) {
  const cleaned = reqPath === "/" ? "/index.html" : reqPath;
  const full = path.resolve(path.join(UI_ROOT, cleaned));
  if (!full.startsWith(UI_ROOT)) {
    sendText(res, 403, "forbidden");
    return;
  }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    sendText(res, 404, "not found");
    return;
  }

  const ext = path.extname(full);
  const type =
    ext === ".html"
      ? "text/html; charset=utf-8"
      : ext === ".css"
        ? "text/css; charset=utf-8"
        : ext === ".js"
          ? "application/javascript; charset=utf-8"
          : "application/octet-stream";
  sendText(res, 200, fs.readFileSync(full), type);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  const trace = createRequestTraceContext(req, p);
  bindRequestTrace(req, res, trace);

  try {
    // ---- Thread CRUD endpoints (Thread = project container) ----

    if (p === "/api/threads" && req.method === "GET") {
      const catalog = buildVisibleTaskCatalog({ includeLegacyPreview: false });
      const metrics = buildThreadVisibleMetrics(catalog.threads, catalog.tasks);
      const threads = catalog.threads.map((thread) => {
        const m = metrics.get(String(thread.thread_id || "").trim()) || {
          visible_count: 0,
          breakdown: { scoped: 0, legacy: 0 },
        };
        return {
          ...thread,
          visible_count: m.visible_count,
          breakdown: m.breakdown,
        };
      });
      return sendJson(res, 200, { threads, default_thread_id: DEFAULT_PROJECT_ID });
    }

    if (p === "/api/threads" && req.method === "POST") {
      const body = await readRequestJson(req);
      const slug = body.slug || body.project_id || body.name || "";
      const name = String(body.name || body.project_name || "").trim();
      const description = String(body.description || "").trim();
      if (!slug && !name) return sendJson(res, 400, { error: "slug or name is required" });
      const result = createThread(LOGS_ROOT, { slug: slug || name, name: name || slug, description });
      if (!result.ok) return sendJson(res, 409, { error: result.error });
      return sendJson(res, 201, { ok: true, thread: result.thread });
    }

    if (p.startsWith("/api/threads/") && req.method === "GET") {
      const seg = p.split("/").filter(Boolean);
      if (seg.length === 3) {
        const threadSlug = seg[2];
        // First try as Thread container
        const thread = readThread(LOGS_ROOT, threadSlug);
        if (thread) return sendJson(res, 200, { thread });
        // Fallback: try as chat session meta (backward compat)
        const sessionMeta = readThreadMeta(LOGS_ROOT, threadSlug);
        if (sessionMeta) return sendJson(res, 200, sessionMeta);
        return sendJson(res, 404, { error: "thread not found" });
      }
      if (seg.length === 4 && seg[3] === "sessions") {
        const threadSlug = seg[2];
        const thread = readThread(LOGS_ROOT, threadSlug);
        if (!thread) return sendJson(res, 404, { error: "thread not found" });
        const sessions = listSessions(LOGS_ROOT, threadSlug);
        // Also include legacy chat sessions that belong to this thread
        const legacyChatSessions = listChatSessions(LOGS_ROOT, threadSlug);
        const sessionIds = new Set(sessions.map((s) => s.session_id));
        for (const cs of legacyChatSessions) {
          if (!sessionIds.has(cs.thread_id)) {
            sessions.push({
              session_id: cs.thread_id,
              thread_id: threadSlug,
              type: "chat",
              title: cs.title || "聊天对话",
              mode: cs.mode || "free_chat",
              created_at: cs.created_at || 0,
              updated_at: cs.updated_at || cs.created_at || 0,
            });
          }
        }
        sessions.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
        return sendJson(res, 200, { thread_id: threadSlug, sessions });
      }
      if (seg.length === 4 && seg[3] === "messages") {
        const sessionId = seg[2];
        const messages = readMessages(LOGS_ROOT, sessionId);
        return sendJson(res, 200, { thread_id: sessionId, messages });
      }
    }

    if (p.startsWith("/api/threads/") && req.method === "POST") {
      const seg = p.split("/").filter(Boolean);
      // POST /api/threads/:id/sessions — create a chat session under a thread
      if (seg.length === 4 && seg[3] === "sessions") {
        const threadSlug = seg[2];
        const threadGuard = assertThreadId(
          { thread_slug: threadSlug },
          { source: "POST /api/threads/:id/sessions", allowFallback: false, mode: "container" }
        );
        if (!threadGuard.ok) {
          return sendJson(res, threadGuard.status || 400, {
            error: threadGuard.error,
            fallback: threadGuard.fallback || undefined,
          });
        }
        const body = await readRequestJson(req);
        const title = String(body.title || "").trim() || "新对话";
        const mode = body.mode || undefined;
        const roleConfig = readRoleConfig();
        const meta = createChatSession(LOGS_ROOT, title, mode, roleConfig, threadGuard.threadId);
        safeTouchThreadActivity(threadGuard.threadId, "create_thread_session");
        return sendJson(res, 200, { ok: true, session: meta, thread_id: threadGuard.threadId });
      }
    }

    if (p.startsWith("/api/threads/") && req.method === "PATCH") {
      const seg = p.split("/").filter(Boolean);
      if (seg.length === 3) {
        const threadSlug = seg[2];
        const body = await readRequestJson(req);
        // Try as Thread container first
        const thread = readThread(LOGS_ROOT, threadSlug);
        if (thread) {
          if (body.archived === true && !thread.archived) {
            const operator = String(body.operator || "").trim();
            const reason = String(body.reason || "").trim();
            const result = archiveThread(LOGS_ROOT, threadSlug, { operator, reason });
            if (!result.ok) {
              const status = result.code === "MISSING_AUDIT" ? 422 : 400;
              return sendJson(res, status, { error: result.error, code: result.code || undefined });
            }
            return sendJson(res, 200, { ok: true, thread: result.thread });
          }
          const patch = { ...body };
          delete patch.operator;
          delete patch.reason;
          const result = updateThread(LOGS_ROOT, threadSlug, patch);
          if (!result.ok) return sendJson(res, 400, { error: result.error, code: result.code || undefined });
          return sendJson(res, 200, { ok: true, thread: result.thread });
        }
        // Fallback: try as chat session meta
        const updated = updateThreadMeta(LOGS_ROOT, threadSlug, body);
        if (!updated) return sendJson(res, 404, { error: "thread not found" });
        return sendJson(res, 200, { ok: true, thread: updated });
      }
    }

    if (p.startsWith("/api/threads/") && req.method === "DELETE") {
      const seg = p.split("/").filter(Boolean);
      if (seg.length === 3) {
        const threadSlug = seg[2];
        if (threadSlug === DEFAULT_PROJECT_ID) {
          return sendJson(res, 400, { error: "无法删除默认 Thread" });
        }
        const thread = readThread(LOGS_ROOT, threadSlug);
        if (!thread) return sendJson(res, 404, { error: "thread not found" });
        const body = await readRequestJson(req);
        const operator = String(body.operator || "").trim();
        const reason = String(body.reason || "").trim();
        const result = deleteThread(LOGS_ROOT, threadSlug, { operator, reason });
        if (!result.ok) {
          let status = 400;
          if (result.code === "THREAD_NOT_ARCHIVED") status = 409;
          if (result.code === "MISSING_AUDIT") status = 422;
          if (result.code === "THREAD_NOT_FOUND") status = 404;
          return sendJson(res, status, { error: result.error, code: result.code || undefined });
        }
        return sendJson(res, 200, { ok: true });
      }
    }

    if (p === "/api/chat/cancel" && req.method === "POST") {
      const body = await readRequestJson(req);
      const threadId = String(body.thread_id || "").trim();
      if (!threadId) {
        // Cancel all active chat runs
        let count = 0;
        for (const [, run] of ACTIVE_CHAT_RUNS) {
          run.controller.abort();
          count++;
        }
        return sendJson(res, 200, { ok: true, canceled: count > 0, count, message: count ? "已发送终止信号。" : "没有可取消的聊天。" });
      }
      const running = ACTIVE_CHAT_RUNS.get(threadId);
      if (!running) {
        return sendJson(res, 200, { ok: true, canceled: false, message: "没有可取消的聊天。" });
      }
      running.controller.abort();
      return sendJson(res, 200, { ok: true, canceled: true, message: "已发送终止信号。" });
    }

    if (p === "/api/chat" && req.method === "POST") {
      const body = await readRequestJson(req);
      const message = String(body.message || "").trim();
      if (!message) return sendJson(res, 400, { error: "message is required" });

      let threadId = body.thread_id ? String(body.thread_id).trim() : null;
      let threadMode = body.mode || null;
      const threadGuard = assertThreadId(body, {
        source: "POST /api/chat",
        mode: "chat",
        sessionId: threadId || null,
        hintedThreadId: body.thread_slug || body.project_id || null,
      });
      if (!threadGuard.ok) {
        return sendJson(res, threadGuard.status || 400, {
          error: threadGuard.error,
          fallback: threadGuard.fallback || undefined,
        });
      }
      const threadSlug = threadGuard.threadId;

      if (threadId) {
        const inferred = locateSessionThread(threadId, threadSlug);
        if (inferred && inferred !== threadSlug) {
          return sendJson(res, 409, {
            error: `session ${threadId} belongs to thread ${inferred}, not ${threadSlug}`,
          });
        }
      }
      if (!threadId) {
        const preview = message.length > 20 ? message.slice(0, 20) + "..." : message;
        const mode = body.mode || undefined;
        const roleConfig = body.role_config
          ? normalizeRoleConfig(body.role_config)
          : readRoleConfig();
        const meta = createChatSession(LOGS_ROOT, preview, mode, roleConfig, threadSlug);
        threadId = meta.thread_id;
        threadMode = meta.mode || threadMode;
        safeTouchThreadActivity(threadSlug, "chat_post");
      } else if (!threadMode) {
        threadMode = readThreadMeta(LOGS_ROOT, threadId, threadSlug)?.mode
          || readThreadMeta(LOGS_ROOT, threadId)?.mode
          || null;
      }

      const roleConfig = body.role_config
        ? normalizeRoleConfig(body.role_config)
        : readRoleConfig();
      const liveHooks = createLiveHooks(threadId, {
        mode: threadMode || "free_chat",
        roleConfig,
        current_stage: threadMode || "chat",
      });
      ensureLiveSession(threadId, {
        mode: threadMode || "free_chat",
        roleConfig,
        running: true,
        current_stage: threadMode || "chat",
      });

      const controller = new AbortController();
      ACTIVE_CHAT_RUNS.set(threadId, { controller, started_at: Date.now() });
      let result;
      let runFailed = null;
      try {
        result = await sendChatMessage({
          logsRoot: LOGS_ROOT,
          threadId,
          threadSlug,
          userText: message,
          roleConfig,
          abortSignal: controller.signal,
          liveHooks,
        });
      } catch (err) {
        runFailed = err;
        throw err;
      } finally {
        const current = ACTIVE_CHAT_RUNS.get(threadId);
        if (current && current.controller === controller) {
          ACTIVE_CHAT_RUNS.delete(threadId);
        }
        finalizeLiveSession(
          threadId,
          runFailed
            ? (runFailed.code === "ABORTED" ? "canceled" : "error")
            : "idle"
        );
      }

      safeTouchThreadActivity(threadSlug, "chat_task_complete");
      return sendJson(res, 200, {
        ok: true,
        thread_id: threadId,
        user_message: result.user_message,
        responses: result.responses,
      });
    }

    // ---- Mode endpoints ----

    if (p === "/api/modes" && req.method === "GET") {
      const modes = getModes();
      if (!modes || !modes.length) {
        console.warn("[CatCafe] /api/modes: getModes() 返回空列表，请检查 mode-registry.js");
      }
      return sendJson(res, 200, { modes });
    }

    if (p.match(/^\/api\/threads\/[^/]+\/mode$/) && req.method === "GET") {
      const threadId = p.split("/")[3];
      const meta = readThreadMeta(LOGS_ROOT, threadId);
      if (!meta) return sendJson(res, 404, { error: "thread not found" });
      const mode = getMode(meta.mode);
      return sendJson(res, 200, {
        thread_id: threadId,
        mode: mode.id,
        mode_label: mode.label,
        mode_icon: mode.icon,
        mode_state: meta.mode_state || {},
        workflow_nodes: mode.id === "workflow" ? WORKFLOW_NODES : undefined,
      });
    }

    if (p.match(/^\/api\/threads\/[^/]+\/mode$/) && req.method === "PUT") {
      const threadId = p.split("/")[3];
      const body = await readRequestJson(req);
      const newMode = String(body.mode || "").trim();
      if (!isValidMode(newMode)) {
        return sendJson(res, 400, { error: `invalid mode: ${newMode}` });
      }
      const modeState = body.mode_state !== undefined ? body.mode_state : undefined;
      const roleConfig = readRoleConfig();
      const updated = updateThreadMode(LOGS_ROOT, threadId, newMode, modeState, roleConfig);
      if (!updated) return sendJson(res, 404, { error: "thread not found" });
      const activityThreadId = String(updated.parent_thread || "").trim()
        || (readThread(LOGS_ROOT, threadId) ? threadId : "");
      if (activityThreadId) safeTouchThreadActivity(activityThreadId, "thread_mode_update");
      const mode = getMode(updated.mode);
      return sendJson(res, 200, {
        ok: true,
        thread_id: threadId,
        mode: mode.id,
        mode_label: mode.label,
        mode_icon: mode.icon,
        mode_state: updated.mode_state || {},
      });
    }

    // Advance workflow node
    if (p.match(/^\/api\/threads\/[^/]+\/advance$/) && req.method === "POST") {
      const threadId = p.split("/")[3];
      const meta = readThreadMeta(LOGS_ROOT, threadId);
      if (!meta) return sendJson(res, 404, { error: "thread not found" });
      if (meta.mode !== "workflow") {
        return sendJson(res, 400, { error: "advance_node only works in workflow mode" });
      }
      const advanced = advanceWorkflowNode(meta.mode_state || {});
      if (!advanced) {
        return sendJson(res, 200, {
          ok: true,
          finished: true,
          thread_id: threadId,
          mode_state: meta.mode_state,
          message: "流程已全部完成",
        });
      }
      const updated = updateThreadMode(LOGS_ROOT, threadId, "workflow", advanced);
      if (!updated) return sendJson(res, 500, { error: "failed to update thread" });
      const activityThreadId = String(updated.parent_thread || "").trim()
        || (readThread(LOGS_ROOT, threadId) ? threadId : "");
      if (activityThreadId) safeTouchThreadActivity(activityThreadId, "thread_advanced_mode");
      if (advanced.finished) {
        return sendJson(res, 200, {
          ok: true,
          finished: true,
          thread_id: threadId,
          mode_state: updated.mode_state,
          message: "流程已全部完成",
        });
      }
      const node = WORKFLOW_NODES.find((n) => n.id === advanced.current_node);
      return sendJson(res, 200, {
        ok: true,
        finished: false,
        thread_id: threadId,
        mode_state: updated.mode_state,
        current_node: node,
        message: `已推进到：${node.label}`,
      });
    }

    // ---- Project endpoints ----

    if (p === "/api/projects" && req.method === "GET") {
      return sendJson(res, 200, { projects: listProjects(LOGS_ROOT), default_project_id: DEFAULT_PROJECT_ID });
    }

    if (p === "/api/projects" && req.method === "POST") {
      const body = await readRequestJson(req);
      const result = createProject(LOGS_ROOT, {
        projectId: body.project_id,
        projectName: body.project_name,
        description: body.description,
      });
      if (!result.ok) {
        const status = result.code === "THREAD_EXISTS" ? 409 : 400;
        return sendJson(res, status, { error: result.error, code: result.code || undefined });
      }
      return sendJson(res, 201, { ok: true, project: result.project });
    }

    {
      const projectMatch = p.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch && req.method === "GET") {
        const project = readProject(LOGS_ROOT, projectMatch[1]);
        if (!project) return sendJson(res, 404, { error: "项目不存在" });
        return sendJson(res, 200, { project });
      }
      if (projectMatch && req.method === "PUT") {
        const body = await readRequestJson(req);
        const result = updateProject(LOGS_ROOT, projectMatch[1], body);
        if (!result.ok) return sendJson(res, 400, { error: result.error });
        return sendJson(res, 200, { ok: true, project: result.project });
      }
      if (projectMatch && req.method === "DELETE") {
        const pid = projectMatch[1];
        if (pid === DEFAULT_PROJECT_ID) {
          return sendJson(res, 400, { error: "无法删除默认项目" });
        }
        const body = await readRequestJson(req);
        const operator = String(body.operator || "").trim();
        const reason = String(body.reason || "").trim();
        const result = deleteProject(LOGS_ROOT, pid, { operator, reason });
        if (!result.ok) {
          let status = 400;
          if (result.code === "THREAD_NOT_ARCHIVED") status = 409;
          if (result.code === "MISSING_AUDIT") status = 422;
          if (result.code === "THREAD_NOT_FOUND") status = 404;
          return sendJson(res, status, { error: result.error, code: result.code || undefined });
        }
        return sendJson(res, 200, { ok: true });
      }
    }

    // ---- Existing endpoints ----

    if (p === "/api/roles" && req.method === "GET") {
      return sendJson(res, 200, { role_config: readRoleConfig() });
    }

    if (p === "/api/roles" && req.method === "PUT") {
      const body = await readRequestJson(req);
      const checked = validateNicknameUniqueness(body.role_config || body);
      if (!checked.ok) return sendJson(res, 400, { error: checked.error });
      const next = writeRoleConfig(checked.roleConfig);
      return sendJson(res, 200, { ok: true, role_config: next });
    }

    if (p === "/api/tasks" && req.method === "GET") {
      const filterThread = u.searchParams.get("thread_id") || u.searchParams.get("project_id") || null;
      const catalog = buildVisibleTaskCatalog({ includeLegacyPreview: true });
      const filtered = filterThread
        ? filterTasksByThread(catalog.tasks, filterThread)
        : catalog.tasks;
      return sendJson(res, 200, { tasks: filtered });
    }

    if (p === "/api/tasks/run" && req.method === "POST") {
      const body = await readRequestJson(req);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) return sendJson(res, 400, { error: "prompt is required" });
      const threadGuard = assertThreadId(body, {
        source: "POST /api/tasks/run",
        mode: "container",
      });
      if (!threadGuard.ok) {
        return sendJson(res, threadGuard.status || 400, {
          error: threadGuard.error,
          fallback: threadGuard.fallback || undefined,
        });
      }
      const threadSlug = threadGuard.threadId;

      const provider = String(body.provider || "claude-cli");
      const model = body.model ? String(body.model) : undefined;
      const maxIterations = Number.isFinite(body.maxIterations) ? Number(body.maxIterations) : 3;
      const allowedTestCommands = resolveAllowedTestCommands(body, null);
      const testerBlockedPolicy = resolveTesterBlockedPolicy(body, null);
      const roleConfig = body.role_config ? normalizeRoleConfig(body.role_config) : readRoleConfig();
      const checked = validateNicknameUniqueness(roleConfig);
      if (!checked.ok) return sendJson(res, 400, { error: checked.error });
      const effectiveRoleConfig = checked.roleConfig;
      const roleProviders = stageAssignmentToRoleProviders(effectiveRoleConfig);
      const roleProfiles = stageRoleProfiles(effectiveRoleConfig);
      const providerCheck = validateTaskProviders(provider, roleProviders);
      if (!providerCheck.ok) {
        return sendJson(res, 400, {
          error: providerCheck.error,
          code: providerCheck.code,
          details: providerCheck.issues,
        });
      }

      let taskId = createTaskId();
      while (ACTIVE_TASK_RUNS.has(taskId)) taskId = createTaskId();
      const controller = new AbortController();
      ACTIVE_TASK_RUNS.set(taskId, { controller, started_at: Date.now(), kind: "new" });
      const liveHooks = createLiveHooks(taskId, {
        mode: "workflow",
        roleConfig: effectiveRoleConfig,
        current_stage: "intake",
      });
      ensureLiveSession(taskId, {
        mode: "workflow",
        roleConfig: effectiveRoleConfig,
        running: true,
        current_stage: "intake",
      });
      process.stdout.write(`[task-run] accepted task=${taskId} thread=${threadSlug} provider=${provider}\n`);
      invalidateTaskResolveCache();

      sendJson(res, 202, {
        ok: true,
        accepted: true,
        task_id: taskId,
        status: "running",
        message: "任务已启动，正在后台执行。",
        role_config: effectiveRoleConfig,
      });

      (async () => {
        const startedAt = Date.now();
        let summary = null;
        let runFailed = null;
        try {
          summary = await runTask(prompt, {
            provider,
            model,
            maxIterations,
            roleProviders,
            roleProfiles,
            roleConfig: effectiveRoleConfig,
            executionMode: "proposal",
            abortSignal: controller.signal,
            projectId: threadSlug,
            threadSlug,
            taskId,
            liveHooks,
            logsRoot: LOGS_ROOT,
            allowedTestCommands,
            testerBlockedPolicy,
          });
        } catch (err) {
          runFailed = err;
          process.stderr.write(
            `[task-run] background_failed task=${taskId} message=${err?.message || String(err)}\n`
          );
          if (err?.stack) process.stderr.write(`${String(err.stack)}\n`);
        } finally {
          const current = ACTIVE_TASK_RUNS.get(taskId);
          if (current && current.controller === controller) {
            ACTIVE_TASK_RUNS.delete(taskId);
          }
          const liveStatus = runFailed
            ? (runFailed.code === "ABORTED" ? "canceled" : "error")
            : (summary?.final_outcome || "idle");
          finalizeLiveSession(taskId, liveStatus);
          invalidateTaskResolveCache();
          safeTouchThreadActivity(threadSlug, "task_run_background");
          process.stdout.write(
            `[task-run] finished task=${taskId} outcome=${summary?.final_outcome || liveStatus} duration_ms=${Date.now() - startedAt}\n`
          );
        }
      })().catch(() => {});
      return;
    }

    if (p.startsWith("/api/tasks/") && req.method === "POST") {
      const seg = p.split("/").filter(Boolean);
      if (seg.length === 4 && seg[3] === "cancel") {
        const taskId = seg[2];
        const runningTask = ACTIVE_TASK_RUNS.get(taskId);
        if (runningTask) {
          runningTask.controller.abort();
          return sendJson(res, 200, { ok: true, task_id: taskId, canceled: true, message: "已发送终止信号。" });
        }
        const runningChat = ACTIVE_CHAT_RUNS.get(taskId);
        if (runningChat) {
          runningChat.controller.abort();
          return sendJson(res, 200, { ok: true, task_id: taskId, canceled: true, message: "已发送终止信号。" });
        }
        return sendJson(res, 200, { ok: true, task_id: taskId, canceled: false, message: "没有可取消的运行。" });
      }

      if (seg.length === 4 && seg[3] === "followup") {
        const taskId = seg[2];
        const task = getTaskDetail(taskId);
        const body = await readRequestJson(req);
        const message = String(body.message || "").trim();
        if (!message) return sendJson(res, 400, { error: "message is required" });

        if (!task) {
          const threadMeta = readThreadMeta(LOGS_ROOT, taskId);
          if (!threadMeta) return sendJson(res, 404, { error: "task not found" });
          const hintedParentThread = String(threadMeta.parent_thread || "").trim();
          const threadGuard = assertThreadId(body, {
            source: "POST /api/tasks/:id/followup(thread)",
            mode: "container",
            sessionId: taskId,
            hintedThreadId: hintedParentThread || null,
          });
          if (!threadGuard.ok) {
            return sendJson(res, threadGuard.status || 400, {
              error: threadGuard.error,
              fallback: threadGuard.fallback || undefined,
            });
          }
          if (hintedParentThread && threadGuard.threadId !== hintedParentThread) {
            return sendJson(res, 409, {
              error: `session ${taskId} belongs to thread ${hintedParentThread}, not ${threadGuard.threadId}`,
            });
          }
          if (ACTIVE_CHAT_RUNS.has(taskId)) {
            return sendJson(res, 409, { error: "该会话已有运行进行中，请先终止或等待完成。" });
          }
          const roleConfig = body.role_config ? normalizeRoleConfig(body.role_config) : readRoleConfig();
          const checked = validateNicknameUniqueness(roleConfig);
          if (!checked.ok) return sendJson(res, 400, { error: checked.error });
          const effectiveRoleConfig = checked.roleConfig;
          const liveHooks = createLiveHooks(taskId, {
            mode: threadMeta.mode || "free_chat",
            roleConfig: effectiveRoleConfig,
            current_stage: threadMeta.mode || "chat",
          });
          const controller = new AbortController();
          ACTIVE_CHAT_RUNS.set(taskId, { controller, started_at: Date.now() });
          let result;
          let runFailed = null;
          try {
            result = await sendChatMessage({
              logsRoot: LOGS_ROOT,
              threadId: taskId,
              threadSlug: threadGuard.threadId,
              userText: message,
              roleConfig: effectiveRoleConfig,
              abortSignal: controller.signal,
              liveHooks,
            });
          } catch (err) {
            runFailed = err;
            throw err;
          } finally {
            const current = ACTIVE_CHAT_RUNS.get(taskId);
            if (current && current.controller === controller) {
              ACTIVE_CHAT_RUNS.delete(taskId);
            }
            finalizeLiveSession(
              taskId,
              runFailed
                ? (runFailed.code === "ABORTED" ? "canceled" : "error")
                : "idle"
            );
          }
          const parentThread = String(threadGuard.threadId || hintedParentThread || "").trim();
          if (parentThread) safeTouchThreadActivity(parentThread, "followup_thread_chat");
          return sendJson(res, 200, {
            ok: true,
            task_id: taskId,
            thread_id: taskId,
            _is_thread: true,
            user_message: result.user_message,
            responses: result.responses,
            summary: buildThreadSummary(taskId, threadMeta),
            role_config: effectiveRoleConfig,
          });
        }

        const summary = task.summary || {};
        const allowedTestCommands = resolveAllowedTestCommands(body, summary);
        const testerBlockedPolicy = resolveTesterBlockedPolicy(body, summary);
        const summaryThreadId = String(summary.thread_id || summary.project_id || "").trim();
        const threadGuard = assertThreadId(body, {
          source: "POST /api/tasks/:id/followup(task)",
          mode: "container",
          sessionId: taskId,
          hintedThreadId: summaryThreadId || null,
        });
        if (!threadGuard.ok) {
          return sendJson(res, threadGuard.status || 400, {
            error: threadGuard.error,
            fallback: threadGuard.fallback || undefined,
          });
        }
        if (summaryThreadId && threadGuard.threadId !== summaryThreadId) {
          return sendJson(res, 409, {
            error: `task ${taskId} belongs to thread ${summaryThreadId}, not ${threadGuard.threadId}`,
          });
        }
        const roleConfig = body.role_config ? normalizeRoleConfig(body.role_config) : readRoleConfig();
        const checked = validateNicknameUniqueness(roleConfig);
        if (!checked.ok) return sendJson(res, 400, { error: checked.error });
        const effectiveRoleConfig = checked.roleConfig;
        const roleProviders = stageAssignmentToRoleProviders(effectiveRoleConfig);
        const roleProfiles = stageRoleProfiles(effectiveRoleConfig);
        const maxIterations = Number.isFinite(body.maxIterations) ? Number(body.maxIterations) : 1;
        const provider = String(body.provider || summary.provider || "claude-cli");
        const providerCheck = validateTaskProviders(provider, roleProviders);
        if (!providerCheck.ok) {
          return sendJson(res, 400, {
            error: providerCheck.error,
            code: providerCheck.code,
            details: providerCheck.issues,
          });
        }
        const taskThreadId = threadGuard.threadId;
        // Confirm implementation only through explicit control flag from /confirm.
        // Free-form follow-up text must never auto-switch execution mode.
        const confirmRequested = body.confirm === true;
        // Persist operator input unconditionally so refresh/reload can always reconstruct chat history.
        // Implementation prompts still filter pure control confirmations in buildThreadPrompt().
        appendFollowup(task.task_dir, message, body.client_message_id || body.clientMessageId || null);
        const prompt = buildThreadPrompt(task.task_dir, {
          executionMode: confirmRequested ? "implementation" : "proposal",
        });
        // Even when awaiting operator confirm, allow further /ask discussion rounds.
        // Only /confirm switches execution into implementation mode.

        if (ACTIVE_TASK_RUNS.has(taskId)) {
          return sendJson(res, 409, { error: "该任务已有运行进行中，请先终止或等待完成。" });
        }
        const controller = new AbortController();
        ACTIVE_TASK_RUNS.set(taskId, { controller, started_at: Date.now(), kind: "followup" });
        const liveHooks = createLiveHooks(taskId, {
          mode: "workflow",
          roleConfig: effectiveRoleConfig,
          current_stage: "intake",
        });
        ensureLiveSession(taskId, { mode: "workflow", roleConfig: effectiveRoleConfig, running: true, current_stage: "intake" });
        let updated;
        let runFailed = null;
        try {
          updated = await runTask(prompt, {
          provider,
          model: body.model ? String(body.model) : summary.model || undefined,
          maxIterations: Math.max(1, maxIterations),
          roleProviders,
          roleProfiles,
          roleConfig: effectiveRoleConfig,
          appendToTask: true,
          taskId,
          taskDir: task.task_dir,
          executionMode: confirmRequested ? "implementation" : "proposal",
          operatorConfirmed: confirmRequested,
          abortSignal: controller.signal,
            liveHooks,
            projectId: taskThreadId || undefined,
            threadSlug: taskThreadId || undefined,
            logsRoot: LOGS_ROOT,
            allowedTestCommands,
            testerBlockedPolicy,
          });
        } catch (err) {
          runFailed = err;
          throw err;
        } finally {
          const current = ACTIVE_TASK_RUNS.get(taskId);
          if (current && current.controller === controller) {
            ACTIVE_TASK_RUNS.delete(taskId);
          }
          finalizeLiveSession(
            taskId,
            runFailed
              ? (runFailed.code === "ABORTED" ? "canceled" : "error")
              : (updated?.final_outcome || "idle")
          );
        }
        const statusThreadId = String(updated?.thread_id || summary.thread_id || "").trim();
        if (statusThreadId) safeTouchThreadActivity(statusThreadId, "followup_task");
        invalidateTaskResolveCache();

        return sendJson(res, 200, {
          ok: true,
          task_id: taskId,
          summary: updated,
          role_config: effectiveRoleConfig,
        });
      }

      if (seg.length === 4 && seg[3] === "rerun") {
        const taskId = seg[2];
        const task = getTaskDetail(taskId);
        if (!task) {
          const threadMeta = readThreadMeta(LOGS_ROOT, taskId);
          if (!threadMeta) return sendJson(res, 404, { error: "task not found" });
          const body = await readRequestJson(req);
          const prompt = String(body.prompt || "").trim();
          if (!prompt) {
            return sendJson(res, 400, { error: "thread rerun 需要 prompt；可直接发送普通消息。" });
          }
          const hintedParentThread = String(threadMeta.parent_thread || "").trim();
          const threadGuard = assertThreadId(body, {
            source: "POST /api/tasks/:id/rerun(thread)",
            mode: "container",
            sessionId: taskId,
            hintedThreadId: hintedParentThread || null,
          });
          if (!threadGuard.ok) {
            return sendJson(res, threadGuard.status || 400, {
              error: threadGuard.error,
              fallback: threadGuard.fallback || undefined,
            });
          }
          if (hintedParentThread && threadGuard.threadId !== hintedParentThread) {
            return sendJson(res, 409, {
              error: `session ${taskId} belongs to thread ${hintedParentThread}, not ${threadGuard.threadId}`,
            });
          }
          if (ACTIVE_CHAT_RUNS.has(taskId)) {
            return sendJson(res, 409, { error: "该会话已有运行进行中，请先终止或等待完成。" });
          }
          const roleConfig = body.role_config ? normalizeRoleConfig(body.role_config) : readRoleConfig();
          const checked = validateNicknameUniqueness(roleConfig);
          if (!checked.ok) return sendJson(res, 400, { error: checked.error });
          const effectiveRoleConfig = checked.roleConfig;
          const liveHooks = createLiveHooks(taskId, {
            mode: threadMeta.mode || "free_chat",
            roleConfig: effectiveRoleConfig,
            current_stage: threadMeta.mode || "chat",
          });
          const controller = new AbortController();
          ACTIVE_CHAT_RUNS.set(taskId, { controller, started_at: Date.now() });
          let result;
          let runFailed = null;
          try {
            result = await sendChatMessage({
              logsRoot: LOGS_ROOT,
              threadId: taskId,
              threadSlug: threadGuard.threadId,
              userText: prompt,
              roleConfig: effectiveRoleConfig,
              abortSignal: controller.signal,
              liveHooks,
            });
          } catch (err) {
            runFailed = err;
            throw err;
          } finally {
            const current = ACTIVE_CHAT_RUNS.get(taskId);
            if (current && current.controller === controller) {
              ACTIVE_CHAT_RUNS.delete(taskId);
            }
            finalizeLiveSession(
              taskId,
              runFailed
                ? (runFailed.code === "ABORTED" ? "canceled" : "error")
                : "idle"
            );
          }
          const parentThread = String(threadGuard.threadId || hintedParentThread || "").trim();
          if (parentThread) safeTouchThreadActivity(parentThread, "rerun_thread_chat");
          return sendJson(res, 200, {
            ok: true,
            task_id: taskId,
            thread_id: taskId,
            _is_thread: true,
            user_message: result.user_message,
            responses: result.responses,
            summary: buildThreadSummary(taskId, threadMeta),
            role_config: effectiveRoleConfig,
          });
        }
        if (ACTIVE_TASK_RUNS.has(taskId)) {
          return sendJson(res, 409, { error: "该任务已有运行进行中，请先终止或等待完成。" });
        }

        const body = await readRequestJson(req);
        const summary = task.summary || {};
        const prompt = String(body.prompt || task.task_md || "").trim();
        if (!prompt) return sendJson(res, 400, { error: "task prompt is empty" });
        const summaryThreadId = String(summary.thread_id || summary.project_id || "").trim();
        const threadGuard = assertThreadId(body, {
          source: "POST /api/tasks/:id/rerun(task)",
          mode: "container",
          sessionId: taskId,
          hintedThreadId: summaryThreadId || null,
        });
        if (!threadGuard.ok) {
          return sendJson(res, threadGuard.status || 400, {
            error: threadGuard.error,
            fallback: threadGuard.fallback || undefined,
          });
        }
        if (summaryThreadId && threadGuard.threadId !== summaryThreadId) {
          return sendJson(res, 409, {
            error: `task ${taskId} belongs to thread ${summaryThreadId}, not ${threadGuard.threadId}`,
          });
        }
        const roleConfig = body.role_config ? normalizeRoleConfig(body.role_config) : readRoleConfig();
        const checked = validateNicknameUniqueness(roleConfig);
        if (!checked.ok) return sendJson(res, 400, { error: checked.error });
        const effectiveRoleConfig = checked.roleConfig;
        const roleProviders = stageAssignmentToRoleProviders(effectiveRoleConfig);
        const roleProfiles = stageRoleProfiles(effectiveRoleConfig);
        const provider = String(body.provider || summary.provider || "claude-cli");
        const allowedTestCommands = resolveAllowedTestCommands(body, summary);
        const testerBlockedPolicy = resolveTesterBlockedPolicy(body, summary);
        const providerCheck = validateTaskProviders(provider, roleProviders);
        if (!providerCheck.ok) {
          return sendJson(res, 400, {
            error: providerCheck.error,
            code: providerCheck.code,
            details: providerCheck.issues,
          });
        }
        const taskThreadId = threadGuard.threadId;

        const controller = new AbortController();
        ACTIVE_TASK_RUNS.set(taskId, { controller, started_at: Date.now(), kind: "rerun" });
        const liveHooks = createLiveHooks(taskId, {
          mode: "workflow",
          roleConfig: effectiveRoleConfig,
          current_stage: "intake",
        });
        ensureLiveSession(taskId, { mode: "workflow", roleConfig: effectiveRoleConfig, running: true, current_stage: "intake" });
        let rerun;
        let runFailed = null;
        try {
          rerun = await runTask(prompt, {
          provider,
          model: body.model ? String(body.model) : summary.model || undefined,
          maxIterations: Number.isFinite(body.maxIterations)
            ? Number(body.maxIterations)
            : Number(summary.max_iterations || 3),
          roleProviders,
          roleProfiles,
          roleConfig: effectiveRoleConfig,
          abortSignal: controller.signal,
            liveHooks,
            projectId: taskThreadId || undefined,
            threadSlug: taskThreadId || undefined,
            logsRoot: LOGS_ROOT,
            allowedTestCommands,
            testerBlockedPolicy,
          });
        } catch (err) {
          runFailed = err;
          throw err;
        } finally {
          const current = ACTIVE_TASK_RUNS.get(taskId);
          if (current && current.controller === controller) {
            ACTIVE_TASK_RUNS.delete(taskId);
          }
          finalizeLiveSession(
            taskId,
            runFailed
              ? (runFailed.code === "ABORTED" ? "canceled" : "error")
              : (rerun?.final_outcome || "idle")
          );
        }
        const rerunThreadId = String(rerun?.thread_id || taskThreadId || "").trim();
        if (rerunThreadId) safeTouchThreadActivity(rerunThreadId, "rerun_task");
        invalidateTaskResolveCache();

        return sendJson(res, 200, {
          ok: true,
          task_id: rerun.task_id,
          summary: rerun,
          role_config: effectiveRoleConfig,
        });
      }
    }

    if (p.startsWith("/api/tasks/") && req.method === "DELETE") {
      const seg = p.split("/").filter(Boolean);
      if (seg.length === 3) {
        const taskId = seg[2];

        // 路径安全校验：仅允许合法任务ID格式，禁止路径穿越字符
        if (!taskId || typeof taskId !== "string") {
          return sendJson(res, 400, { error: "无效的任务ID" });
        }
        // 禁止包含路径分隔符和父目录引用
        if (/[\/\\]|\.\./.test(taskId)) {
          return sendJson(res, 400, { error: "任务ID包含非法字符" });
        }
        // 允许合法的任务ID格式：{timestamp}-{hash}（如 1771382424778-1568fc9e）
        if (!/^\d+-[a-f0-9]+$/.test(taskId)) {
          return sendJson(res, 400, { error: "任务ID格式不合法" });
        }

        const resolvedTask = resolveTaskById(taskId);
        if (!resolvedTask) {
          // Fallback: try to delete as a chat thread
          const threadMeta = readThreadMeta(LOGS_ROOT, taskId);
          if (threadMeta) {
            const hintedThreadId = String(threadMeta.parent_thread || "").trim();
            const sessionDir = resolveChatSessionDirForDelete(taskId, hintedThreadId || null);
            if (!sessionDir) {
              return sendJson(res, 404, { error: "session not found" });
            }
            const sessionGuard = verifyChatSessionDeleteDir(taskId, sessionDir);
            if (!sessionGuard.ok) {
              return sendJson(res, sessionGuard.status || 403, { error: sessionGuard.error || "session delete blocked" });
            }
            fs.rmSync(sessionGuard.real_session_dir, { recursive: true, force: true });
            const parentThread = String(threadMeta.parent_thread || "").trim() || locateSessionThread(taskId);
            if (parentThread) safeTouchThreadActivity(parentThread, "delete_thread_session");
            invalidateTaskResolveCache();
            LIVE_SESSIONS.delete(taskId);
            return sendJson(res, 200, { ok: true, task_id: taskId, message: "会话已删除" });
          }
          return sendJson(res, 404, { error: "task not found" });
        }
        const taskDir = resolvedTask.dir;
        const deleteGuard = verifyTaskDeleteDir(taskId, taskDir);
        if (!deleteGuard.ok) {
          return sendJson(res, deleteGuard.status || 403, { error: deleteGuard.error || "task delete blocked" });
        }

        // 检查是否有正在运行的任务
        if (ACTIVE_TASK_RUNS.has(taskId)) {
          return sendJson(res, 409, { error: "该任务正在运行中，请先终止后再删除。" });
        }

        // 递归删除任务目录
        fs.rmSync(taskDir, { recursive: true, force: true });
        invalidateTaskResolveCache();
        LIVE_SESSIONS.delete(taskId);
        return sendJson(res, 200, { ok: true, task_id: taskId, message: "会话已删除" });
      }
    }

    if (p.startsWith("/api/tasks/") && req.method === "GET") {
      const seg = p.split("/").filter(Boolean); // api tasks :id ...
      if (seg.length >= 3) {
        const taskId = seg[2];
        const task = getTaskDetail(taskId);

        if (seg.length === 5 && seg[3] === "live" && seg[4] === "stream") {
          const threadMetaForStream = task ? null : readThreadMeta(LOGS_ROOT, taskId);
          if (!task && !threadMetaForStream) {
            return sendJson(res, 404, { error: "task not found" });
          }
          res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
          });
          if (typeof res.flushHeaders === "function") res.flushHeaders();
          res.write("retry: 1500\n\n");

          const initial = task
            ? liveSessionSnapshot(taskId, buildTaskMessages(taskId, task.task_dir))
            : liveSessionSnapshot(taskId, buildThreadMessagesBundle(taskId));
          res.write(`event: live\ndata: ${JSON.stringify(initial)}\n\n`);
          addLiveSubscriber(taskId, res);

          const heartbeat = setInterval(() => {
            try {
              res.write(": ping\n\n");
            } catch {}
          }, 15000);
          const cleanup = () => {
            clearInterval(heartbeat);
            removeLiveSubscriber(taskId, res);
          };
          req.on("close", cleanup);
          req.on("end", cleanup);
          return;
        }

        // Fallback: if not a task, check if it's a chat thread
        if (!task) {
          const threadMeta = readThreadMeta(LOGS_ROOT, taskId);
          if (!threadMeta) return sendJson(res, 404, { error: "task not found" });

          if (seg.length === 3) {
            const msgs = readMessages(LOGS_ROOT, taskId);
            const firstUserMsg = msgs.find((m) => m.sender_type === "user");
            return sendJson(res, 200, {
              task_id: taskId,
              _is_thread: true,
              _thread_id: taskId,
              summary: buildThreadSummary(taskId, threadMeta),
              task_md: firstUserMsg?.text || threadMeta.title || "",
              timeline: null,
            });
          }

          if (seg.length === 4 && seg[3] === "report.md") {
            const md = buildThreadReportMarkdown(taskId);
            return sendMarkdown(res, 200, md, `task-${taskId}.md`);
          }

          if (seg.length === 4 && seg[3] === "live") {
            if (LIVE_SESSIONS.has(taskId)) {
              return sendJson(res, 200, liveSessionSnapshot(taskId));
            }
            const bundle = buildThreadMessagesBundle(taskId);
            return sendJson(res, 200, liveSessionSnapshot(taskId, bundle));
          }

          if (seg.length === 4 && seg[3] === "messages") {
            return sendJson(res, 200, buildThreadMessagesBundle(taskId));
          }

          return sendJson(res, 404, { error: "not supported for thread" });
        }

        if (seg.length === 4 && seg[3] === "report.md") {
          const md = buildTaskReportMarkdown(taskId, task.task_dir);
          return sendMarkdown(res, 200, md, `task-${taskId}.md`);
        }

        if (seg.length === 3) {
          return sendJson(res, 200, task);
        }

        if (seg.length === 4 && seg[3] === "messages") {
          return sendJson(res, 200, buildTaskMessages(taskId, task.task_dir));
        }

        if (seg.length === 4 && seg[3] === "live") {
          if (LIVE_SESSIONS.has(taskId)) {
            return sendJson(res, 200, liveSessionSnapshot(taskId));
          }
          const bundle = buildTaskMessages(taskId, task.task_dir);
          return sendJson(res, 200, liveSessionSnapshot(taskId, bundle));
        }

        if (seg.length === 4 && seg[3] === "evidence") {
          const round = Number(u.searchParams.get("round"));
          const role = String(u.searchParams.get("role") || "");
          const kind = String(u.searchParams.get("kind") || "");
          if (!Number.isFinite(round) || round <= 0) {
            return sendJson(res, 400, { error: "invalid round" });
          }
          const ev = readEvidence(task.task_dir, round, role, kind);
          if (!ev) return sendJson(res, 404, { error: "evidence not found" });
          return sendJson(res, 200, ev);
        }

        if (seg.length === 5 && seg[3] === "rounds") {
          const round = Number(seg[4]);
          if (!Number.isFinite(round) || round <= 0) {
            return sendJson(res, 400, { error: "invalid round" });
          }
          const data = readRoundFiles(task.task_dir, round);
          if (!data) return sendJson(res, 404, { error: "round not found" });
          return sendJson(res, 200, data);
        }
      }
    }

    serveStatic(p, res);
  } catch (err) {
    const errMessage = err?.message || String(err);
    const traceRequestId = req?.__traceContext?.request_id || "-";
    process.stderr.write(
      `[ui-server] ts=${nowIsoUtc()} request_error request_id=${traceRequestId} method=${req.method} path=${req.url || "-"} message=${errMessage}\n`
    );
    if (err?.stack) process.stderr.write(`${String(err.stack)}\n`);
    return sendJson(res, 500, { error: err?.message || String(err) });
  }
});

// 启动时确保默认 Thread 存在（同时保持 project 兼容）
ensureDefaultThread(LOGS_ROOT, DEFAULT_PROJECT_ID, DEFAULT_PROJECT_NAME);
const indexRepair = validateAndRepairIndex(LOGS_ROOT);
if (indexRepair?.repaired) {
  process.stdout.write("[thread-index] repaired _index.json from disk state\n");
}

server.listen(PORT, HOST, () => {
  process.stdout.write(`UI server running: http://${HOST}:${PORT}\n`);
});
