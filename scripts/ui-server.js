"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { URL } = require("node:url");
const { runTask } = require("../src/coordinator");
const {
  createThread,
  updateThreadMode,
  readMessages,
  readThreadMeta,
  listThreads,
  sendChatMessage,
} = require("../src/engine/chat-session");
const { getModes, getMode, isValidMode, advanceWorkflowNode, WORKFLOW_NODES } = require("../src/modes/mode-registry");

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

const STAGES = ["coder", "reviewer", "tester"];
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
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
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

function getTaskDirs() {
  const dates = listDateDirs(LOGS_ROOT);
  const out = [];
  for (const date of dates) {
    const dateDir = path.join(LOGS_ROOT, date);
    const entries = fs.readdirSync(dateDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // 支持 run-{timestamp}-{hash} 和 task-{timestamp}-{hash} 格式的目录名
      let taskId;
      if (e.name.startsWith("run-")) {
        taskId = e.name.slice(4); // "run-".length === 4
      } else if (e.name.startsWith("task-")) {
        taskId = e.name.slice(5); // "task-".length === 5
      } else {
        continue;
      }
      out.push({
        taskId,
        date,
        dir: path.join(dateDir, e.name),
      });
    }
  }
  return out;
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

function listTasks() {
  return getTaskDirs()
    .map((t) => {
      const summaryPath = path.join(t.dir, "summary.json");
      const summary = safeReadJson(summaryPath);
      if (!summary) return null;
      const unresolved = Array.isArray(summary.unresolved_must_fix) ? summary.unresolved_must_fix : [];
      const tone = toneFromOutcome(summary.final_outcome);
      const preview = taskLastPreview(t.dir, summary);
      const updatedTs = taskUpdatedTs(summary, t.dir);
      const projectId = clip(summary.project_id || summary.project || DEFAULT_PROJECT_ID, 64) || DEFAULT_PROJECT_ID;
      const projectName = clip(summary.project_name || summary.workspace_name || DEFAULT_PROJECT_NAME, 96) || DEFAULT_PROJECT_NAME;
      const alertCount =
        unresolved.length +
        (tone === "negative" ? 1 : 0) +
        ((summary.final_outcome || "") === "max_iterations_reached" ? 1 : 0);
      return {
        task_id: summary.task_id || t.taskId,
        project_id: projectId,
        project_name: projectName,
        date: t.date,
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
        timeline_file: summary.timeline_file || path.join(t.dir, "task-timeline.json"),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.updated_ts || 0) - (a.updated_ts || 0));
}

function getTaskDirById(taskId) {
  const all = getTaskDirs();
  const found = all.find((t) => t.taskId === taskId);
  return found ? found.dir : null;
}

function getTaskDetail(taskId) {
  const taskDir = getTaskDirById(taskId);
  if (!taskDir) return null;
  const summary = safeReadJson(path.join(taskDir, "summary.json"));
  const timeline = safeReadJson(path.join(taskDir, "task-timeline.json"));
  const taskMd = fs.existsSync(path.join(taskDir, "task.md"))
    ? fs.readFileSync(path.join(taskDir, "task.md"), "utf8")
    : "";

  return {
    task_id: taskId,
    task_dir: taskDir,
    task_md: taskMd,
    summary,
    timeline,
  };
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

  return {
    ts,
    provider: anyMeta?.meta?.provider || null,
    model: detectModelFromEvents(events),
    cost_usd: usage?.data?.total_cost_usd ?? null,
    duration_ms: usage?.data?.duration_ms ?? null,
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

function buildThreadPrompt(taskDir) {
  const baseTask = safeTextOrEmpty(path.join(taskDir, "task.md")).trim();
  const followups = readFollowups(taskDir);
  if (!followups.length) return baseTask;

  const lines = [];
  lines.push(baseTask || "");
  lines.push("");
  lines.push("Follow-up messages from operator (chronological):");
  followups.forEach((m, idx) => {
    lines.push(`${idx + 1}. ${m.text}`);
  });
  lines.push("");
  lines.push("Please respond to the latest follow-up while respecting prior context.");
  return lines.join("\n").trim();
}

function looksLikeConfirmMessage(text) {
  const s = String(text || "").trim().toLowerCase();
  if (!s) return false;
  return /(^|\s)(confirm|approve|go|ship|实施|开始|执行|确认|按方案|同意|继续)/i.test(s);
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

  try {
    // ---- Chat mode endpoints ----

    if (p === "/api/threads" && req.method === "GET") {
      return sendJson(res, 200, { threads: listThreads(LOGS_ROOT) });
    }

    if (p === "/api/threads" && req.method === "POST") {
      const body = await readRequestJson(req);
      const title = String(body.title || "").trim() || "新对话";
      const mode = body.mode || undefined;
      const roleConfig = readRoleConfig();
      const meta = createThread(LOGS_ROOT, title, mode, roleConfig);
      return sendJson(res, 200, { ok: true, thread: meta });
    }

    if (p.startsWith("/api/threads/") && req.method === "GET") {
      const seg = p.split("/").filter(Boolean);
      if (seg.length === 3) {
        const threadId = seg[2];
        const meta = readThreadMeta(LOGS_ROOT, threadId);
        if (!meta) return sendJson(res, 404, { error: "thread not found" });
        return sendJson(res, 200, meta);
      }
      if (seg.length === 4 && seg[3] === "messages") {
        const threadId = seg[2];
        const messages = readMessages(LOGS_ROOT, threadId);
        return sendJson(res, 200, { thread_id: threadId, messages });
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
      if (!threadId) {
        const preview = message.length > 20 ? message.slice(0, 20) + "..." : message;
        const mode = body.mode || undefined;
        const roleConfig = body.role_config
          ? normalizeRoleConfig(body.role_config)
          : readRoleConfig();
        const meta = createThread(LOGS_ROOT, preview, mode, roleConfig);
        threadId = meta.thread_id;
      }

      const roleConfig = body.role_config
        ? normalizeRoleConfig(body.role_config)
        : readRoleConfig();

      const controller = new AbortController();
      ACTIVE_CHAT_RUNS.set(threadId, { controller, started_at: Date.now() });
      let result;
      try {
        result = await sendChatMessage({
          logsRoot: LOGS_ROOT,
          threadId,
          userText: message,
          roleConfig,
          abortSignal: controller.signal,
        });
      } finally {
        const current = ACTIVE_CHAT_RUNS.get(threadId);
        if (current && current.controller === controller) {
          ACTIVE_CHAT_RUNS.delete(threadId);
        }
      }

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
      const tasks = listTasks();
      // Also include chat threads as conversation entries
      const threads = listThreads(LOGS_ROOT);
      const taskIds = new Set(tasks.map((t) => t.task_id));
      for (const thread of threads) {
        // Skip threads that are already linked to a task
        if (taskIds.has(thread.thread_id)) continue;
        const msgs = readMessages(LOGS_ROOT, thread.thread_id);
        const lastMsg = msgs[msgs.length - 1];
        const firstUserMsg = msgs.find((m) => m.sender_type === "user");
        const title = thread.title || (firstUserMsg ? firstUserMsg.text.slice(0, 28) : "聊天对话");
        const preview = lastMsg ? (lastMsg.text || "").slice(0, 56) : "";
        tasks.push({
          task_id: thread.thread_id,
          project_id: DEFAULT_PROJECT_ID,
          project_name: DEFAULT_PROJECT_NAME,
          date: new Date(thread.created_at || Date.now()).toISOString().slice(0, 10),
          provider: "chat",
          final_status: null,
          final_outcome: null,
          task_title: title.length > 28 ? title.slice(0, 28) + "..." : title,
          rounds: 0,
          unresolved_must_fix: 0,
          status_tone: "neutral",
          updated_ts: lastMsg?.ts || thread.created_at || Date.now(),
          last_preview: preview,
          alert_count: 0,
          _is_thread: true,
          _thread_id: thread.thread_id,
          _thread_mode: thread.mode || "free_chat",
        });
      }
      tasks.sort((a, b) => (b.updated_ts || 0) - (a.updated_ts || 0));
      return sendJson(res, 200, { tasks });
    }

    if (p === "/api/tasks/run" && req.method === "POST") {
      const body = await readRequestJson(req);
      const prompt = String(body.prompt || "").trim();
      if (!prompt) return sendJson(res, 400, { error: "prompt is required" });

      const provider = String(body.provider || "claude-cli");
      const model = body.model ? String(body.model) : undefined;
      const maxIterations = Number.isFinite(body.maxIterations) ? Number(body.maxIterations) : 3;
      const roleConfig = body.role_config ? normalizeRoleConfig(body.role_config) : readRoleConfig();
      const checked = validateNicknameUniqueness(roleConfig);
      if (!checked.ok) return sendJson(res, 400, { error: checked.error });
      const effectiveRoleConfig = checked.roleConfig;
      const roleProviders = stageAssignmentToRoleProviders(effectiveRoleConfig);
      const roleProfiles = stageRoleProfiles(effectiveRoleConfig);

      // Use a temporary key for new task runs so they can be cancelled
      const tempRunKey = `__new_${Date.now()}`;
      const controller = new AbortController();
      ACTIVE_TASK_RUNS.set(tempRunKey, { controller, started_at: Date.now(), kind: "new" });
      let summary;
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
        });
      } finally {
        ACTIVE_TASK_RUNS.delete(tempRunKey);
        // Also register under real task_id if available, then clean up
        if (summary?.task_id) ACTIVE_TASK_RUNS.delete(summary.task_id);
      }
      return sendJson(res, 200, {
        ok: true,
        task_id: summary.task_id,
        summary,
        role_config: effectiveRoleConfig,
      });
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
          if (ACTIVE_CHAT_RUNS.has(taskId)) {
            return sendJson(res, 409, { error: "该会话已有运行进行中，请先终止或等待完成。" });
          }
          const roleConfig = body.role_config ? normalizeRoleConfig(body.role_config) : readRoleConfig();
          const checked = validateNicknameUniqueness(roleConfig);
          if (!checked.ok) return sendJson(res, 400, { error: checked.error });
          const effectiveRoleConfig = checked.roleConfig;
          const controller = new AbortController();
          ACTIVE_CHAT_RUNS.set(taskId, { controller, started_at: Date.now() });
          let result;
          try {
            result = await sendChatMessage({
              logsRoot: LOGS_ROOT,
              threadId: taskId,
              userText: message,
              roleConfig: effectiveRoleConfig,
              abortSignal: controller.signal,
            });
          } finally {
            const current = ACTIVE_CHAT_RUNS.get(taskId);
            if (current && current.controller === controller) {
              ACTIVE_CHAT_RUNS.delete(taskId);
            }
          }
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

        appendFollowup(task.task_dir, message, body.client_message_id || body.clientMessageId || null);

        const summary = task.summary || {};
        const roleConfig = body.role_config ? normalizeRoleConfig(body.role_config) : readRoleConfig();
        const checked = validateNicknameUniqueness(roleConfig);
        if (!checked.ok) return sendJson(res, 400, { error: checked.error });
        const effectiveRoleConfig = checked.roleConfig;
        const roleProviders = stageAssignmentToRoleProviders(effectiveRoleConfig);
        const roleProfiles = stageRoleProfiles(effectiveRoleConfig);
        const maxIterations = Number.isFinite(body.maxIterations) ? Number(body.maxIterations) : 1;
        const provider = String(body.provider || summary.provider || "claude-cli");
        const prompt = buildThreadPrompt(task.task_dir);
        const confirmRequested = body.confirm === true || looksLikeConfirmMessage(message);
        // Even when awaiting operator confirm, allow further /ask discussion rounds.
        // Only /confirm switches execution into implementation mode.

        if (ACTIVE_TASK_RUNS.has(taskId)) {
          return sendJson(res, 409, { error: "该任务已有运行进行中，请先终止或等待完成。" });
        }
        const controller = new AbortController();
        ACTIVE_TASK_RUNS.set(taskId, { controller, started_at: Date.now(), kind: "followup" });
        let updated;
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
        });
        } finally {
          const current = ACTIVE_TASK_RUNS.get(taskId);
          if (current && current.controller === controller) {
            ACTIVE_TASK_RUNS.delete(taskId);
          }
        }

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
          if (ACTIVE_CHAT_RUNS.has(taskId)) {
            return sendJson(res, 409, { error: "该会话已有运行进行中，请先终止或等待完成。" });
          }
          const roleConfig = body.role_config ? normalizeRoleConfig(body.role_config) : readRoleConfig();
          const checked = validateNicknameUniqueness(roleConfig);
          if (!checked.ok) return sendJson(res, 400, { error: checked.error });
          const effectiveRoleConfig = checked.roleConfig;
          const controller = new AbortController();
          ACTIVE_CHAT_RUNS.set(taskId, { controller, started_at: Date.now() });
          let result;
          try {
            result = await sendChatMessage({
              logsRoot: LOGS_ROOT,
              threadId: taskId,
              userText: prompt,
              roleConfig: effectiveRoleConfig,
              abortSignal: controller.signal,
            });
          } finally {
            const current = ACTIVE_CHAT_RUNS.get(taskId);
            if (current && current.controller === controller) {
              ACTIVE_CHAT_RUNS.delete(taskId);
            }
          }
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
        const roleConfig = body.role_config ? normalizeRoleConfig(body.role_config) : readRoleConfig();
        const checked = validateNicknameUniqueness(roleConfig);
        if (!checked.ok) return sendJson(res, 400, { error: checked.error });
        const effectiveRoleConfig = checked.roleConfig;
        const roleProviders = stageAssignmentToRoleProviders(effectiveRoleConfig);
        const roleProfiles = stageRoleProfiles(effectiveRoleConfig);

        const controller = new AbortController();
        ACTIVE_TASK_RUNS.set(taskId, { controller, started_at: Date.now(), kind: "rerun" });
        let rerun;
        try {
          rerun = await runTask(prompt, {
          provider: String(body.provider || summary.provider || "claude-cli"),
          model: body.model ? String(body.model) : summary.model || undefined,
          maxIterations: Number.isFinite(body.maxIterations)
            ? Number(body.maxIterations)
            : Number(summary.max_iterations || 3),
          roleProviders,
          roleProfiles,
          roleConfig: effectiveRoleConfig,
          abortSignal: controller.signal,
        });
        } finally {
          const current = ACTIVE_TASK_RUNS.get(taskId);
          if (current && current.controller === controller) {
            ACTIVE_TASK_RUNS.delete(taskId);
          }
        }

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

        const taskDir = getTaskDirById(taskId);
        if (!taskDir) {
          // Fallback: try to delete as a chat thread
          const threadMeta = readThreadMeta(LOGS_ROOT, taskId);
          if (threadMeta) {
            const threadPath = path.join(LOGS_ROOT, "threads", taskId);
            const resolvedThreadDir = path.resolve(threadPath);
            if (!resolvedThreadDir.startsWith(path.resolve(LOGS_ROOT) + path.sep)) {
              return sendJson(res, 403, { error: "禁止删除任务根目录外的文件" });
            }
            fs.rmSync(threadPath, { recursive: true, force: true });
            return sendJson(res, 200, { ok: true, task_id: taskId, message: "会话已删除" });
          }
          return sendJson(res, 404, { error: "task not found" });
        }

        // 二次校验：确保目标目录在任务根目录内
        const resolvedTaskDir = path.resolve(taskDir);
        if (!resolvedTaskDir.startsWith(LOGS_ROOT + path.sep)) {
          return sendJson(res, 403, { error: "禁止删除任务根目录外的文件" });
        }

        // 检查是否有正在运行的任务
        if (ACTIVE_TASK_RUNS.has(taskId)) {
          return sendJson(res, 409, { error: "该任务正在运行中，请先终止后再删除。" });
        }

        // 递归删除任务目录
        fs.rmSync(taskDir, { recursive: true, force: true });
        return sendJson(res, 200, { ok: true, task_id: taskId, message: "会话已删除" });
      }
    }

    if (p.startsWith("/api/tasks/") && req.method === "GET") {
      const seg = p.split("/").filter(Boolean); // api tasks :id ...
      if (seg.length >= 3) {
        const taskId = seg[2];
        const task = getTaskDetail(taskId);

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
    return sendJson(res, 500, { error: err?.message || String(err) });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`UI server running: http://${HOST}:${PORT}\n`);
});
