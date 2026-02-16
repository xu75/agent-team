"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { URL } = require("node:url");
const { runTask } = require("../src/coordinator");

const ROOT = path.resolve(__dirname, "..");
const UI_ROOT = path.join(ROOT, "ui");
const LOGS_ROOT = path.join(ROOT, "logs");
const CONFIG_ROOT = path.join(ROOT, "config");
const ROLE_CONFIG_FILE = path.join(CONFIG_ROOT, "role-config.json");
const PORT = Number(process.env.UI_PORT || 4173);
const HOST = process.env.UI_HOST || "127.0.0.1";

const STAGES = ["coder", "reviewer", "tester"];
const DEFAULT_STAGE_DUTY = Object.freeze({
  coder: "CoreDev",
  reviewer: "Reviewer",
  tester: "Tester",
});
const ROLE_DUTY_OPTIONS = Object.freeze(["CoreDev", "Reviewer", "Tester"]);

const DEFAULT_ROLE_CONFIG = Object.freeze({
  version: 2,
  models: [
    { id: "claude", name: "Claude", provider: "claude-cli" },
    { id: "codex", name: "Codex", provider: "codex-cli" },
  ],
  stage_assignment: {
    coder: "codex",
    reviewer: "claude",
    tester: "claude",
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
      name: base.name,
      provider: base.provider,
    };
  });

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
    version: 2,
    models: mergedModels,
    stage_assignment: stage,
    role_profiles: roleProfiles,
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
      model: null,
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
      if (!e.name.startsWith("task-")) continue;
      const taskId = e.name.slice("task-".length);
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
      const alertCount =
        unresolved.length +
        (tone === "negative" ? 1 : 0) +
        ((summary.final_outcome || "") === "max_iterations_reached" ? 1 : 0);
      return {
        task_id: summary.task_id || t.taskId,
        date: t.date,
        provider: summary.provider || "unknown",
        final_status: summary.final_status || null,
        final_outcome: summary.final_outcome || null,
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

function appendFollowup(taskDir, text) {
  const line = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
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
  const taskText = safeTextOrEmpty(path.join(taskDir, "task.md")).trim();
  const followups = readFollowups(taskDir);
  const rounds = summary?.rounds || [];
  const roleConfig = normalizeRoleConfig(summary.role_config || readRoleConfig());
  const messages = [];

  if (taskText) {
    messages.push({
      id: `${taskId}-task`,
      role: "task",
      role_label: "铲屎官",
      round: null,
      text: taskText,
      ts: timeline?.transitions?.[0]?.ts || Date.now(),
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

  for (const r of rounds) {
    const round = r.round;
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
    for (let i = rounds.length; i >= 1; i -= 1) {
      const p = path.join(taskDir, "rounds", String(i).padStart(2, "0"), "test-results.txt");
      if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
    }
    return "";
  })();

  return {
    task_id: taskId,
    final_status: summary.final_status || null,
    final_outcome: summary.final_outcome || null,
    current_stage: timeline?.transitions?.length
      ? timeline.transitions[timeline.transitions.length - 1].to
      : null,
    progress: computeProgress(summary, timeline),
    messages,
    latest_test_results: latestTestText,
    unresolved_must_fix: Array.isArray(summary.unresolved_must_fix) ? summary.unresolved_must_fix : [],
    role_config: roleConfig,
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
      return sendJson(res, 200, { tasks: listTasks() });
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

      const summary = await runTask(prompt, {
        provider,
        model,
        maxIterations,
        roleProviders,
        roleProfiles,
        roleConfig: effectiveRoleConfig,
      });
      return sendJson(res, 200, {
        ok: true,
        task_id: summary.task_id,
        summary,
        role_config: effectiveRoleConfig,
      });
    }

    if (p.startsWith("/api/tasks/") && req.method === "POST") {
      const seg = p.split("/").filter(Boolean);
      if (seg.length === 4 && seg[3] === "followup") {
        const taskId = seg[2];
        const task = getTaskDetail(taskId);
        if (!task) return sendJson(res, 404, { error: "task not found" });
        const body = await readRequestJson(req);
        const message = String(body.message || "").trim();
        if (!message) return sendJson(res, 400, { error: "message is required" });
        appendFollowup(task.task_dir, message);

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

        const updated = await runTask(prompt, {
          provider,
          model: body.model ? String(body.model) : summary.model || undefined,
          maxIterations: Math.max(1, maxIterations),
          roleProviders,
          roleProfiles,
          roleConfig: effectiveRoleConfig,
          appendToTask: true,
          taskId,
          taskDir: task.task_dir,
        });

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
        if (!task) return sendJson(res, 404, { error: "task not found" });

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

        const rerun = await runTask(prompt, {
          provider: String(body.provider || summary.provider || "claude-cli"),
          model: body.model ? String(body.model) : summary.model || undefined,
          maxIterations: Number.isFinite(body.maxIterations)
            ? Number(body.maxIterations)
            : Number(summary.max_iterations || 3),
          roleProviders,
          roleProfiles,
          roleConfig: effectiveRoleConfig,
        });

        return sendJson(res, 200, {
          ok: true,
          task_id: rerun.task_id,
          summary: rerun,
          role_config: effectiveRoleConfig,
        });
      }
    }

    if (p.startsWith("/api/tasks/") && req.method === "GET") {
      const seg = p.split("/").filter(Boolean); // api tasks :id ...
      if (seg.length >= 3) {
        const taskId = seg[2];
        const task = getTaskDetail(taskId);
        if (!task) return sendJson(res, 404, { error: "task not found" });

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
