"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { executeProviderText } = require("../providers/execute-provider");
const { runCoder } = require("../agents/coder");
const { runReviewer } = require("../agents/reviewer");
const { runTester } = require("../agents/tester");
const { runTestCommands, DEFAULT_ALLOWED_PREFIXES } = require("./test-runner");
const {
  DEFAULT_MODE,
  isValidMode,
  buildModePrompt,
  WORKFLOW_NODES,
  buildWorkflowModeState,
} = require("../modes/mode-registry");
const {
  buildCatLookup,
  parseMentions,
  buildChatContext,
} = require("./context-builder");

const WORKFLOW_ROLE_TO_STAGE = Object.freeze({
  CoreDev: "coder",
  Reviewer: "reviewer",
  Tester: "tester",
});

function isProviderRunOk(result) {
  const code = Number(result?.exit?.code);
  const hasExitFailure = Number.isFinite(code) && code !== 0;
  return !result?.error_class && !hasExitFailure;
}

function formatLocalDateTime(ts = Date.now()) {
  const d = new Date(ts);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function writeRuntimeLog(scope, title, fields = {}) {
  const lines = [
    `[${scope}] ${title}`,
    `  time: ${formatLocalDateTime()}`,
  ];
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null || v === "") continue;
    lines.push(`  ${k}: ${v}`);
  }
  process.stdout.write(`\n${lines.join("\n")}\n`);
}

/**
 * Chat Session Engine
 *
 * Manages free-form @猫猫 chat interactions.
 * Parses @mentions, resolves target cats, builds persona prompts,
 * and routes messages to the correct provider.
 */

// ---------------------------------------------------------------------------
// Resolve provider info from cat config + models list
// ---------------------------------------------------------------------------

function resolveProviderForCat(cat, models) {
  const modelId = cat.model_id;
  if (!modelId || !Array.isArray(models)) {
    return { provider: "claude-cli", model: null, settingsFile: null };
  }
  const modelDef = models.find((m) => m.id === modelId);
  if (!modelDef) return { provider: "claude-cli", model: null, settingsFile: null };
  return {
    provider: modelDef.provider || "claude-cli",
    model: modelDef.model || null,
    settingsFile: modelDef.settings_file || null,
  };
}

// ---------------------------------------------------------------------------
// Chat message model
// ---------------------------------------------------------------------------

function createMessage({ sender, sender_type, cat_name, text, ts, provider, model, duration_ms, input_tokens, output_tokens, cost_usd }) {
  const msg = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    sender: sender || "铲屎官",
    sender_type: sender_type || "user", // "user" | "cat"
    cat_name: cat_name || null,
    text: String(text || ""),
    ts: ts || Date.now(),
  };
  if (provider) msg.provider = provider;
  if (model) msg.model = model;
  if (Number.isFinite(duration_ms)) msg.duration_ms = duration_ms;
  if (Number.isFinite(input_tokens)) msg.input_tokens = input_tokens;
  if (Number.isFinite(output_tokens)) msg.output_tokens = output_tokens;
  if (Number.isFinite(cost_usd)) msg.cost_usd = cost_usd;
  return msg;
}

// ---------------------------------------------------------------------------
// Session persistence (formerly "Thread persistence")
//
// Terminology: Thread = project container, Session = conversation within thread
// Sessions are stored at:
//   New: logs/threads/{threadSlug}/sessions/{sessionId}/meta.json
//   Legacy: logs/threads/{sessionId}/meta.json
// ---------------------------------------------------------------------------

/**
 * Resolve the directory for a chat session, checking new path then legacy.
 */
function resolveSessionDir(logsRoot, sessionId, threadSlug = null) {
  // Try new thread-scoped path first
  if (threadSlug) {
    const newPath = path.join(logsRoot, "threads", threadSlug, "sessions", sessionId);
    if (fs.existsSync(newPath)) return newPath;
  }
  // Try legacy path
  const legacyPath = path.join(logsRoot, "threads", sessionId);
  if (fs.existsSync(legacyPath)) return legacyPath;
  // Best-effort lookup when caller only has session id.
  if (!threadSlug) {
    const threadsRoot = path.join(logsRoot, "threads");
    if (fs.existsSync(threadsRoot)) {
      const entries = fs.readdirSync(threadsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
        const scoped = path.join(threadsRoot, entry.name, "sessions", sessionId);
        if (fs.existsSync(scoped)) return scoped;
      }
    }
  }
  // For creation: prefer new path if threadSlug given
  if (threadSlug) {
    return path.join(logsRoot, "threads", threadSlug, "sessions", sessionId);
  }
  return legacyPath;
}

// Keep old name as alias for internal compatibility
function threadDir(logsRoot, threadId) {
  return resolveSessionDir(logsRoot, threadId);
}

function ensureSessionDir(logsRoot, sessionId, threadSlug = null) {
  const dir = resolveSessionDir(logsRoot, sessionId, threadSlug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Legacy alias
function ensureThreadDir(logsRoot, threadId) {
  return ensureSessionDir(logsRoot, threadId);
}

function sessionLockPath(sessionDir) {
  return path.join(sessionDir, "._session.lock");
}

function acquireSessionLock(lockFile) {
  try {
    const fd = fs.openSync(lockFile, "wx");
    fs.writeFileSync(fd, String(process.pid), "utf8");
    return fd;
  } catch (err) {
    if (err && err.code === "EEXIST") return null;
    throw err;
  }
}

function releaseSessionLock(lockFile, fd) {
  try {
    if (Number.isInteger(fd)) fs.closeSync(fd);
  } catch {}
  try {
    fs.rmSync(lockFile, { force: true });
  } catch {}
}

function sleepMs(ms) {
  const waitMs = Math.max(1, Number(ms) || 0);
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    // busy wait for short lock retries
  }
}

function withSessionLock(sessionDir, fn, opts = {}) {
  const lockFile = sessionLockPath(sessionDir);
  const timeoutMs = Math.max(1, Number(opts.timeout_ms) || 2000);
  const retryMs = Math.max(1, Number(opts.retry_ms) || 10);
  const staleMs = Math.max(1000, Number(opts.stale_ms) || 30000);
  const start = Date.now();

  while (true) {
    const fd = acquireSessionLock(lockFile);
    if (fd !== null) {
      try {
        return fn();
      } finally {
        releaseSessionLock(lockFile, fd);
      }
    }

    try {
      const stat = fs.statSync(lockFile);
      if (Date.now() - stat.mtimeMs > staleMs) {
        fs.rmSync(lockFile, { force: true });
      }
    } catch {}

    if (Date.now() - start >= timeoutMs) {
      const err = new Error(`session lock timeout: ${lockFile}`);
      err.code = "SESSION_LOCK_TIMEOUT";
      throw err;
    }
    sleepMs(retryMs);
  }
}

/**
 * Create a new chat session under a Thread.
 * @param {string} threadSlug - Thread slug (required for new sessions)
 */
function createThread(logsRoot, title, mode, roleConfig, threadSlug) {
  const sessionId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const dir = ensureSessionDir(logsRoot, sessionId, threadSlug || null);
  const effectiveMode = (mode && isValidMode(mode)) ? mode : DEFAULT_MODE;
  let modeStateInit = {};
  if (effectiveMode === "workflow" && roleConfig) {
    modeStateInit = buildWorkflowModeState(roleConfig);
  }
  const meta = {
    thread_id: sessionId,
    title: title || "新对话",
    mode: effectiveMode,
    mode_state: modeStateInit,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  if (threadSlug) meta.parent_thread = String(threadSlug).trim();
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
  return meta;
}

function updateThreadMode(logsRoot, threadId, mode, modeState, roleConfig, threadSlug = null) {
  const meta = readThreadMeta(logsRoot, threadId, threadSlug);
  if (!meta) return null;
  if (mode && isValidMode(mode)) meta.mode = mode;
  if (modeState !== undefined) {
    meta.mode_state = modeState;
  } else if (mode === "workflow" && roleConfig) {
    meta.mode_state = buildWorkflowModeState(roleConfig);
  } else if (mode && mode !== "workflow") {
    meta.mode_state = {};
  }
  meta.updated_at = Date.now();
  const dir = resolveSessionDir(logsRoot, threadId, meta.parent_thread || threadSlug || null);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
  return meta;
}

function updateThreadMeta(logsRoot, threadId, patch, threadSlug = null) {
  const meta = readThreadMeta(logsRoot, threadId, threadSlug);
  if (!meta) return null;
  const allowed = ["title", "parent_thread"];
  for (const key of allowed) {
    if (patch[key] !== undefined) meta[key] = patch[key];
  }
  meta.updated_at = Date.now();
  const dir = resolveSessionDir(logsRoot, threadId, meta.parent_thread || threadSlug || null);
  fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
  return meta;
}

function touchSessionMeta(logsRoot, threadId, threadSlug = null, updatedAt = Date.now(), resolvedDir = null) {
  const dir = resolvedDir || resolveSessionDir(logsRoot, threadId, threadSlug);
  const file = path.join(dir, "meta.json");
  if (!fs.existsSync(file)) {
    const err = new Error(`session meta missing: ${threadId}`);
    err.code = "SESSION_META_MISSING";
    throw err;
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    const parseErr = new Error(`invalid session meta: ${threadId}`);
    parseErr.code = "SESSION_META_INVALID";
    parseErr.cause = err;
    throw parseErr;
  }
  const prev = Number(meta.updated_at) || 0;
  const candidate = Number.isFinite(Number(updatedAt)) ? Number(updatedAt) : Date.now();
  meta.updated_at = Math.max(prev + 1, candidate);
  fs.writeFileSync(file, JSON.stringify(meta, null, 2) + "\n", "utf8");
  return meta;
}

function appendMessage(logsRoot, threadId, message, threadSlug = null) {
  const dir = ensureSessionDir(logsRoot, threadId, threadSlug);
  return withSessionLock(dir, () => {
    const file = path.join(dir, "messages.jsonl");
    const line = JSON.stringify(message) + "\n";
    const existed = fs.existsSync(file);
    const beforeSize = existed ? fs.statSync(file).size : 0;
    let wroteMessage = false;

    try {
      fs.appendFileSync(file, line, "utf8");
      wroteMessage = true;
      const ts = Number.isFinite(Number(message?.ts)) ? Number(message.ts) : Date.now();
      touchSessionMeta(logsRoot, threadId, threadSlug, ts, dir);
      return message;
    } catch (err) {
      if (wroteMessage) {
        try {
          fs.truncateSync(file, beforeSize);
          if (!existed && beforeSize === 0) fs.rmSync(file, { force: true });
        } catch {}
      }
      throw err;
    }
  });
}

function readMessages(logsRoot, threadId, threadSlug = null) {
  const dir = resolveSessionDir(logsRoot, threadId, threadSlug);
  const file = path.join(dir, "messages.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function readThreadMeta(logsRoot, threadId, threadSlug = null) {
  const dir = resolveSessionDir(logsRoot, threadId, threadSlug);
  const file = path.join(dir, "meta.json");
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/**
 * List chat sessions. When threadSlug is given, lists only sessions under that thread.
 * Otherwise lists all legacy chat sessions (backward compat).
 */
function listThreads(logsRoot, threadSlug = null) {
  if (threadSlug) {
    // List sessions under specific thread
    const sessDir = path.join(logsRoot, "threads", threadSlug, "sessions");
    if (!fs.existsSync(sessDir)) return [];
    return fs
      .readdirSync(sessDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const meta = readThreadMeta(logsRoot, d.name, threadSlug);
        return meta;
      })
      .filter(Boolean)
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  }
  // Legacy: list all chat sessions at logs/threads/{id}/meta.json
  const root = path.join(logsRoot, "threads");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => {
      // Skip thread container dirs (they have thread.json, not meta.json)
      const hasThreadJson = fs.existsSync(path.join(root, d.name, "thread.json"));
      if (hasThreadJson) return null;
      return readThreadMeta(logsRoot, d.name);
    })
    .filter(Boolean)
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

// ---------------------------------------------------------------------------
// Send chat message — the main entry point
// ---------------------------------------------------------------------------

async function sendChatMessage({
  logsRoot,
  threadId,
  threadSlug = null,
  userText,
  roleConfig,
  timeoutMs = 5 * 60 * 1000,
  abortSignal = null,
  liveHooks = null,
}) {
  const cats = roleConfig?.cats || {};
  const models = roleConfig?.models || [];

  // Read thread meta for mode info
  const threadMeta =
    readThreadMeta(logsRoot, threadId, threadSlug) ||
    readThreadMeta(logsRoot, threadId) ||
    {};
  const effectiveThreadSlug = String(threadSlug || threadMeta.parent_thread || "").trim() || null;
  const mode = threadMeta.mode || DEFAULT_MODE;
  const modeState = threadMeta.mode_state || {};

  function emitLiveAgentState(payload = {}) {
    if (!liveHooks || typeof liveHooks.onAgentState !== "function") return;
    try {
      liveHooks.onAgentState({
        thread_id: threadId,
        mode,
        ts: Date.now(),
        ...payload,
      });
    } catch {}
  }

  function emitLiveAgentEvent(payload = {}) {
    if (!liveHooks || typeof liveHooks.onAgentEvent !== "function") return;
    try {
      liveHooks.onAgentEvent({
        thread_id: threadId,
        mode,
        ts: Date.now(),
        ...payload,
      });
    } catch {}
  }

  // Context routing decisions are centralized in context-builder.
  const preContext = buildChatContext({
    mode,
    modeState,
    userText,
    cats,
    history: [],
    workflowNodes: WORKFLOW_NODES,
  });
  const effectiveTargets = preContext.effectiveTargets;
  const promptUserText = preContext.promptUserText;

  if (effectiveTargets.length === 0) {
    throw new Error("没有可用的猫猫，请检查 role-config.json 中的 cats 配置。");
  }

  // Store user message
  const userMsg = createMessage({
    sender: "铲屎官",
    sender_type: "user",
    text: userText,
  });
  appendMessage(logsRoot, threadId, userMsg, effectiveThreadSlug);

  // Read history for context
  const history = readMessages(logsRoot, threadId, effectiveThreadSlug);
  const postContext = buildChatContext({
    mode,
    modeState,
    userText,
    cats,
    history,
    workflowNodes: WORKFLOW_NODES,
  });
  const promptHistory = postContext.promptHistory;
  const workflowTaskPrompt = postContext.workflowTaskPrompt;

  // Build peer list (all cats except current target)
  const allCatEntries = Object.entries(cats).map(([name, c]) => ({ ...c, cat_name: name }));

  async function runSingleCat(cat, promptModeState, extraMeta = {}) {
    const { provider, model, settingsFile } = resolveProviderForCat(cat, models);
    const peerCats = allCatEntries.filter((c) => c.cat_name !== cat.cat_name);
    const prompt = buildModePrompt(mode, cat, promptUserText, promptHistory, peerCats, promptModeState);
    const catLabel = cat.display_name || cat.cat_name;
    writeRuntimeLog("chat", "start", {
      thread: threadId,
      cat: catLabel,
      node: extraMeta.workflow_node || "-",
      provider,
      model: model || "-",
    });
    emitLiveAgentState({
      agent_key: cat.cat_name,
      role: "chat",
      stage: extraMeta.workflow_node || "chat",
      display_name: catLabel,
      state: "thinking",
    });

    const t0 = Date.now();
    let result;
    try {
      result = await executeProviderText({
        provider,
        model,
        settingsFile,
        prompt,
        timeoutMs,
        streamOutput: true,
        eventMeta: { cat_name: cat.cat_name, mode: "chat", ...extraMeta },
        abortSignal,
        onLiveEvent: (event) => {
          emitLiveAgentEvent({
            agent_key: cat.cat_name,
            role: "chat",
            stage: extraMeta.workflow_node || "chat",
            display_name: catLabel,
            event,
          });
        },
      });
    } catch (err) {
      emitLiveAgentState({
        agent_key: cat.cat_name,
        role: "chat",
        stage: extraMeta.workflow_node || "chat",
        display_name: catLabel,
        state: "error",
        error: err?.code === "ABORTED" ? "aborted" : String(err?.message || "provider_error"),
      });
      throw err;
    }
    const durationMs = Date.now() - t0;
    writeRuntimeLog("chat", "done", {
      thread: threadId,
      cat: catLabel,
      node: extraMeta.workflow_node || "-",
      duration_ms: durationMs,
      exit_code: Number.isFinite(Number(result?.exit?.code)) ? Number(result.exit.code) : "null",
      signal: result?.exit?.signal || "-",
      error: result?.error_class || "-",
    });

    const usageData = result.usage || {};
    const catMsg = createMessage({
      sender: cat.display_name || cat.cat_name,
      sender_type: "cat",
      cat_name: cat.cat_name,
      text: result.text || "(无回复)",
      provider,
      model,
      duration_ms: usageData.duration_ms ?? durationMs,
      input_tokens: usageData.usage?.input_tokens ?? null,
      output_tokens: usageData.usage?.output_tokens ?? null,
      cost_usd: usageData.total_cost_usd ?? null,
    });
    appendMessage(logsRoot, threadId, catMsg, effectiveThreadSlug);
    history.push(catMsg);
    emitLiveAgentState({
      agent_key: cat.cat_name,
      role: "chat",
      stage: extraMeta.workflow_node || "chat",
      display_name: catLabel,
      state: result?.error_class ? "error" : "done",
      input_tokens: usageData.usage?.input_tokens ?? null,
      output_tokens: usageData.usage?.output_tokens ?? null,
      cost_usd: usageData.total_cost_usd ?? null,
      error: result?.error_class || null,
    });

    return {
      cat_name: cat.cat_name,
      display_name: cat.display_name,
      avatar: cat.avatar,
      color: cat.color,
      message: catMsg,
      run_id: result.runId,
      run_dir: result.runDir,
      exit: result.exit,
      error_class: result.error_class || null,
    };
  }

  if (mode === "workflow") {
    let workingState = modeState && typeof modeState === "object" ? { ...modeState } : {};
    if (!workingState.role_map || typeof workingState.role_map !== "object") {
      workingState = buildWorkflowModeState(roleConfig);
    }
    const maxRounds = Number.isFinite(workingState.max_rounds)
      ? Math.max(1, Math.floor(workingState.max_rounds))
      : 3;
    let mustFix = Array.isArray(workingState.must_fix) ? [...workingState.must_fix] : [];
    let finalOutcome = "max_rounds_reached";
    let executedRounds = 0;
    const catNames = Object.keys(cats);
    const responses = [];
    const stageToRole = {
      coder: "CoreDev",
      reviewer: "Reviewer",
      tester: "Tester",
    };

    function pickCatForRole(roleTitle) {
      const roleMap = workingState.role_map || {};
      const catName = catNames.find((n) => roleMap[n] === roleTitle);
      if (catName && cats[catName]) return { ...cats[catName], cat_name: catName };
      if (catNames[0] && cats[catNames[0]]) return { ...cats[catNames[0]], cat_name: catNames[0] };
      return null;
    }

    function roleProfileForStage(stage, cat) {
      const p = roleConfig?.role_profiles?.[stage] || {};
      const displayName = p.display_name || cat?.display_name || cat?.cat_name || stage;
      const roleTitle = p.role_title || stageToRole[stage] || stage;
      const nickname = p.nickname || cat?.nickname || displayName;
      return {
        display_name: String(displayName),
        role_title: String(roleTitle),
        nickname: String(nickname),
      };
    }

    function peerProfilesForStage(stage) {
      const out = {};
      for (const key of ["coder", "reviewer", "tester"]) {
        if (key === stage) continue;
        const cat = pickCatForRole(stageToRole[key]);
        out[key] = roleProfileForStage(key, cat);
      }
      return out;
    }

    function appendWorkflowMessage(cat, roleStage, text, provider, model, durationMs, meta = {}) {
      const usageData = meta.usage || {};
      const catMsg = createMessage({
        sender: cat.display_name || cat.cat_name,
        sender_type: "cat",
        cat_name: cat.cat_name,
        text: text || "(无回复)",
        provider,
        model,
        duration_ms: usageData.duration_ms ?? durationMs,
        input_tokens: usageData.usage?.input_tokens ?? null,
        output_tokens: usageData.usage?.output_tokens ?? null,
        cost_usd: usageData.total_cost_usd ?? null,
      });
      appendMessage(logsRoot, threadId, catMsg, effectiveThreadSlug);
      history.push(catMsg);
      const payload = {
        cat_name: cat.cat_name,
        display_name: cat.display_name,
        avatar: cat.avatar,
        color: cat.color,
        message: catMsg,
        role_stage: roleStage,
      };
      Object.assign(payload, meta);
      responses.push(payload);
      return catMsg;
    }

    const taskPrompt = workflowTaskPrompt;

    for (let round = 1; round <= maxRounds; round += 1) {
      executedRounds = round;
      const coderCat = pickCatForRole("CoreDev");
      const reviewerCat = pickCatForRole("Reviewer");
      const testerCat = pickCatForRole("Tester");
      if (!coderCat || !reviewerCat || !testerCat) break;

      workingState.current_node = "coder";
      writeRuntimeLog("workflow", "start", {
        round,
        node: "coder",
        cat: coderCat.display_name || coderCat.cat_name,
      });
      emitLiveAgentState({
        agent_key: "coder",
        role: "coder",
        stage: "coder",
        display_name: coderCat.display_name || coderCat.cat_name,
        state: "thinking",
        round,
      });
      const coderProvider = resolveProviderForCat(coderCat, models);
      const coderStart = Date.now();
      const coder = await runCoder({
        provider: coderProvider.provider,
        model: coderProvider.model,
        settingsFile: coderProvider.settingsFile,
        roleProfile: roleProfileForStage("coder", coderCat),
        peerProfiles: peerProfilesForStage("coder"),
        taskPrompt,
        mustFix,
        mode: "implementation",
        timeoutMs,
        eventMeta: {
          cat_name: coderCat.cat_name,
          mode: "chat",
          workflow_node: "coder",
          workflow_round: round,
        },
        abortSignal,
        onLiveEvent: (event) =>
          emitLiveAgentEvent({
            agent_key: "coder",
            role: "coder",
            stage: "coder",
            display_name: coderCat.display_name || coderCat.cat_name,
            round,
            event,
          }),
      });
      const coderDuration = Date.now() - coderStart;
      writeRuntimeLog("workflow", "done", {
        round,
        node: "coder",
        cat: coderCat.display_name || coderCat.cat_name,
        duration_ms: coderDuration,
        exit_code: Number.isFinite(Number(coder?.exit?.code)) ? Number(coder.exit.code) : "null",
        signal: coder?.exit?.signal || "-",
        error: coder?.error_class || "-",
      });
      appendWorkflowMessage(
        coderCat,
        "coder",
        coder.text,
        coderProvider.provider,
        coderProvider.model,
        coderDuration,
        {
          run_id: coder.runId,
          run_dir: coder.runDir,
          exit: coder.exit,
          error_class: coder.error_class || null,
          usage: coder.usage,
        }
      );
      if (!isProviderRunOk(coder) || !String(coder.text || "").trim()) {
        emitLiveAgentState({
          agent_key: "coder",
          role: "coder",
          stage: "coder",
          display_name: coderCat.display_name || coderCat.cat_name,
          state: "error",
          round,
          error: coder.error_class || "coder_runtime_error",
        });
        finalOutcome = coder.error_class || "coder_runtime_error";
        mustFix = [`Coder failed: ${finalOutcome}`];
        break;
      }
      emitLiveAgentState({
        agent_key: "coder",
        role: "coder",
        stage: "coder",
        display_name: coderCat.display_name || coderCat.cat_name,
        state: "done",
        round,
        input_tokens: coder.usage?.usage?.input_tokens ?? null,
        output_tokens: coder.usage?.usage?.output_tokens ?? null,
        cost_usd: coder.usage?.total_cost_usd ?? null,
      });

      workingState.current_node = "reviewer";
      writeRuntimeLog("workflow", "start", {
        round,
        node: "reviewer",
        cat: reviewerCat.display_name || reviewerCat.cat_name,
      });
      emitLiveAgentState({
        agent_key: "reviewer",
        role: "reviewer",
        stage: "reviewer",
        display_name: reviewerCat.display_name || reviewerCat.cat_name,
        state: "thinking",
        round,
      });
      const reviewerProvider = resolveProviderForCat(reviewerCat, models);
      const reviewerStart = Date.now();
      const reviewer = await runReviewer({
        provider: reviewerProvider.provider,
        model: reviewerProvider.model,
        settingsFile: reviewerProvider.settingsFile,
        roleProfile: roleProfileForStage("reviewer", reviewerCat),
        peerProfiles: peerProfilesForStage("reviewer"),
        taskPrompt,
        coderOutput: coder.text,
        timeoutMs,
        eventMeta: {
          cat_name: reviewerCat.cat_name,
          mode: "chat",
          workflow_node: "reviewer",
          workflow_round: round,
        },
        abortSignal,
        onLiveEvent: (event) =>
          emitLiveAgentEvent({
            agent_key: "reviewer",
            role: "reviewer",
            stage: "reviewer",
            display_name: reviewerCat.display_name || reviewerCat.cat_name,
            round,
            event,
          }),
      });
      const reviewerDuration = Date.now() - reviewerStart;
      writeRuntimeLog("workflow", "done", {
        round,
        node: "reviewer",
        cat: reviewerCat.display_name || reviewerCat.cat_name,
        duration_ms: reviewerDuration,
        exit_code: Number.isFinite(Number(reviewer?.exit?.code)) ? Number(reviewer.exit.code) : "null",
        signal: reviewer?.exit?.signal || "-",
        error: reviewer?.error_class || "-",
      });
      appendWorkflowMessage(
        reviewerCat,
        "reviewer",
        reviewer.text,
        reviewerProvider.provider,
        reviewerProvider.model,
        reviewerDuration,
        {
          run_id: reviewer.runId,
          run_dir: reviewer.runDir,
          exit: reviewer.exit,
          error_class: reviewer.error_class || null,
          usage: reviewer.usage,
        }
      );

      if (!reviewer.ok) {
        emitLiveAgentState({
          agent_key: "reviewer",
          role: "reviewer",
          stage: "reviewer",
          display_name: reviewerCat.display_name || reviewerCat.cat_name,
          state: "error",
          round,
          error: reviewer.error_class || reviewer.parse_error || "review_schema_invalid",
        });
        finalOutcome = reviewer.error_class || "review_schema_invalid";
        mustFix = Array.isArray(reviewer.review?.must_fix) && reviewer.review.must_fix.length
          ? reviewer.review.must_fix
          : ["Reviewer output schema invalid"];
        break;
      }
      emitLiveAgentState({
        agent_key: "reviewer",
        role: "reviewer",
        stage: "reviewer",
        display_name: reviewerCat.display_name || reviewerCat.cat_name,
        state: reviewer.review?.decision === "approve" ? "done" : "replying",
        round,
        input_tokens: reviewer.usage?.usage?.input_tokens ?? null,
        output_tokens: reviewer.usage?.usage?.output_tokens ?? null,
        cost_usd: reviewer.usage?.total_cost_usd ?? null,
      });

      if (reviewer.review?.decision !== "approve") {
        mustFix = Array.isArray(reviewer.review?.must_fix) ? reviewer.review.must_fix : ["Reviewer requested changes"];
        finalOutcome = "review_changes_requested";
        continue;
      }

      workingState.current_node = "tester";
      writeRuntimeLog("workflow", "start", {
        round,
        node: "tester",
        cat: testerCat.display_name || testerCat.cat_name,
      });
      emitLiveAgentState({
        agent_key: "tester",
        role: "tester",
        stage: "tester",
        display_name: testerCat.display_name || testerCat.cat_name,
        state: "thinking",
        round,
      });
      const testerProvider = resolveProviderForCat(testerCat, models);
      const testerStart = Date.now();
      const tester = await runTester({
        provider: testerProvider.provider,
        model: testerProvider.model,
        settingsFile: testerProvider.settingsFile,
        roleProfile: roleProfileForStage("tester", testerCat),
        peerProfiles: peerProfilesForStage("tester"),
        taskPrompt,
        coderOutput: coder.text,
        timeoutMs,
        eventMeta: {
          cat_name: testerCat.cat_name,
          mode: "chat",
          workflow_node: "tester",
          workflow_round: round,
        },
        abortSignal,
        onLiveEvent: (event) =>
          emitLiveAgentEvent({
            agent_key: "tester",
            role: "tester",
            stage: "tester",
            display_name: testerCat.display_name || testerCat.cat_name,
            round,
            event,
          }),
      });
      const testerDuration = Date.now() - testerStart;
      writeRuntimeLog("workflow", "done", {
        round,
        node: "tester",
        cat: testerCat.display_name || testerCat.cat_name,
        duration_ms: testerDuration,
        exit_code: Number.isFinite(Number(tester?.exit?.code)) ? Number(tester.exit.code) : "null",
        signal: tester?.exit?.signal || "-",
        error: tester?.error_class || "-",
      });
      appendWorkflowMessage(
        testerCat,
        "tester",
        tester.text,
        testerProvider.provider,
        testerProvider.model,
        testerDuration,
        {
          run_id: tester.runId,
          run_dir: tester.runDir,
          exit: tester.exit,
          error_class: tester.error_class || null,
          usage: tester.usage,
        }
      );

      if (!tester.ok) {
        emitLiveAgentState({
          agent_key: "tester",
          role: "tester",
          stage: "tester",
          display_name: testerCat.display_name || testerCat.cat_name,
          state: "error",
          round,
          error: tester.error_class || tester.parse_error || "tester_schema_invalid",
        });
        if (tester.error_class) {
          finalOutcome = tester.error_class;
          mustFix = [`Tester provider error: ${tester.error_class}`];
          break;
        }
        finalOutcome = "tester_schema_invalid";
        mustFix = ["Tester output schema invalid"];
        continue;
      }

      const commands = Array.isArray(tester.test_spec?.commands) ? tester.test_spec.commands : [];
      writeRuntimeLog("workflow", "run_tests", {
        round,
        node: "tester",
        commands: commands.length,
      });
      emitLiveAgentState({
        agent_key: "tester",
        role: "tester",
        stage: "tester",
        display_name: testerCat.display_name || testerCat.cat_name,
        state: "tool",
        round,
        test_commands: commands.length,
      });
      const testRunStart = Date.now();
      const testRun = await runTestCommands(commands, {
        timeoutMs: 2 * 60 * 1000,
        cwd: process.cwd(),
        env: process.env,
        allowedPrefixes: DEFAULT_ALLOWED_PREFIXES,
        stopOnFailure: true,
        abortSignal,
        streamOutput: true,
      });
      const testRunDuration = Date.now() - testRunStart;
      const testSummary = [
        "Test Runner:",
        ...testRun.results.map((r) => {
          const suffix = r.ok ? "PASS" : "FAIL";
          return `- ${r.command}: ${suffix} (code=${r.code})`;
        }),
        `all_passed: ${testRun.allPassed}`,
      ].join("\n");
      appendWorkflowMessage(
        testerCat,
        "tester",
        testSummary,
        "local-test-runner",
        null,
        testRunDuration,
        { test_results: testRun }
      );

      if (!testRun.allPassed) {
        emitLiveAgentState({
          agent_key: "tester",
          role: "tester",
          stage: "tester",
          display_name: testerCat.display_name || testerCat.cat_name,
          state: "error",
          round,
          error: "test_failed",
        });
        const failed = testRun.results.find((r) => !r.ok);
        const stderrSnippet = String(failed?.stderr || "").trim().slice(0, 500);
        mustFix = [
          "Tests failed in tester stage",
          failed ? `Failed command: ${failed.command}` : "Unknown test failure",
          stderrSnippet ? `Error output: ${stderrSnippet}` : "",
        ].filter(Boolean);
        finalOutcome = "test_failed";
        continue;
      }

      finalOutcome = "approved";
      mustFix = [];
      emitLiveAgentState({
        agent_key: "tester",
        role: "tester",
        stage: "tester",
        display_name: testerCat.display_name || testerCat.cat_name,
        state: "done",
        round,
        tests_passed: true,
      });
      break;
    }

    workingState = {
      ...workingState,
      current_node: "coder",
      completed_nodes: finalOutcome === "approved" ? WORKFLOW_NODES.map((n) => n.id) : [],
      finished: finalOutcome === "approved",
      max_rounds: maxRounds,
      last_outcome: finalOutcome,
      must_fix: mustFix,
      last_run_rounds: executedRounds,
      updated_at: Date.now(),
    };

    const persisted = updateThreadMode(
      logsRoot,
      threadId,
      "workflow",
      workingState,
      roleConfig,
      effectiveThreadSlug
    );
    return {
      user_message: userMsg,
      responses,
      workflow_state: persisted?.mode_state || workingState,
    };
  }

  // Send to selected cat targets in parallel for non-workflow modes.
  const responses = await Promise.all(effectiveTargets.map((cat) => runSingleCat(cat, modeState)));
  return { user_message: userMsg, responses };
}

module.exports = {
  buildCatLookup,
  parseMentions,
  resolveProviderForCat,
  createThread,
  updateThreadMode,
  updateThreadMeta,
  touchSessionMeta,
  appendMessage,
  readMessages,
  readThreadMeta,
  listThreads,
  sendChatMessage,
};
