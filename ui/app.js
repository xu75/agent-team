const state = {
  tasks: [],
  filtered: [],
  selectedTaskId: null,
  selectedRound: null,
  detail: null,
  messagesData: null,
  liveData: null,
  roleConfig: null,
  busy: false,
  optimisticMessages: [],
  livePollTimer: null,
  livePollBusy: false,
  liveDigest: "",
  liveStream: null,
  liveStreamTaskId: null,
  runningTaskId: null,
  evidenceDrawer: {
    open: false,
    round: null,
    role: null,
    kind: null,
  },
  collapsedProjects: new Set(),
  collapsedThreadGroups: new Set(),
  // 草稿防丢失：key = taskId (或 "__new__" 表示新对话), value = 草稿文本
  drafts: new Map(),
  // 新对话草稿模式
  isNewConversationDraft: false,
  // ---- Chat mode ----
  chatMode: false,          // true = 自由聊天模式, false = 流水线模式
  chatThreadId: null,       // 当前聊天 thread ID
  chatMessages: [],         // 当前任务的聊天消息列表
  chatThreads: [],          // 所有聊天 threads
  // 每个任务的聊天消息缓存：key = taskId, value = { messages: [], threadId: string|null }
  chatPerTask: new Map(),
  chatBusy: false,           // true when a chat request is in-flight (for cancel button)
  // ---- Session mode ----
  availableModes: [],       // [{id, label, icon, desc}, ...]
  currentMode: "free_chat", // 当前 thread 的模式
  currentModeState: {},     // 模式专属状态（如狼人杀角色分配）
  _fetchModeSeq: 0,        // fetchThreadMode 竞态保护序号
  modeDropdownOpen: false,
  mentionSuggest: {
    open: false,
    start: 0,
    end: 0,
    query: "",
    items: [],
    activeIndex: 0,
  },
  // ---- Thread management ----
  threads: [],
  // Backward-compat alias: remove in next cleanup window after all callers migrate.
  projects: [],
  currentProjectId: null,    // null = 全部, string = 过滤到指定项目
  defaultProjectId: null,
  projectDropdownOpen: false,
};

const el = {
  appLayout: document.getElementById("appLayout"),
  taskList: document.getElementById("taskList"),
  taskSearch: document.getElementById("taskSearch"),
  newChatBtn: document.getElementById("newChatBtn"),
  taskTitle: document.getElementById("taskTitle"),
  taskMeta: document.getElementById("taskMeta"),
  flowTaskIdHint: document.getElementById("flowTaskIdHint"),
  timeline: document.getElementById("timeline"),
  roundTag: document.getElementById("roundTag"),
  moreActionsBtn: document.getElementById("moreActionsBtn"),
  moreActionsMenu: document.getElementById("moreActionsMenu"),
  exportReportBtn: document.getElementById("exportReportBtn"),
  exportChatImageBtn: document.getElementById("exportChatImageBtn"),
  cancelRunBtn: document.getElementById("cancelRunBtn"),
  toggleRightPanelBtn: document.getElementById("toggleRightPanelBtn"),
  chatStream: document.getElementById("chatStream"),
  jumpBottomBtn: document.getElementById("jumpBottomBtn"),
  evidenceDrawer: document.getElementById("evidenceDrawer"),
  evidenceDrawerTitle: document.getElementById("evidenceDrawerTitle"),
  evidenceDrawerKinds: document.getElementById("evidenceDrawerKinds"),
  evidenceDrawerBody: document.getElementById("evidenceDrawerBody"),
  evidenceDrawerClose: document.getElementById("evidenceDrawerClose"),
  rightRuntimeHint: document.getElementById("rightRuntimeHint"),
  chatCommandInput: document.getElementById("chatCommandInput"),
  sendCommandBtn: document.getElementById("sendCommandBtn"),
  runTaskStatus: document.getElementById("runTaskStatus"),
  roleConfigPanel: document.getElementById("roleConfigPanel"),
  saveRolesBtn: document.getElementById("saveRolesBtn"),
  liveStage: document.getElementById("liveStage"),
  agentStatus: document.getElementById("agentStatus"),
  stats: document.getElementById("stats"),
  latestFailure: document.getElementById("latestFailure"),
  testResults: document.getElementById("testResults"),
  evidenceMeta: document.getElementById("evidenceMeta"),
  evidenceViewer: document.getElementById("evidenceViewer"),
  mustFixList: document.getElementById("mustFixList"),
  mentionSuggest: document.getElementById("mentionSuggest"),
  projectSelectorBtn: document.getElementById("projectSelectorBtn"),
  projectSelectorName: document.getElementById("projectSelectorName"),
  projectDropdown: document.getElementById("projectDropdown"),
  newProjectBtn: document.getElementById("newProjectBtn"),
  archiveProjectBtn: document.getElementById("archiveProjectBtn"),
  deleteProjectBtn: document.getElementById("deleteProjectBtn"),
  modeSelectorWrap: document.getElementById("modeSelectorWrap"),
  modeSelectorBtn: document.getElementById("modeSelectorBtn"),
  modeSelectorIcon: document.getElementById("modeSelectorIcon"),
  modeSelectorLabel: document.getElementById("modeSelectorLabel"),
  modeDropdown: document.getElementById("modeDropdown"),
  workflowNodeBar: document.getElementById("workflowNodeBar"),
  workflowNodeSteps: document.getElementById("workflowNodeSteps"),
  advanceNodeBtn: document.getElementById("advanceNodeBtn"),
};

let rightPanelCollapsed = false;

const DEFAULT_ROLE_CONFIG = {
  version: 3,
  models: [
    { id: "claude", name: "Claude", provider: "claude-cli" },
    { id: "codex", name: "Codex", provider: "codex-cli" },
    { id: "glm", name: "GLM", provider: "claude-cli", settings_file: "~/.claude/settings_glm.json" },
  ],
  stage_assignment: { coder: "claude", reviewer: "codex", tester: "glm" },
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
};

const STAGES = ["coder", "reviewer", "tester"];
const STAGE_LABELS = {
  coder: "Coder",
  reviewer: "Reviewer",
  tester: "Tester",
};

const DEFAULT_COMPOSER = {
  provider: "claude-cli",
  maxIterations: 3,
};

const DEFAULT_STAGE_DUTY = {
  coder: "CoreDev",
  reviewer: "Reviewer",
  tester: "Tester",
};

const ROLE_DUTY_OPTIONS = ["CoreDev", "Reviewer", "Tester"];

async function requestJson(url, options = {}) {
  const init = { ...options };
  const headers = { ...(options.headers || {}) };
  if (init.body !== undefined && init.body !== null) {
    if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (typeof init.body !== "string") init.body = JSON.stringify(init.body);
  }
  init.headers = headers;

  const res = await fetch(url, init);
  let payload = null;
  try {
    payload = await res.json();
  } catch {}

  if (!res.ok) {
    const err = new Error(payload?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = payload?.code || null;
    err.payload = payload || null;
    throw err;
  }
  return payload || {};
}

async function getJson(url) {
  return requestJson(url);
}

async function postJson(url, body) {
  return requestJson(url, {
    method: "POST",
    body: body || {},
  });
}

async function patchJson(url, body) {
  return requestJson(url, {
    method: "PATCH",
    body: body || {},
  });
}

async function deleteJson(url, body) {
  return requestJson(url, {
    method: "DELETE",
    body: body || {},
  });
}

/**
 * Fire-and-forget: report a client-side error to the server so it appears in logs.
 * Covers errors the server cannot observe (e.g. nginx/frp 504 gateway timeout).
 */
function reportClientError({ action, status, message, task_id }) {
  const body = JSON.stringify({ action, status: status || 0, message, task_id: task_id || "-" });
  try {
    const sent = navigator.sendBeacon(
      "/api/client-error",
      new Blob([body], { type: "application/json" })
    );
    // sendBeacon returns false when queued-data limit exceeded or browser refused;
    // fall back to a keepalive fetch so the error still reaches the server.
    if (!sent) {
      fetch("/api/client-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    }
  } catch {
    // sendBeacon itself threw (e.g. blocked by proxy/CSP) — try fetch fallback.
    try {
      fetch("/api/client-error", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).catch(() => {});
    } catch { /* give up */ }
  }
}

function toneFromOutcome(v) {
  const s = String(v || "").toLowerCase();
  if (!s) return "neutral";
  if (s.includes("approved") || s.includes("pass") || s.includes("success")) return "positive";
  if (s.includes("max_iterations") || s.includes("changes_requested") || s.includes("awaiting_operator_confirm")) return "warning";
  if (s.includes("failed") || s.includes("invalid") || s.includes("error") || s.includes("schema")) {
    return "negative";
  }
  return "neutral";
}

function fmtTime(ts) {
  if (!Number.isFinite(ts)) return "--:--";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtRelativeTime(ts) {
  if (!Number.isFinite(ts)) return "刚刚";
  const now = Date.now();
  const diff = Math.max(0, now - ts);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)}分钟前`;
  if (diff < day) return `今天 ${fmtTime(ts)}`;
  if (diff < day * 2) return `昨天 ${fmtTime(ts)}`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${fmtTime(ts)}`;
}

function fmtCost(v) {
  if (!Number.isFinite(v)) return null;
  return `$${v.toFixed(4)}`;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return null;
  const totalMs = Math.max(0, Math.round(Number(ms)));
  if (totalMs < 1000) return `${totalMs}ms`;

  if (totalMs < 60 * 1000) {
    const sec = (totalMs / 1000).toFixed(1).replace(/\.0$/, "");
    return `${sec}s`;
  }

  if (totalMs < 60 * 60 * 1000) {
    const totalSec = Math.floor(totalMs / 1000);
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return `${minutes}m${seconds}s`;
  }

  const totalMin = Math.floor(totalMs / (60 * 1000));
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  return `${hours}h${minutes}m`;
}

function previewLine(t) {
  let raw = String(t?.last_preview || "").trim();
  if (!raw) return "暂无预览";
  // 如果是 JSON 格式，尝试提取有意义的文本
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      // 尝试提取常见字段
      if (parsed.text) raw = String(parsed.text).trim();
      else if (parsed.message) raw = String(parsed.message).trim();
      else if (parsed.content) raw = String(parsed.content).trim();
      else if (parsed.summary) raw = String(parsed.summary).trim();
      else if (parsed.decision) raw = `评审: ${parsed.decision}`;
      else if (parsed.test_plan) raw = String(parsed.test_plan).trim();
      else raw = "暂无预览";
    } catch {
      // 不是有效 JSON，显示为暂无预览
      raw = "暂无预览";
    }
  }
  return raw.length > 56 ? `${raw.slice(0, 56)}...` : raw;
}

function taskTitleLine(t) {
  const title = String(t?.task_title || "").trim();
  if (title) return title;
  const fallback = String(t?.last_preview || "").trim();
  if (fallback) return fallback.length > 24 ? `${fallback.slice(0, 24)}...` : fallback;
  return "未命名任务";
}

function outcomeNaturalText(outcome) {
  const s = String(outcome || "").toLowerCase();
  if (!s) return "处理中";
  if (s.includes("approved") || s.includes("pass")) return "评审通过";
  if (s.includes("changes_requested")) return "待修改";
  if (s.includes("max_iterations")) return "达到最大轮次";
  if (s.includes("failed") || s.includes("error") || s.includes("invalid")) return "执行失败";
  return "处理中";
}

function taskStatusLine(t) {
  const cfg = activeRoleConfig();
  const coder = cfg?.role_profiles?.coder || {};
  const nickname = String(coder.nickname || coder.display_name || "猫猫");
  const status = outcomeNaturalText(t?.final_outcome);
  if (status === "评审通过") return `${nickname}完成了 · ${status}`;
  return `${nickname}处理中 · ${status}`;
}

function roundsLabel(rounds) {
  const n = Math.max(0, Number(rounds || 0));
  if (!n) return "";
  return `${n}轮`;
}

function normalizeProjectId(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "") || "default";
}

function setThreads(nextThreads) {
  const threads = Array.isArray(nextThreads) ? nextThreads : [];
  state.threads = threads;
  // Phase-1 dual-write: keep state.projects alive for compatibility.
  state.projects = threads;
}

function taskProjectInfo(t, threadById = null) {
  const rawThreadId = String(t?.thread_id || "").trim();
  if (rawThreadId) {
    const mapped = threadById instanceof Map ? threadById.get(rawThreadId) : null;
    const mappedName = String(mapped?.thread_name || mapped?.project_name || mapped?.name || "").trim();
    const fallbackName = String(t?.thread_name || t?.project_name || rawThreadId).trim();
    return {
      id: `thread:${rawThreadId}`,
      name: mappedName || fallbackName || rawThreadId,
      thread_id: rawThreadId,
      unassigned: false,
    };
  }
  return {
    id: "thread:unassigned",
    name: "未分配",
    thread_id: null,
    unassigned: true,
  };
}

function roleAvatar(role, catName) {
  if (role === "coder") return stageRoleAvatar("coder") || "🛠";
  if (role === "reviewer") return stageRoleAvatar("reviewer") || "🔍";
  if (role === "tester") return stageRoleAvatar("tester") || "🧪";
  if (role === "task") return "📌";
  if (role === "chat") return catAvatarFor(catName);
  return "•";
}

function stageRoleAvatar(stageRole) {
  const cfg = activeRoleConfig();
  const cats = cfg?.cats;
  if (!cats || typeof cats !== "object") return null;
  const profile = cfg?.role_profiles?.[stageRole] || {};
  const candidates = [
    profile.display_name,
    profile.nickname,
  ]
    .map((x) => String(x || "").trim().toLowerCase())
    .filter(Boolean);
  if (candidates.length === 0) return null;

  for (const [name, cat] of Object.entries(cats)) {
    const aliases = Array.isArray(cat?.aliases) ? cat.aliases : [];
    const keys = [
      name,
      cat?.display_name,
      cat?.nickname,
      ...aliases,
    ]
      .map((x) => String(x || "").trim().toLowerCase())
      .filter(Boolean);
    if (candidates.some((x) => keys.includes(x)) && cat?.avatar) {
      return cat.avatar;
    }
  }
  return null;
}

function metaLine(m) {
  const parts = [];
  if (m.provider) parts.push(m.provider);
  if (m.model) parts.push(m.model);
  if (Number.isFinite(m.input_tokens) || Number.isFinite(m.output_tokens)) {
    parts.push(`in ${m.input_tokens ?? 0} · out ${m.output_tokens ?? 0}`);
  }
  if (fmtCost(m.cost_usd)) parts.push(fmtCost(m.cost_usd));
  if (Number.isFinite(m.duration_ms)) parts.push(fmtDuration(m.duration_ms));
  return parts.join(" · ");
}

function tryParseJsonLoose(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {}
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function summarizeReviewerMessage(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (!("decision" in obj) || !Array.isArray(obj.must_fix)) return null;
  const decision = obj.decision === "approve" ? "通过" : "需修改";
  const mustFix = obj.must_fix || [];
  const nice = Array.isArray(obj.nice_to_have) ? obj.nice_to_have : [];
  const tests = Array.isArray(obj.tests) ? obj.tests : [];
  const security = Array.isArray(obj.security) ? obj.security : [];
  const lines = [];
  lines.push(`评审结论：${decision}`);
  lines.push(`必须修复：${mustFix.length} 项`);
  if (mustFix.length) {
    mustFix.slice(0, 3).forEach((x, i) => lines.push(`${i + 1}. ${x}`));
    if (mustFix.length > 3) lines.push(`... 还有 ${mustFix.length - 3} 项`);
  }
  lines.push(`建议优化：${nice.length} 项`);
  lines.push(`测试建议：${tests.length} 项`);
  lines.push(`安全建议：${security.length} 项`);
  return lines.join("\n");
}

function summarizeTesterMessage(obj) {
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.test_plan !== "string" || !Array.isArray(obj.commands)) return null;
  const cmds = obj.commands || [];
  const exp = Array.isArray(obj.expected_results) ? obj.expected_results : [];
  const lines = [];
  lines.push("测试方案摘要：");
  lines.push(obj.test_plan.trim() || "(空)");
  lines.push("");
  lines.push(`命令数：${cmds.length}`);
  cmds.slice(0, 3).forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  if (cmds.length > 3) lines.push(`... 还有 ${cmds.length - 3} 条`);
  lines.push(`预期结果：${exp.length} 条`);
  return lines.join("\n");
}

function renderMessageText(m) {
  const role = String(m?.role || "");
  const text = String(m?.text || "");
  if (!text.trim()) return "";
  if (role === "reviewer") {
    const parsed = tryParseJsonLoose(text);
    return summarizeReviewerMessage(parsed) || text;
  }
  if (role === "tester") {
    const parsed = tryParseJsonLoose(text);
    return summarizeTesterMessage(parsed) || text;
  }
  return text;
}

function showToast(text, kind = "neutral") {
  let box = document.getElementById("toastHost");
  if (!box) {
    box = document.createElement("div");
    box.id = "toastHost";
    box.className = "toast-host";
    document.body.appendChild(box);
  }
  const t = document.createElement("div");
  t.className = `toast ${kind}`;
  t.textContent = text;
  box.appendChild(t);
  setTimeout(() => t.classList.add("show"), 10);
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 180);
  }, 2200);
}

function showInlineCopyTip(btn, text, kind = "ok") {
  if (!btn) return;
  btn.dataset.tip = String(text || "");
  btn.dataset.tipKind = kind;
  btn.classList.add("show-tip");
  clearTimeout(btn._tipTimer);
  btn._tipTimer = setTimeout(() => {
    btn.classList.remove("show-tip");
    delete btn.dataset.tip;
    delete btn.dataset.tipKind;
  }, 1200);
}

function escapeHtml(v) {
  return String(v || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clipText(v, max = 64) {
  return String(v || "").trim().slice(0, max);
}

function normRoleText(v) {
  return clipText(v).toLowerCase();
}

function uniqueAliasList(values) {
  const out = [];
  const seen = new Set();
  for (const raw of values || []) {
    const t = clipText(raw);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function syncRoleConfigCats(base, stages = STAGES) {
  if (!base || typeof base !== "object" || !base.cats || typeof base.cats !== "object") return base;
  const cats = {};
  for (const [catName, catCfg] of Object.entries(base.cats || {})) {
    cats[catName] = catCfg && typeof catCfg === "object" ? { ...catCfg } : {};
  }
  const roleProfiles = base.role_profiles && typeof base.role_profiles === "object" ? base.role_profiles : {};
  const stageAssignment = base.stage_assignment && typeof base.stage_assignment === "object" ? base.stage_assignment : {};
  const workflowIn = base.workflow_assignment && typeof base.workflow_assignment === "object" ? base.workflow_assignment : {};

  const byName = new Map();
  const byIdentity = new Map();
  const addIdentity = (key, catName) => {
    if (!key || !catName) return;
    const arr = byIdentity.get(key) || [];
    if (!arr.includes(catName)) arr.push(catName);
    byIdentity.set(key, arr);
  };
  for (const [catName, catCfg] of Object.entries(cats)) {
    const nameKey = normRoleText(catName);
    if (nameKey) byName.set(nameKey, catName);
    const displayKey = normRoleText(catCfg.display_name);
    const nickKey = normRoleText(catCfg.nickname);
    if (displayKey) addIdentity(displayKey, catName);
    if (nickKey) addIdentity(nickKey, catName);
    const aliases = Array.isArray(catCfg.aliases) ? catCfg.aliases : [];
    for (const alias of aliases) {
      const k = normRoleText(alias);
      if (k) addIdentity(k, catName);
    }
  }

  const workflowOut = { ...workflowIn };
  const used = new Set();
  for (const stage of stages) {
    const profile = roleProfiles[stage] && typeof roleProfiles[stage] === "object" ? roleProfiles[stage] : {};
    const displayName = clipText(profile.display_name);
    const nickname = clipText(profile.nickname);

    let catName = "";
    const explicit = clipText(workflowIn[stage]);
    if (explicit && cats[explicit] && !used.has(explicit)) {
      catName = explicit;
    } else {
      const keys = [normRoleText(displayName), normRoleText(nickname)].filter(Boolean);
      for (const key of keys) {
        const hit = byName.get(key);
        if (hit && cats[hit] && !used.has(hit)) {
          catName = hit;
          break;
        }
      }
      if (!catName) {
        for (const key of keys) {
          const hits = byIdentity.get(key) || [];
          const hit = hits.find((n) => cats[n] && !used.has(n));
          if (hit) {
            catName = hit;
            break;
          }
        }
      }
      if (!catName) {
        for (const key of keys) {
          const hit = byName.get(key);
          if (hit && cats[hit]) {
            catName = hit;
            break;
          }
          const hits = byIdentity.get(key) || [];
          const any = hits.find((n) => cats[n]);
          if (any) {
            catName = any;
            break;
          }
        }
      }
    }

    if (!catName || !cats[catName]) continue;
    used.add(catName);
    workflowOut[stage] = catName;
    const catCfg = cats[catName];
    const stageModelId = clipText(stageAssignment[stage], 128);
    if (stageModelId) catCfg.model_id = stageModelId;
    if (displayName) catCfg.display_name = displayName;
    if (nickname) catCfg.nickname = nickname;
    catCfg.aliases = uniqueAliasList([
      ...(Array.isArray(catCfg.aliases) ? catCfg.aliases : []),
      displayName,
      nickname,
    ]);
  }

  return {
    ...base,
    cats,
    workflow_assignment: workflowOut,
  };
}

function normalizeRoleConfig(input) {
  const base = JSON.parse(JSON.stringify(DEFAULT_ROLE_CONFIG));
  if (!input || typeof input !== "object") return base;
  const arr = Array.isArray(input.models) ? input.models : [];
  base.models = base.models.map((m) => {
    const found = arr.find((x) => x?.id === m.id) || {};
    return {
      id: m.id,
      name: found.name || m.name,
      provider: found.provider || m.provider,
      model: found.model || m.model || undefined,
      settings_file: found.settings_file || m.settings_file || undefined,
    };
  });
  // Add any input models not in defaults (e.g. glm)
  for (const m of arr) {
    if (!m || !m.id) continue;
    if (base.models.some((x) => x.id === m.id)) continue;
    base.models.push({
      id: m.id,
      name: m.name || m.id,
      provider: m.provider || "claude-cli",
      model: m.model || undefined,
      settings_file: m.settings_file || undefined,
    });
  }
  const valid = new Set(base.models.map((m) => m.id));
  const st = input.stage_assignment && typeof input.stage_assignment === "object"
    ? input.stage_assignment
    : {};
  for (const k of STAGES) {
    const v = String(st[k] || "");
    base.stage_assignment[k] = valid.has(v) ? v : base.stage_assignment[k];
  }

  const rpIn = input.role_profiles && typeof input.role_profiles === "object" ? input.role_profiles : {};

  function legacyNickname(stage, fallbackNick) {
    for (const source of STAGES) {
      if (source === stage) continue;
      const srcProfile = rpIn[source];
      const srcAliases = srcProfile?.aliases;
      const old = srcAliases && typeof srcAliases === "object" ? srcAliases[stage] : "";
      if (String(old || "").trim()) return clipText(old);
    }
    return clipText(fallbackNick);
  }

  for (const stage of STAGES) {
    const inP = rpIn[stage] && typeof rpIn[stage] === "object" ? rpIn[stage] : {};
    const defaults = base.role_profiles[stage];
    const roleTitleRaw = String(inP.role_title || inP.role || defaults.role_title || DEFAULT_STAGE_DUTY[stage]).trim();
    const roleTitle = ROLE_DUTY_OPTIONS.includes(roleTitleRaw) ? roleTitleRaw : DEFAULT_STAGE_DUTY[stage];
    const displayName = clipText(inP.display_name || inP.name || defaults.display_name || STAGE_LABELS[stage]);
    const nickname = clipText(
      inP.nickname || inP.alias || legacyNickname(stage, defaults.nickname || displayName || STAGE_LABELS[stage])
    );
    base.role_profiles[stage] = {
      display_name: displayName,
      role_title: roleTitle,
      nickname: nickname || displayName,
    };
  }
  // Preserve cats config from input
  if (input.cats && typeof input.cats === "object") {
    base.cats = input.cats;
  }
  return syncRoleConfigCats(base, STAGES);
}

function modelMap() {
  const cfg = state.roleConfig || DEFAULT_ROLE_CONFIG;
  return new Map((cfg.models || []).map((m) => [m.id, m]));
}

function validateNicknameUniqueness(roleConfig) {
  const cfg = normalizeRoleConfig(roleConfig);
  const seen = new Map();
  for (const stage of STAGES) {
    const nick = clipText(cfg.role_profiles?.[stage]?.nickname);
    if (!nick) {
      return { ok: false, error: `${STAGE_LABELS[stage]} 的昵称不能为空。` };
    }
    const key = nick.toLowerCase();
    const prevStage = seen.get(key);
    if (prevStage && prevStage !== stage) {
      return {
        ok: false,
        error: `昵称“${nick}”重复：${STAGE_LABELS[prevStage]} 与 ${STAGE_LABELS[stage]} 不能同名。`,
      };
    }
    seen.set(key, stage);
  }
  return { ok: true, error: "" };
}

function activeRoleConfig() {
  return normalizeRoleConfig(state.messagesData?.role_config || state.roleConfig || DEFAULT_ROLE_CONFIG);
}

function renderRoleConfigPanel() {
  const cfg = normalizeRoleConfig(state.roleConfig || DEFAULT_ROLE_CONFIG);
  const mkOptions = (selectedId) =>
    (cfg.models || [])
      .map(
        (m) =>
          `<option value="${escapeHtml(m.id)}" ${m.id === selectedId ? "selected" : ""}>${escapeHtml(m.name)}</option>`
      )
      .join("");

  const dutyOptions = ROLE_DUTY_OPTIONS.map((d) => `<option value="${d}">${d}</option>`).join("");

  function card(stage, label) {
    const p = cfg.role_profiles?.[stage] || {};
    const displayName = p.display_name || "";
    const roleTitle = ROLE_DUTY_OPTIONS.includes(p.role_title) ? p.role_title : DEFAULT_STAGE_DUTY[stage];
    const nickname = p.nickname || displayName || label;
    return `
      <div class="role-profile-card">
        <div class="card-head">${escapeHtml(label)}</div>
        <label>模型<select data-stage-select="${stage}">${mkOptions(cfg.stage_assignment?.[stage])}</select></label>
        <label>名称<input data-profile-name="${stage}" value="${escapeHtml(displayName)}" /></label>
        <label>职责<select data-profile-duty="${stage}">${dutyOptions}</select></label>
        <label>昵称<input data-profile-nickname="${stage}" value="${escapeHtml(nickname)}" /></label>
      </div>
    `;
  }

  el.roleConfigPanel.innerHTML = `
    ${card("coder", STAGE_LABELS.coder)}
    ${card("reviewer", STAGE_LABELS.reviewer)}
    ${card("tester", STAGE_LABELS.tester)}
  `;
  for (const stage of STAGES) {
    const duty = cfg.role_profiles?.[stage]?.role_title || DEFAULT_STAGE_DUTY[stage];
    const sel = el.roleConfigPanel.querySelector(`[data-profile-duty="${stage}"]`);
    if (sel) sel.value = ROLE_DUTY_OPTIONS.includes(duty) ? duty : DEFAULT_STAGE_DUTY[stage];
  }
}

function collectRoleConfigFromPanel() {
  const cfg = normalizeRoleConfig(state.roleConfig || DEFAULT_ROLE_CONFIG);
  const stage = { ...cfg.stage_assignment };
  for (const key of STAGES) {
    const sel = el.roleConfigPanel.querySelector(`[data-stage-select="${key}"]`);
    if (sel?.value) stage[key] = sel.value;
  }
  cfg.stage_assignment = stage;

  for (const role of STAGES) {
    const nameInput = el.roleConfigPanel.querySelector(`[data-profile-name="${role}"]`);
    const dutySelect = el.roleConfigPanel.querySelector(`[data-profile-duty="${role}"]`);
    const nicknameInput = el.roleConfigPanel.querySelector(`[data-profile-nickname="${role}"]`);
    const displayName =
      clipText(nameInput?.value || cfg.role_profiles[role].display_name || STAGE_LABELS[role]) ||
      cfg.role_profiles[role].display_name;
    const dutyRaw = String(dutySelect?.value || cfg.role_profiles[role].role_title || "").trim();
    const duty = ROLE_DUTY_OPTIONS.includes(dutyRaw) ? dutyRaw : DEFAULT_STAGE_DUTY[role];
    const nickname = clipText(nicknameInput?.value || cfg.role_profiles[role].nickname || displayName);
    cfg.role_profiles[role].display_name =
      displayName || cfg.role_profiles[role].display_name;
    cfg.role_profiles[role].role_title = duty;
    cfg.role_profiles[role].nickname = nickname || displayName;
  }

  return normalizeRoleConfig(cfg);
}

async function loadRoleConfig() {
  const data = await getJson("/api/roles");
  state.roleConfig = normalizeRoleConfig(data?.role_config);
  renderRoleConfigPanel();
  if (state.selectedTaskId) {
    renderChat();
    renderAgentStatus();
    syncComposerWithCurrentTask();
  }
}

async function saveRoleConfig() {
  try {
    const next = collectRoleConfigFromPanel();
    const validity = validateNicknameUniqueness(next);
    if (!validity.ok) throw new Error(validity.error);

    const data = await fetch("/api/roles", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role_config: next }),
    }).then(async (res) => {
      const payload = await res.json().catch(() => null);
      if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
      return payload || {};
    });
    state.roleConfig = normalizeRoleConfig(data.role_config);
    renderRoleConfigPanel();
    showToast("角色配置已保存", "positive");
    renderChat();
    renderAgentStatus();
  } catch (err) {
    showToast(`保存失败：${err.message}`, "negative");
  }
}

function displayRoleLabel(stageRole, fallback) {
  const cfg = activeRoleConfig();
  const p = cfg?.role_profiles?.[stageRole];
  if (p?.display_name || p?.role_title) {
    return `${p.display_name || stageRole} · ${p.role_title || stageRole}`;
  }
  return fallback || stageRole;
}

function setRunStatus(text = "", running = false) {
  el.runTaskStatus.className = running ? "run-status running" : "run-status";
  el.runTaskStatus.textContent = text;
}

function updateActionAvailability() {
  const hasTask = !!state.selectedTaskId;
  const busy = !!state.busy;
  const currentThread = state.threads.find((p) => p.thread_id === state.currentProjectId) || null;
  const canCancelTask = !!state.selectedTaskId && state.runningTaskId === state.selectedTaskId;
  const canCancelChat = busy && state.chatBusy;
  const canCancel = canCancelTask || canCancelChat;
  const setDisabled = (node, value) => {
    if (node) node.disabled = value;
  };
  el.sendCommandBtn.disabled = busy;
  if (el.newChatBtn) el.newChatBtn.disabled = busy;
  el.chatCommandInput.disabled = busy;
  setDisabled(el.exportReportBtn, busy || !hasTask);
  setDisabled(el.exportChatImageBtn, busy || !hasTask);
  setDisabled(el.cancelRunBtn, !canCancel);
  setDisabled(el.moreActionsBtn, busy || !hasTask);
  setDisabled(el.saveRolesBtn, busy);
  setDisabled(el.archiveProjectBtn, busy || !currentThread || !!currentThread.archived);
  setDisabled(el.deleteProjectBtn, busy || !currentThread);
}

function setBusy(v) {
  state.busy = v;
  if (v) hideMentionSuggest();
  updateActionAvailability();
}

function isNearBottom(node) {
  if (!node) return true;
  return node.scrollHeight - node.scrollTop - node.clientHeight < 64;
}

function updateJumpBottomVisibility() {
  const shouldShow = !isNearBottom(el.chatStream);
  el.jumpBottomBtn.classList.toggle("show", shouldShow);
}

function buildLiveDigest(detail, messagesData, liveData = null) {
  const summary = detail?.summary || {};
  const messages = messagesData?.messages || [];
  const last = messages[messages.length - 1] || {};
  const unresolved = Array.isArray(messagesData?.unresolved_must_fix)
    ? messagesData.unresolved_must_fix.length
    : 0;
  const live = liveData || {};
  const liveAgents = live?.agents && typeof live.agents === "object"
    ? Object.entries(live.agents)
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
        .map(([k, v]) => {
          const statePart = String(v?.state || "");
          const tokenPart = `${Number(v?.input_tokens || 0)}/${Number(v?.output_tokens || 0)}`;
          const tsPart = Number(v?.updated_at || 0);
          return `${k}:${statePart}:${tokenPart}:${tsPart}`;
        })
        .join(",")
    : "";
  return [
    summary.final_status || "",
    summary.final_outcome || "",
    Array.isArray(summary.rounds) ? summary.rounds.length : 0,
    messages.length,
    last.id || "",
    Number(last.ts || 0),
    Number(last.ok === false ? -1 : last.ok === true ? 1 : 0),
    messagesData?.current_stage || "",
    messagesData?.final_outcome || "",
    unresolved,
    live?.running ? 1 : 0,
    live?.current_stage || "",
    liveAgents,
  ].join("|");
}

function taskGroups(tasks) {
  const map = new Map();
  for (const t of tasks) {
    const key = t.date || "未知日期";
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(t);
  }
  return Array.from(map.entries());
}

function projectTaskGroups(tasks) {
  const threadById = new Map(
    state.threads.map((p) => [String(p.thread_id || "").trim(), p])
  );
  const map = new Map();
  for (const t of tasks) {
    const p = taskProjectInfo(t, threadById);
    if (!map.has(p.id)) {
      map.set(p.id, {
        id: p.id,
        name: p.name,
        thread_id: p.thread_id,
        unassigned: !!p.unassigned,
        tasks: [],
      });
    }
    map.get(p.id).tasks.push(t);
  }
  const groups = Array.from(map.values())
    .map((p) => {
      p.tasks.sort((a, b) => (b.updated_ts || 0) - (a.updated_ts || 0));
      return p;
    })
    .sort((a, b) => (b.tasks[0]?.updated_ts || 0) - (a.tasks[0]?.updated_ts || 0));
  const nameCounts = new Map();
  for (const g of groups) {
    const key = String(g.name || "").trim().toLowerCase();
    if (!key) continue;
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }
  for (const g of groups) {
    const key = String(g.name || "").trim().toLowerCase();
    const duplicated = key && (nameCounts.get(key) || 0) > 1;
    g.display_name = duplicated && g.thread_id
      ? `${g.name} (${g.thread_id})`
      : g.name;
  }
  return groups;
}

function threadGroupCollapseKey(group) {
  const threadId = String(group?.thread_id || "").trim();
  return threadId ? `thread:${threadId}` : "thread:unassigned";
}

function threadGroupCollapseKeyForTask(task) {
  return threadGroupCollapseKey(taskProjectInfo(task));
}

function expandThreadGroupForTask(taskId, tasks = state.tasks) {
  if (state.currentProjectId !== null || !taskId) return;
  const target = Array.isArray(tasks) ? tasks.find((t) => t.task_id === taskId) : null;
  if (!target) return;
  state.collapsedThreadGroups.delete(threadGroupCollapseKeyForTask(target));
}

function expandThreadGroupByThreadId(threadId) {
  const id = String(threadId || "").trim();
  if (!id) return;
  state.collapsedThreadGroups.delete(`thread:${id}`);
}

function renderTasks() {
  el.taskList.innerHTML = "";

  // 如果处于新对话草稿模式，在顶部显示"新对话"条目
  if (state.isNewConversationDraft) {
    const newRow = document.createElement("div");
    newRow.className = "task-item active";
    newRow.innerHTML = `
      <div class="task-head">
        <div class="task-title">✨ 新对话</div>
        <span class="mini-time">草稿</span>
      </div>
      <div class="preview">输入内容后发送创建...</div>
    `;
    el.taskList.appendChild(newRow);
  }

  if (!state.filtered.length && !state.isNewConversationDraft) {
    el.taskList.innerHTML =
      '<div class="empty-block">暂无任务。先运行一次 <code>node src/index.js "你的任务"</code> 生成日志。</div>';
    return;
  }

  const searchActive = !!String(el.taskSearch?.value || "").trim();
  const canCollapseGroups = state.currentProjectId === null;

  // 扁平化列表：按项目分组，项目名作为分隔标题，对话直接列出
  const projects = projectTaskGroups(state.filtered);
  projects.forEach((project) => {
    const groupKey = threadGroupCollapseKey(project);
    const persistedCollapsed = canCollapseGroups && state.collapsedThreadGroups.has(groupKey);
    // Invariant: search only overrides collapsed visibility in this render path.
    // Never mutate collapsedThreadGroups during search, so clearing search can restore user preference.
    const renderedCollapsed = canCollapseGroups && !searchActive && persistedCollapsed;

    // 项目标题行
    const projectHeader = document.createElement(canCollapseGroups ? "button" : "div");
    projectHeader.className = `thread-header project-header${canCollapseGroups ? " collapsible" : ""}${renderedCollapsed ? " collapsed" : ""}${searchActive ? " search-forced-open" : ""}`;
    if (canCollapseGroups) {
      projectHeader.type = "button";
      projectHeader.setAttribute("aria-expanded", String(!renderedCollapsed));
      projectHeader.setAttribute("aria-disabled", String(searchActive));
      projectHeader.dataset.groupKey = groupKey;
    }
    projectHeader.innerHTML = `
      ${canCollapseGroups ? `<span class="thread-collapse-indicator project-collapse-indicator" aria-hidden="true">${renderedCollapsed ? "▶" : "▼"}</span>` : ""}
      <span class="thread-name project-name" title="${escapeHtml(project.thread_id || project.name)}">${escapeHtml(project.display_name || project.name)}</span>
      <span class="thread-count project-count">${project.tasks.length}</span>
    `;
    if (canCollapseGroups) {
      projectHeader.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (searchActive) return;
        if (state.collapsedThreadGroups.has(groupKey)) state.collapsedThreadGroups.delete(groupKey);
        else state.collapsedThreadGroups.add(groupKey);
        renderTasks();
      });
    }
    el.taskList.appendChild(projectHeader);

    if (renderedCollapsed) return;

    // 直接列出该项目下的所有对话
    project.tasks.forEach((t) => {
      const row = document.createElement("div");
      const isActive = !state.isNewConversationDraft && t.task_id === state.selectedTaskId;
      row.className = `task-item${isActive ? " active" : ""}`;
      row.innerHTML = `
        <div class="task-head">
          <div class="task-title" title="${escapeHtml(t.task_id)}">${escapeHtml(taskTitleLine(t))}</div>
          <button class="task-delete-btn" data-task-id="${escapeHtml(t.task_id)}" title="删除会话" aria-label="删除会话">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z"/>
            </svg>
          </button>
          <span class="mini-time">${fmtRelativeTime(t.updated_ts)}</span>
        </div>
        <div class="preview">${escapeHtml(previewLine(t))}</div>
      `;
      row.addEventListener("click", (e) => {
        // 如果点击的是删除按钮，不触发选中
        if (e.target.closest(".task-delete-btn")) return;
        selectTask(t.task_id);
      });
      const deleteBtn = row.querySelector(".task-delete-btn");
      if (deleteBtn) {
        deleteBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          deleteConversation(t.task_id);
        });
      }
      el.taskList.appendChild(row);
    });
  });
}

function applyFilter() {
  const q = el.taskSearch.value.trim().toLowerCase();
  state.filtered = state.tasks.filter((t) => {
    if (!q) return true;
    const p = taskProjectInfo(t);
    return (
      String(t.thread_name || t.project_name || "").toLowerCase().includes(q) ||
      String(t.thread_id || t.project_id || "").toLowerCase().includes(q) ||
      String(p.name || "").toLowerCase().includes(q) ||
      t.task_id.toLowerCase().includes(q) ||
      String(t.task_title || "").toLowerCase().includes(q) ||
      String(t.provider).toLowerCase().includes(q) ||
      String(t.final_outcome).toLowerCase().includes(q) ||
      String(t.last_preview || "").toLowerCase().includes(q)
    );
  });
  renderTasks();
}

function renderTimeline() {
  const transitions = state.detail?.timeline?.transitions || [];
  el.timeline.innerHTML = "";
  if (!transitions.length) {
    el.timeline.innerHTML = '<div class="timeline-empty">暂无状态迁移事件。</div>';
    return;
  }

  transitions.forEach((t) => {
    const chip = document.createElement("button");
    chip.className = `timeline-chip state-${String(t.to || "").toLowerCase()}`;
    if (Number.isFinite(t.round) && state.selectedRound === t.round) chip.classList.add("active");
    chip.innerHTML = `
      <span class="n">${t.label}</span>
      <span class="m">R${t.round ?? "-"} · ${fmtTime(t.ts)}</span>
    `;
    if (Number.isFinite(t.round)) {
      chip.addEventListener("click", () => {
        state.selectedRound = state.selectedRound === t.round ? null : t.round;
        renderRoundTag();
        renderTimeline();
        renderChat();
        renderRoundTestResults().catch(() => {});
      });
    }
    el.timeline.appendChild(chip);
  });
}

function chatMessageToPipelineFormat(m) {
  const isUser = m.sender_type === "user";
  const chatRoleLabel = !isUser
    ? (m.cat_name ? catDisplayName(m.cat_name) : String(m.sender || m.cat_name || "猫猫"))
    : "铲屎官";
  const msg = {
    id: m.id,
    role: isUser ? "task" : "chat",
    role_label: chatRoleLabel,
    round: null,
    ts: m.ts || Date.now(),
    text: m.text || "",
    ok: null,
    cat_name: m.cat_name || null,
    _is_chat: true,
  };
  if (m.provider) msg.provider = m.provider;
  if (m.model) msg.model = m.model;
  if (Number.isFinite(m.input_tokens)) msg.input_tokens = m.input_tokens;
  if (Number.isFinite(m.output_tokens)) msg.output_tokens = m.output_tokens;
  if (Number.isFinite(m.cost_usd)) msg.cost_usd = m.cost_usd;
  if (Number.isFinite(m.duration_ms)) msg.duration_ms = m.duration_ms;
  return msg;
}

function filteredMessages() {
  const all = state.messagesData?.messages || [];
  const existingIds = new Set(all.map((m) => String(m.id || "")));
  const pending = state.optimisticMessages.filter(
    (m) =>
      String(m.task_id || "") === String(state.selectedTaskId || "") &&
      !existingIds.has(String(m.id || ""))
  );
  // Only keep optimistic inline chat messages; persisted thread messages come from messagesData.
  const chatInline = state.chatMessages
    .filter((m) => !!m?._optimistic)
    .map(chatMessageToPipelineFormat)
    .filter((m) => !existingIds.has(String(m.id || "")));
  const merged = [...all, ...pending, ...chatInline].sort((a, b) => {
    const ta = Number.isFinite(a.ts) ? a.ts : 0;
    const tb = Number.isFinite(b.ts) ? b.ts : 0;
    if (ta !== tb) return ta - tb;
    const ra = Number.isFinite(a.round) ? a.round : -1;
    const rb = Number.isFinite(b.round) ? b.round : -1;
    if (ra !== rb) return ra - rb;
    return String(a.role || "").localeCompare(String(b.role || ""));
  });
  if (!Number.isFinite(state.selectedRound)) return merged;
  return merged.filter((m) => m.round === state.selectedRound || m.role === "task" || m._is_chat);
}

function removeOptimisticMessage(msgId) {
  state.optimisticMessages = state.optimisticMessages.filter((m) => String(m.id || "") !== String(msgId || ""));
}

function applyLiveSnapshot(taskId, live) {
  if (!taskId || state.selectedTaskId !== taskId) return false;
  if (!live || typeof live !== "object") return false;
  const prevLive = state.liveData;
  state.liveData = live;
  const nextDigest = buildLiveDigest(state.detail, state.messagesData, live);
  if (nextDigest === state.liveDigest) return false;
  state.liveDigest = nextDigest;
  renderLiveStage();
  renderAgentStatus();
  if (el.rightRuntimeHint && !state.isNewConversationDraft) {
    const summary = state.detail?.summary || {};
    const current = live.current_stage || state.messagesData?.current_stage || summary.final_status || "-";
    const runningTag = live.running ? "运行中" : "空闲";
    el.rightRuntimeHint.textContent = `${summary.provider || "-"} · ${current} · ${runningTag}`;
  }

  // When any agent reaches done/error, fetch messages immediately so chat stream
  // updates one-by-one instead of waiting for periodic polling.
  const prevAgents = prevLive?.agents && typeof prevLive.agents === "object" ? prevLive.agents : {};
  const currAgents = live?.agents && typeof live.agents === "object" ? live.agents : {};
  let hasTerminalTransition = false;
  for (const key of Object.keys(currAgents)) {
    const prevState = String(prevAgents?.[key]?.state || "");
    const currState = String(currAgents?.[key]?.state || "");
    if (currState !== prevState && (currState === "done" || currState === "error")) {
      hasTerminalTransition = true;
      break;
    }
  }
  if (hasTerminalTransition) {
    refreshTaskLive(taskId, { includeLive: false }).catch(() => {});
  }

  if (!live.running && String(state.runningTaskId || "") === String(taskId)) {
    const finishedTitle = taskTitleLine(state.tasks.find((t) => t.task_id === taskId)) || taskId;
    const outcome = String(state.detail?.summary?.final_outcome || live?.status || "").toLowerCase();
    state.runningTaskId = null;
    if (outcome === "canceled") {
      setRunStatus(`已终止：${finishedTitle}`, false);
    } else if (outcome && outcome !== "idle") {
      setRunStatus(`已完成：${finishedTitle} (${outcome})`, false);
    } else {
      setRunStatus(`已完成：${finishedTitle}`, false);
    }
    updateActionAvailability();
    loadTasks().catch(() => {});
  }

  if (!live.running && state.liveStreamTaskId && String(state.liveStreamTaskId) === String(taskId)) {
    stopLivePolling();
  }
  return true;
}

function stopLiveStream() {
  if (state.liveStream) {
    try {
      state.liveStream.close();
    } catch {}
    state.liveStream = null;
    state.liveStreamTaskId = null;
  }
}

function startLiveStream(taskId) {
  if (!taskId) return false;
  if (typeof EventSource === "undefined") return false;
  stopLiveStream();
  const es = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/live/stream`);
  state.liveStream = es;
  state.liveStreamTaskId = taskId;
  es.addEventListener("live", (ev) => {
    if (state.liveStream !== es) return;
    let data = null;
    try {
      data = JSON.parse(String(ev.data || ""));
    } catch {
      data = null;
    }
    if (!data) return;
    applyLiveSnapshot(taskId, data);
  });
  es.onerror = () => {
    if (state.liveStream !== es) return;
    // EventSource will auto-reconnect; fallback polling keeps snapshot fresh.
  };
  return true;
}

async function refreshTaskLive(taskId, opts = {}) {
  if (!taskId || state.livePollBusy) return;
  const includeLive = opts.includeLive !== false;
  state.livePollBusy = true;
  try {
    const reqs = [
      getJson(`/api/tasks/${taskId}`),
      getJson(`/api/tasks/${taskId}/messages`),
    ];
    if (includeLive) {
      reqs.push(getJson(`/api/tasks/${taskId}/live`).catch(() => null));
    }
    const [detail, messages, liveMaybe] = await Promise.all(reqs);
    if (state.selectedTaskId !== taskId) return;
    const live = includeLive ? (liveMaybe || null) : state.liveData;
    const nextDigest = buildLiveDigest(detail, messages, live);
    const changed = nextDigest !== state.liveDigest;
    state.detail = detail;
    state.messagesData = messages;
    if (includeLive) state.liveData = live;
    if (!changed) return;
    state.liveDigest = nextDigest;
    renderTaskPage({ preserveEvidence: true });
  } catch {
    // keep polling; transient errors are expected while background run is active
  } finally {
    state.livePollBusy = false;
  }
}

function stopLivePolling() {
  stopLiveStream();
  if (state.livePollTimer) {
    clearInterval(state.livePollTimer);
    state.livePollTimer = null;
  }
}

function startLivePolling(taskId) {
  stopLivePolling();
  const hasSse = startLiveStream(taskId);
  refreshTaskLive(taskId, { includeLive: !hasSse }).catch(() => {});
  state.livePollTimer = setInterval(() => {
    refreshTaskLive(taskId, { includeLive: !hasSse }).catch(() => {});
  }, hasSse ? 3000 : 1000);
}

function evidenceKindsForRole(role) {
  if (role === "coder") return ["output", "events", "raw", "run"];
  if (role === "reviewer") return ["json", "meta", "events", "raw", "output"];
  if (role === "tester") return ["json", "tests", "tests_json", "events", "raw", "output"];
  return [];
}

function renderEvidencePlaceholder() {
  el.evidenceMeta.textContent = "点击消息卡里的 Evidence 按钮查看。";
  el.evidenceViewer.className = "plain-block warning";
  el.evidenceViewer.textContent = "暂无证据内容。";
}

function setEvidenceDrawerOpen(open) {
  state.evidenceDrawer.open = !!open;
  el.evidenceDrawer.classList.toggle("show", !!open);
  el.evidenceDrawer.setAttribute("aria-hidden", open ? "false" : "true");
}

function renderEvidenceDrawerKinds(kinds, activeKind, round, role) {
  el.evidenceDrawerKinds.innerHTML = (kinds || [])
    .map(
      (kind) =>
        `<button class="chip ${kind === activeKind ? "active" : ""}" data-drawer-kind="${kind}" data-drawer-round="${round}" data-drawer-role="${role}">${kind}</button>`
    )
    .join("");
}

async function openEvidenceDrawer(round, role, preferredKind = null) {
  const kinds = evidenceKindsForRole(role);
  if (!kinds.length) return;
  const kind = preferredKind && kinds.includes(preferredKind) ? preferredKind : kinds[0];
  state.evidenceDrawer.round = round;
  state.evidenceDrawer.role = role;
  state.evidenceDrawer.kind = kind;
  setEvidenceDrawerOpen(true);
  el.evidenceDrawerTitle.textContent = `${role} · R${round}`;
  renderEvidenceDrawerKinds(kinds, kind, round, role);
  el.evidenceDrawerBody.className = "drawer-body";
  el.evidenceDrawerBody.textContent = "加载中...";

  try {
    const ev = await getJson(
      `/api/tasks/${state.selectedTaskId}/evidence?round=${round}&role=${encodeURIComponent(
        role
      )}&kind=${encodeURIComponent(kind)}`
    );
    el.evidenceDrawerBody.className = "drawer-body";
    if (kind === "events" || kind === "raw") el.evidenceDrawerBody.classList.add("warning");
    if (kind === "tests" || kind === "tests_json") el.evidenceDrawerBody.classList.add("positive");
    if (kind === "meta" || kind === "json") el.evidenceDrawerBody.classList.add("neutral");
    el.evidenceDrawerBody.textContent = ev.content || "";
    openEvidence(round, role, kind).catch(() => {});
  } catch (err) {
    el.evidenceDrawerBody.className = "drawer-body negative";
    el.evidenceDrawerBody.textContent = `加载证据失败: ${err.message}`;
  }
}

async function openEvidence(round, role, kind) {
  if (!state.selectedTaskId) return;
  try {
    const ev = await getJson(
      `/api/tasks/${state.selectedTaskId}/evidence?round=${round}&role=${encodeURIComponent(
        role
      )}&kind=${encodeURIComponent(kind)}`
    );
    el.evidenceMeta.textContent = `${role} · R${round} · ${ev.file}`;
    el.evidenceViewer.className = "plain-block";
    if (kind === "events" || kind === "raw") el.evidenceViewer.classList.add("warning");
    if (kind === "tests" || kind === "tests_json") el.evidenceViewer.classList.add("positive");
    if (kind === "meta" || kind === "json") el.evidenceViewer.classList.add("neutral");
    el.evidenceViewer.textContent = ev.content || "";
  } catch (err) {
    el.evidenceMeta.textContent = `${role} · R${round} · ${kind}`;
    el.evidenceViewer.className = "plain-block negative";
    el.evidenceViewer.textContent = `加载证据失败: ${err.message}`;
  }
}

function renderChat() {
  const messages = filteredMessages();
  const messageMap = new Map();
  const prev = el.chatStream;
  const prevScrollTop = prev.scrollTop;
  const nearBottom = isNearBottom(prev);
  el.chatStream.innerHTML = "";
  if (!messages.length) {
    const emptyText = state.isNewConversationDraft
      ? "输入内容后发送，将自动创建新对话。使用 @猫名 可直接发起 mention 对话。"
      : "当前筛选条件下没有消息。";
    el.chatStream.innerHTML = `<div class="empty-block">${escapeHtml(emptyText)}</div>`;
    updateJumpBottomVisibility();
    return;
  }
  const groups = [];
  for (const m of messages) {
    const g = groups[groups.length - 1];
    const sameRole = g && g.role === m.role;
    // For chat messages, also require same cat to avoid grouping different cats
    const sameCat = !m._is_chat || (g && g.catName === m.cat_name);
    const sameRound =
      g &&
      ((Number.isFinite(g.round) && Number.isFinite(m.round) && g.round === m.round) ||
        (!Number.isFinite(g.round) && !Number.isFinite(m.round)));
    const nearTs = g && Math.abs((m.ts || 0) - (g.lastTs || 0)) <= 5 * 60 * 1000;
    if (sameRole && sameCat && sameRound && nearTs) {
      g.messages.push(m);
      g.lastTs = m.ts || g.lastTs;
    } else {
      groups.push({
        role: m.role,
        round: Number.isFinite(m.round) ? m.round : null,
        roleLabel:
          m.role === "chat"
            ? (m.cat_name ? catDisplayName(m.cat_name) : String(m.role_label || "猫猫"))
            : displayRoleLabel(m.role, m.role_label),
        catName: m.cat_name || null,
        firstTs: m.ts || Date.now(),
        lastTs: m.ts || Date.now(),
        messages: [m],
      });
    }
  }

  let prevIsChat = false;
  groups.forEach((g, gi) => {
    const isChat = g.role === "chat" || (g.role === "task" && g.messages.some((m) => m._is_chat));
    prevIsChat = isChat;

    const block = document.createElement("article");
    block.className = `chat-group role-${g.role}`;
    block.innerHTML = `
      <header class="group-head">
        <div class="lhs">
          <span class="avatar">${roleAvatar(g.role, g.catName)}</span>
          <span class="role"${g.role === "chat" && g.catName ? ` style="color:${catColorFor(g.catName)}"` : ""}>${escapeHtml(g.roleLabel)}</span>
          ${Number.isFinite(g.round) ? `<span class="round">R${g.round}</span>` : ""}
          <time class="group-time">${fmtTime(g.firstTs)}</time>
        </div>
      </header>
      <div class="group-body"></div>
    `;
    const body = block.querySelector(".group-body");

    g.messages.forEach((m, idx) => {
      const msgId = String(m.id || `${m.role}-${m.round ?? "na"}-${m.ts ?? Date.now()}-${idx}`);
      messageMap.set(msgId, m);
      const statusDot = m.ok === false ? "status-bad" : m.ok === true ? "status-ok" : "status-idle";
      const evidenceButtons =
        Number.isFinite(m.round) && m.role !== "task"
          ? `<button class="btn evidence-open-btn" data-round="${m.round}" data-role="${m.role}">证据</button>`
          : "";
      const meta = metaLine(m);
      const detailLine =
        m.role !== "task" && (meta || evidenceButtons)
          ? `
            <div class="msg-detailline">
              ${meta ? `<span class="detail-meta">${escapeHtml(meta)}</span>` : ""}
              ${evidenceButtons ? `<span class="detail-actions">${evidenceButtons}</span>` : ""}
            </div>
          `
          : "";
      const renderedText = renderMessageText(m);
      const rawText = String(renderedText || "");
      const lineCount = rawText.split("\n").length;
      const collapsible = rawText.length > 700 || lineCount > 18;
      const mdHtml =
        typeof marked !== "undefined" && typeof DOMPurify !== "undefined"
          ? DOMPurify.sanitize(marked.parse(rawText))
          : `<pre>${escapeHtml(rawText)}</pre>`;
      const textHtml = collapsible
        ? `<div class="msg-text msg-markdown collapsed" data-collapsible="1">${mdHtml}</div>
           <button class="toggle-expand" data-expand-btn="1">展开全文</button>`
        : `<div class="msg-text msg-markdown">${mdHtml}</div>`;
      const bubble = document.createElement("div");
      bubble.className = "msg-bubble";
      bubble.innerHTML = `
        <div class="bubble-top"><span class="dot ${statusDot}"></span></div>
        <button class="copy-msg-btn" data-copy-msg="${escapeHtml(msgId)}" title="复制消息" aria-label="复制消息">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M9 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Zm-4 6H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
        ${textHtml}
      `;
      body.appendChild(bubble);
      if (detailLine) {
        const detail = document.createElement("div");
        detail.innerHTML = detailLine;
        body.appendChild(detail.firstElementChild);
      }
    });
    el.chatStream.appendChild(block);
  });

  Array.from(el.chatStream.querySelectorAll(".ev-btn")).forEach((btn) => {
    btn.remove();
  });

  Array.from(el.chatStream.querySelectorAll(".evidence-open-btn")).forEach((btn) => {
    btn.addEventListener("click", () => {
      const round = Number(btn.dataset.round);
      const role = String(btn.dataset.role || "");
      if (!Number.isFinite(round) || !role) return;
      if (state.evidenceDrawer.open) {
        const sameTarget =
          state.evidenceDrawer.round === round && state.evidenceDrawer.role === role;
        if (sameTarget) {
          setEvidenceDrawerOpen(false);
          return;
        }
      }
      openEvidenceDrawer(round, role).catch(() => {});
    });
  });

  Array.from(el.chatStream.querySelectorAll(".copy-msg-btn")).forEach((btn) => {
    btn.addEventListener("click", async () => {
      const msgId = String(btn.dataset.copyMsg || "");
      const msg = messageMap.get(msgId);
      const text = String(msg?.text || "").trim();
      if (!text) {
        showInlineCopyTip(btn, "无内容", "warn");
        return;
      }
      try {
        await navigator.clipboard.writeText(text);
        showInlineCopyTip(btn, "已复制", "ok");
      } catch {
        showInlineCopyTip(btn, "复制失败", "error");
      }
    });
  });

  Array.from(el.chatStream.querySelectorAll("[data-expand-btn='1']")).forEach((btn) => {
    btn.addEventListener("click", () => {
      const pre = btn.parentElement?.querySelector(".msg-text");
      if (!pre) return;
      const expanded = pre.classList.toggle("expanded");
      pre.classList.toggle("collapsed", !expanded);
      btn.textContent = expanded ? "收起" : "展开全文";
    });
  });

  if (nearBottom) {
    el.chatStream.scrollTop = el.chatStream.scrollHeight;
  } else {
    const maxTop = Math.max(0, el.chatStream.scrollHeight - el.chatStream.clientHeight);
    el.chatStream.scrollTop = Math.min(prevScrollTop, maxTop);
  }
  updateJumpBottomVisibility();
}

function renderRoundTag() {
  if (!el.roundTag) return;
  if (Number.isFinite(state.selectedRound)) {
    el.roundTag.textContent = `Round ${state.selectedRound}`;
  } else {
    el.roundTag.textContent = "All Rounds";
  }
}

function renderLiveStage() {
  const live = state.liveData;
  if (live && live.agents && typeof live.agents === "object") {
    const agents = Object.values(live.agents);
    const runningStates = new Set(["thinking", "tool", "replying", "running"]);
    const activeCount = agents.filter((a) => runningStates.has(String(a?.state || ""))).length;
    const totalIn = agents.reduce((sum, a) => sum + (Number(a?.input_tokens) || 0), 0);
    const totalOut = agents.reduce((sum, a) => sum + (Number(a?.output_tokens) || 0), 0);
    const totalCost = agents.reduce((sum, a) => sum + (Number(a?.cost_usd) || 0), 0);
    const runtime = live.running ? "运行中" : "空闲";
    const tone = live.running ? "warning" : toneFromOutcome(live.final_outcome);
    el.liveStage.innerHTML = `
      <div class="stage-card ${tone}">
        <div class="k">Current Stage</div>
        <div class="v">${live.current_stage || "-"}</div>
        <div class="k">Runtime</div>
        <div class="v">${runtime}</div>
        <div class="k">Active Agents</div>
        <div class="v">${activeCount} / ${agents.length}</div>
        <div class="k">Tokens</div>
        <div class="v">in ${totalIn} · out ${totalOut}</div>
        <div class="k">Cost</div>
        <div class="v">${fmtCost(totalCost) || "$0.0000"}</div>
      </div>
    `;
    return;
  }

  const current = state.messagesData?.current_stage || state.detail?.summary?.final_status || "-";
  const threadStatus = state.detail?.summary?.final_status || current || "-";
  const outcome = state.messagesData?.final_outcome || state.detail?.summary?.final_outcome || "-";
  const tone = toneFromOutcome(outcome);
  const progress = state.messagesData?.progress || {};
  const threadRounds = Number.isFinite(progress.thread_rounds) ? progress.thread_rounds : progress.rounds_total ?? 0;
  const latestDone = Number.isFinite(progress.latest_run_rounds) ? progress.latest_run_rounds : progress.rounds_total ?? 0;
  const latestTotal = Number.isFinite(progress.latest_run_max) ? progress.latest_run_max : progress.rounds_max ?? "-";

  el.liveStage.innerHTML = `
    <div class="stage-card ${tone}">
      <div class="k">Thread Status</div>
      <div class="v">${threadStatus}</div>
      <div class="k">Latest Run</div>
      <div class="v">${current}</div>
      <div class="k">Latest Progress</div>
      <div class="v">${latestDone} / ${latestTotal}</div>
      <div class="k">Thread Rounds</div>
      <div class="v">${threadRounds}</div>
    </div>
  `;
}

function renderAgentStatus() {
  const live = state.liveData;
  if (live && live.agents && typeof live.agents === "object" && Object.keys(live.agents).length > 0) {
    const stateText = (s) => {
      const v = String(s || "idle");
      if (v === "thinking") return "思考中";
      if (v === "tool") return "工具调用";
      if (v === "replying") return "回复中";
      if (v === "running") return "运行中";
      if (v === "done") return "完成";
      if (v === "error") return "异常";
      return "空闲";
    };
    const stateClass = (s) => {
      const v = String(s || "idle");
      if (v === "error") return "error";
      if (v === "done") return "ok";
      if (v === "thinking" || v === "tool" || v === "replying" || v === "running") return "running";
      return "idle";
    };

    const keys = Object.keys(live.agents);
    const ordered = [
      ...STAGES.filter((k) => keys.includes(k)),
      ...keys.filter((k) => !STAGES.includes(k)).sort((a, b) => a.localeCompare(b)),
    ];
    const rows = ordered.map((k) => {
      const a = live.agents[k] || {};
      const role = String(a.role || k);
      const name = String(a.display_name || displayRoleLabel(role, role) || k);
      const inTokens = Number(a.input_tokens || 0);
      const outTokens = Number(a.output_tokens || 0);
      const cost = fmtCost(Number(a.cost_usd || 0)) || "$0.0000";
      return `
        <div class="agent-row">
          <span class="name">${STAGES.includes(role) ? roleAvatar(role) : "🐱"} ${escapeHtml(name)}</span>
          <span class="state ${stateClass(a.state)}">${stateText(a.state)}</span>
          <span class="meta">in ${inTokens} · out ${outTokens} · ${cost}</span>
        </div>
      `;
    });
    el.agentStatus.innerHTML = rows.join("");
    return;
  }

  const messages = state.messagesData?.messages || [];
  const latest = { coder: null, reviewer: null, tester: null };
  for (const m of messages) {
    if (!STAGES.includes(m.role)) continue;
    if (!latest[m.role] || (m.ts || 0) >= (latest[m.role].ts || 0)) {
      latest[m.role] = m;
    }
  }

  const rows = STAGES.map((role) => {
    const m = latest[role];
    const status = !m ? "idle" : m.ok === false ? "error" : m.ok === true ? "ok" : "running";
    return `
      <div class="agent-row">
        <span class="name">${roleAvatar(role)} ${displayRoleLabel(role, role)}</span>
        <span class="state ${status}">${status}</span>
      </div>
    `;
  });
  el.agentStatus.innerHTML = rows.join("");
}

function renderStats() {
  const summary = state.detail?.summary || {};
  const outcomeTone = toneFromOutcome(summary.final_outcome);
  const statusTone = toneFromOutcome(summary.final_status);
  const stats = [
    { k: "Provider", v: summary.provider || "-", cls: "stat" },
    { k: "Outcome", v: summary.final_outcome || "-", cls: `stat emphasis ${outcomeTone}`.trim() },
    { k: "Status", v: summary.final_status || "-", cls: `stat emphasis ${statusTone}`.trim() },
    { k: "Thread Rounds", v: (summary.rounds || []).length, cls: "stat" },
  ];
  el.stats.innerHTML = stats
    .map((x) => `<div class="${x.cls}"><div class="k">${x.k}</div><div class="v">${x.v}</div></div>`)
    .join("");
}

function renderLatestFailure() {
  const messages = state.messagesData?.messages || [];
  const failed = [...messages].reverse().find((m) => m.ok === false);
  if (!failed) {
    el.latestFailure.className = "plain-block positive";
    el.latestFailure.textContent = "暂无失败。";
    return;
  }
  el.latestFailure.className = "plain-block negative";
  el.latestFailure.textContent = `${displayRoleLabel(failed.role, failed.role_label)} R${failed.round ?? "-"}\n${
    failed.text || "unknown failure"
  }`;
}

async function renderRoundTestResults() {
  const taskId = state.selectedTaskId;
  if (!taskId) return;
  if (!Number.isFinite(state.selectedRound)) {
    const latest = state.messagesData?.latest_test_results || "";
    el.testResults.className = "plain-block";
    if (latest.includes("ok: false")) el.testResults.classList.add("negative");
    else if (latest.includes("ok: true")) el.testResults.classList.add("positive");
    else el.testResults.classList.add("warning");
    el.testResults.textContent = latest || "暂无测试结果。";
    return;
  }

  try {
    const r = await getJson(`/api/tasks/${taskId}/rounds/${state.selectedRound}`);
    const txt = r.test_results_text || "";
    el.testResults.className = "plain-block";
    if (txt.includes("ok: false")) el.testResults.classList.add("negative");
    else if (txt.includes("ok: true")) el.testResults.classList.add("positive");
    else el.testResults.classList.add("warning");
    el.testResults.textContent = txt || "该回合没有测试结果。";
  } catch {
    el.testResults.className = "plain-block warning";
    el.testResults.textContent = "该回合没有测试结果。";
  }
}

function renderMustFix() {
  const arr = state.messagesData?.unresolved_must_fix || [];
  el.mustFixList.innerHTML = "";
  if (!arr.length) {
    el.mustFixList.innerHTML = "<li>无</li>";
    return;
  }
  arr.forEach((x) => {
    const li = document.createElement("li");
    li.textContent = x;
    el.mustFixList.appendChild(li);
  });
}

function syncComposerWithCurrentTask() {
  if (state.chatMode) {
    if (!state.busy) {
      el.chatCommandInput.placeholder = "@ 猫猫名字发消息，如：@牛奶 帮我看看这段代码";
    }
    return;
  }
  const summary = state.detail?.summary || {};
  const cfg = state.roleConfig || DEFAULT_ROLE_CONFIG;
  const coderModel = modelMap().get(cfg?.stage_assignment?.coder);
  const provider = coderModel?.provider || summary.provider || DEFAULT_COMPOSER.provider;
  const rounds = Number.isFinite(summary.max_iterations) ? Math.max(1, Math.floor(summary.max_iterations)) : DEFAULT_COMPOSER.maxIterations;
  if (!state.busy) {
    el.chatCommandInput.placeholder =
      `/task --provider ${provider} --rounds ${rounds} 你的任务；/confirm 开始实施；/rerun 继续当前任务`;
  }
}

function renderTaskPage(opts = {}) {
  const preserveEvidence = !!opts.preserveEvidence;
  const summary = state.detail?.summary || {};
  const selected = state.tasks.find((t) => t.task_id === state.selectedTaskId);
  if (state.isNewConversationDraft) {
    el.taskTitle.textContent = "新对话";
    el.taskMeta.className = "meta-pill";
    el.taskMeta.textContent = "草稿";
    if (el.flowTaskIdHint) el.flowTaskIdHint.textContent = "Task: draft";
    if (el.rightRuntimeHint) el.rightRuntimeHint.textContent = "新对话草稿";
  } else {
    el.taskTitle.textContent = String(selected?.task_title || selected?.task_id || "对话");
    el.taskMeta.textContent = `${summary.provider || "-"} · ${summary.final_outcome || "-"}`;
    el.taskMeta.className = `meta-pill ${toneFromOutcome(summary.final_outcome)}`.trim();
    if (el.flowTaskIdHint) el.flowTaskIdHint.textContent = `Task: ${state.selectedTaskId || "-"}`;
    if (el.rightRuntimeHint) {
      const current = state.liveData?.current_stage || state.messagesData?.current_stage || summary.final_status || "-";
      const runningTag = state.liveData?.running ? "运行中" : "空闲";
      el.rightRuntimeHint.textContent = `${summary.provider || "-"} · ${current} · ${runningTag}`;
    }
  }
  renderRoundTag();
  renderTimeline();
  renderChat();
  renderLiveStage();
  renderAgentStatus();
  renderStats();
  renderLatestFailure();
  renderMustFix();
  renderRoundTestResults().catch(() => {});
  setMoreActionsMenu(false);
  if (!preserveEvidence) renderEvidencePlaceholder();
  if (!preserveEvidence) setEvidenceDrawerOpen(false);
  syncComposerWithCurrentTask();
  updateActionAvailability();
  updateJumpBottomVisibility();
}

async function selectTask(taskId) {
  stopLivePolling();
  // 保存当前对话的草稿
  const currentInput = el.chatCommandInput.value.trim();
  if (currentInput) {
    const currentKey = state.isNewConversationDraft ? "__new__" : (state.selectedTaskId || "__new__");
    state.drafts.set(currentKey, currentInput);
  }

  // 退出新对话草稿模式
  exitNewConversationDraftMode();

  // 保存当前任务的聊天消息
  saveChatForCurrentTask();

  state.selectedTaskId = taskId;
  expandThreadGroupForTask(taskId, state.tasks);
  state.selectedRound = null;
  // 恢复目标任务的聊天消息
  await restoreChatForTask(taskId);
  // 如果该任务有关联的 thread，自动恢复 chatMode
  if (state.chatThreadId) {
    state.chatMode = true;
    // 先用缓存值同步渲染（无闪烁），再异步拉取权威值
    const savedMode = restoreTaskMode(taskId);
    safeSetCurrentMode(savedMode);
    fetchThreadMode(state.chatThreadId);
  } else {
    state.chatMode = false;
    // 无 thread 时，从 localStorage 恢复该任务上次选择的模式（白名单校验）
    const savedMode = restoreTaskMode(taskId);
    safeSetCurrentMode(savedMode);
    state.currentModeState = {};
  }
  renderModeSelector();
  renderTasks();

  const [detail, messages, live] = await Promise.all([
    getJson(`/api/tasks/${taskId}`),
    getJson(`/api/tasks/${taskId}/messages`),
    getJson(`/api/tasks/${taskId}/live`).catch(() => null),
  ]);

  state.detail = detail;
  state.messagesData = messages;
  state.liveData = live;
  state.liveDigest = buildLiveDigest(detail, messages, live);
  if (live?.running) {
    startLivePolling(taskId);
  } else if (state.liveStreamTaskId && String(state.liveStreamTaskId) !== String(taskId)) {
    stopLivePolling();
  }
  if (detail?._is_thread) {
    state.chatThreadId = detail._thread_id || taskId;
    state.chatMode = true;
    saveThreadMapping(taskId, state.chatThreadId);
    fetchThreadMode(state.chatThreadId);
  }
  renderTaskPage();

  // 恢复该对话的草稿
  const draft = state.drafts.get(taskId) || "";
  el.chatCommandInput.value = draft;
}

function renderEmptyScreen() {
  stopLivePolling();
  el.taskTitle.textContent = "对话";
  el.taskMeta.className = "meta-pill";
  el.taskMeta.textContent = "暂无任务";
  if (el.flowTaskIdHint) el.flowTaskIdHint.textContent = "Task: -";
  el.timeline.innerHTML = '<div class="timeline-empty">还没有任务数据。</div>';
  if (el.roundTag) el.roundTag.textContent = "All Rounds";
  el.chatStream.innerHTML = '<div class="empty-block">先运行一个任务，然后在这里查看多 Agent 对话回放。</div>';
  el.liveStage.innerHTML = '<div class="stage-card"><div class="k">Current Stage</div><div class="v">-</div></div>';
  el.agentStatus.innerHTML = "";
  el.stats.innerHTML = "";
  el.latestFailure.className = "plain-block warning";
  el.latestFailure.textContent = "暂无失败信息。";
  el.testResults.className = "plain-block warning";
  el.testResults.textContent = "暂无测试结果。";
  el.mustFixList.innerHTML = "<li>无</li>";
  state.liveData = null;
  setMoreActionsMenu(false);
  if (el.rightRuntimeHint) el.rightRuntimeHint.textContent = "空闲";
  renderEvidencePlaceholder();
  setEvidenceDrawerOpen(false);
  updateJumpBottomVisibility();
  updateActionAvailability();
  renderModeSelector();
}

async function loadTasks() {
  const url = state.currentProjectId
    ? `/api/tasks?thread_id=${encodeURIComponent(state.currentProjectId)}`
    : "/api/tasks";
  const data = await getJson(url);
  state.tasks = data.tasks || [];
  applyFilter();
  if (state.filtered.length) {
    const pick =
      state.selectedTaskId && state.filtered.some((t) => t.task_id === state.selectedTaskId)
        ? state.selectedTaskId
        : state.filtered[0].task_id;
    await selectTask(pick);
  } else {
    state.selectedTaskId = null;
    state.detail = null;
    state.messagesData = null;
    state.liveData = null;
    state.liveDigest = "";
    renderEmptyScreen();
  }
}

/* ---- Thread management (was: Project management) ---- */

async function loadProjects() {
  const data = await getJson("/api/threads");
  const mapped = (data.threads || []).map((t) => ({
    thread_id: t.thread_id,
    thread_name: t.name,
    description: t.description,
    created_at: t.created_at,
    updated_at: t.updated_at,
    archived: t.archived,
    session_count: t.session_count || 0,
    visible_count: Number.isFinite(t.visible_count) ? t.visible_count : (t.session_count || 0),
    breakdown: {
      scoped: Number.isFinite(t?.breakdown?.scoped) ? t.breakdown.scoped : 0,
      legacy: Number.isFinite(t?.breakdown?.legacy) ? t.breakdown.legacy : 0,
    },
    // Deprecated aliases; remove after one compatibility window.
    project_id: t.thread_id,
    project_name: t.name,
  }));
  setThreads(mapped);
  state.defaultProjectId = data.default_thread_id || null;
  if (!state.currentProjectId && state.defaultProjectId) {
    state.currentProjectId = state.defaultProjectId;
  }
  renderProjectSelector();
}

function renderProjectSelector() {
  const current = state.threads.find((p) => p.thread_id === state.currentProjectId);
  el.projectSelectorName.textContent = current ? current.thread_name : "全部 Thread";
  updateActionAvailability();
}

function renderProjectDropdown() {
  const dd = el.projectDropdown;
  dd.innerHTML = "";

  // "全部" option
  const allItem = document.createElement("button");
  allItem.className = `thread-dropdown-item project-dropdown-item${!state.currentProjectId ? " active" : ""}`;
  allItem.textContent = "📁 全部 Thread";
  allItem.addEventListener("click", () => switchProject(null));
  dd.appendChild(allItem);

  // Separator
  const sep = document.createElement("div");
  sep.className = "thread-dropdown-sep project-dropdown-sep";
  dd.appendChild(sep);

  // Thread items
  for (const p of state.threads) {
    const item = document.createElement("button");
    const isActive = state.currentProjectId === p.thread_id;
    const isDefault = p.thread_id === state.defaultProjectId;
    item.className = `thread-dropdown-item project-dropdown-item${isActive ? " active" : ""}`;
    const visibleCount = Math.max(0, Number(p.visible_count || 0));
    const scopedCount = Math.max(0, Number(p?.breakdown?.scoped || 0));
    const legacyCount = Math.max(0, Number(p?.breakdown?.legacy || 0));
    const sessionInfo = ` <small>(${visibleCount})</small>`;
    if (legacyCount > 0) {
      item.title = `可见会话 ${visibleCount} = scoped ${scopedCount} + legacy ${legacyCount}`;
    } else {
      item.title = `可见会话 ${visibleCount}`;
    }
    item.innerHTML = `
      <span class="thread-item-name project-item-name">${escapeHtml(p.thread_name)}${isDefault ? " <small>(默认)</small>" : ""}${sessionInfo}</span>
      ${p.archived ? '<span class="thread-archived-tag project-archived-tag">已归档</span>' : ""}
    `;
    item.addEventListener("click", () => switchProject(p.thread_id));
    dd.appendChild(item);
  }
}

function toggleProjectDropdown() {
  state.projectDropdownOpen = !state.projectDropdownOpen;
  el.projectDropdown.setAttribute("aria-hidden", String(!state.projectDropdownOpen));
  if (state.projectDropdownOpen) renderProjectDropdown();
}

async function switchProject(projectId) {
  state.currentProjectId = projectId;
  state.projectDropdownOpen = false;
  el.projectDropdown.setAttribute("aria-hidden", "true");
  renderProjectSelector();
  await loadTasks();
}

async function createNewProject() {
  const name = prompt("输入新 Thread 名称:");
  if (!name || !name.trim()) return;
  const slug = name.trim().toLowerCase().replace(/\s+/g, "-");
  try {
    const res = await postJson("/api/threads", {
      slug,
      name: name.trim(),
    });
    showToast(`Thread "${name.trim()}" 已创建`, "positive");
    await loadProjects();
    await switchProject(res.thread.thread_id);
  } catch (err) {
    showToast(`创建失败：${err.message}`, "negative");
  }
}

function collectThreadAudit(actionLabel, threadName) {
  const operator = prompt(`${actionLabel}操作人(operator):`, "银渐层");
  if (operator === null) return null;
  const reason = prompt(`${actionLabel}原因(reason):`, `operate:${threadName}`);
  if (reason === null) return null;
  return {
    operator: String(operator).trim(),
    reason: String(reason).trim(),
  };
}

function formatThreadActionError(actionLabel, err) {
  if (err?.status === 422) return `${actionLabel}失败：缺少审计字段（operator/reason）。`;
  if (err?.status === 409) {
    return actionLabel.includes("硬删除")
      ? `${actionLabel}失败：请先归档再执行硬删除。`
      : `${actionLabel}失败：资源状态冲突。`;
  }
  if (err?.status === 404) return `${actionLabel}失败：Thread 不存在或已被删除。`;
  return `${actionLabel}失败：${err?.message || "未知错误"}`;
}

async function archiveCurrentProject() {
  const threadId = String(state.currentProjectId || "").trim();
  if (!threadId) {
    showToast("请先选择一个 Thread", "warning");
    return;
  }
  const thread = state.threads.find((p) => p.thread_id === threadId);
  if (!thread) {
    showToast("当前 Thread 不存在", "negative");
    return;
  }
  if (thread.archived) {
    showToast("当前 Thread 已归档", "warning");
    return;
  }
  const audit = collectThreadAudit("归档", thread.thread_name || threadId);
  if (!audit) return;
  try {
    setBusy(true);
    await patchJson(`/api/threads/${encodeURIComponent(threadId)}`, {
      archived: true,
      operator: audit.operator,
      reason: audit.reason,
    });
    showToast(`Thread "${thread.thread_name || threadId}" 已归档`, "positive");
    await loadProjects();
    await loadTasks();
  } catch (err) {
    showToast(formatThreadActionError("归档", err), "negative");
  } finally {
    setBusy(false);
  }
}

async function hardDeleteCurrentProject() {
  const threadId = String(state.currentProjectId || "").trim();
  if (!threadId) {
    showToast("请先选择一个 Thread", "warning");
    return;
  }
  const thread = state.threads.find((p) => p.thread_id === threadId);
  const threadName = thread?.thread_name || threadId;
  if (!thread) {
    showToast("当前 Thread 不存在", "negative");
    return;
  }
  if (threadId === state.defaultProjectId) {
    showToast("默认 Thread 不支持硬删除", "warning");
    return;
  }
  const confirmed = confirm(`确定硬删除 Thread "${threadName}" 吗？\n\n该操作不可撤销。`);
  if (!confirmed) return;
  const audit = collectThreadAudit("硬删除", threadName);
  if (!audit) return;
  try {
    setBusy(true);
    await deleteJson(`/api/threads/${encodeURIComponent(threadId)}`, {
      operator: audit.operator,
      reason: audit.reason,
    });
    if (state.currentProjectId === threadId) {
      state.currentProjectId = state.defaultProjectId || null;
    }
    showToast(`Thread "${threadName}" 已硬删除`, "positive");
    await loadProjects();
    await loadTasks();
  } catch (err) {
    showToast(formatThreadActionError("硬删除", err), "negative");
  } finally {
    setBusy(false);
  }
}

function parseCliLikeCommand(rawLine) {
  const line = String(rawLine || "").trim();
  if (!line) return { kind: "empty" };

  // Detect @猫猫 mentions → chat mode
  const mentionPattern = /@([\u4e00-\u9fff\w]+)/g;
  const mentions = [];
  let mm;
  while ((mm = mentionPattern.exec(line)) !== null) {
    mentions.push(mm[1]);
  }
  if (mentions.length > 0 && !line.startsWith("/")) {
    return { kind: "chat", message: line, mentions };
  }

  if (!line.startsWith("/")) {
    return { kind: "followup", message: line, provider: null, rounds: null, fromSlashCommand: false };
  }

  const m = line.match(/^\/([a-zA-Z0-9_-]+)\s*(.*)$/);
  if (!m) return { kind: "invalid", error: "无法解析命令。" };
  const cmd = m[1].toLowerCase();
  let rest = m[2] || "";

  if (cmd === "help") return { kind: "help" };

  let provider = null;
  let rounds = null;

  function pickArg(pattern) {
    const mm = rest.match(pattern);
    if (!mm) return null;
    rest = `${rest.slice(0, mm.index)} ${rest.slice(mm.index + mm[0].length)}`.trim();
    return mm[1];
  }

  const providerEq = pickArg(/--provider=(claude-cli|codex-cli)\b/i);
  const providerSp = pickArg(/--provider\s+(claude-cli|codex-cli)\b/i);
  provider = (providerEq || providerSp || "").toLowerCase() || null;

  const roundsEq = pickArg(/--rounds=(\d+)\b/i);
  const roundsSp = pickArg(/--rounds\s+(\d+)\b/i);
  const roundsRaw = roundsEq || roundsSp;
  if (roundsRaw) rounds = Math.max(1, Math.floor(Number(roundsRaw)));

  const prompt = rest.trim();

  if (cmd === "task") {
    if (!prompt) return { kind: "invalid", error: "用法：/task [--provider claude-cli|codex-cli] [--rounds N] 任务描述" };
    return { kind: "task", prompt, provider, rounds };
  }

  if (cmd === "rerun") {
    return { kind: "rerun", prompt: prompt || null, provider, rounds };
  }

  if (cmd === "ask" || cmd === "followup") {
    if (!prompt) return { kind: "invalid", error: "用法：/ask [--provider ...] [--rounds N] 追问内容" };
    return { kind: "followup", message: prompt, provider, rounds, fromSlashCommand: true };
  }

  if (cmd === "confirm") {
    return {
      kind: "confirm",
      message: prompt || "确认按方案实施",
      provider,
      rounds,
      confirm: true,
    };
  }

  return { kind: "invalid", error: `未知命令 /${cmd}。可用命令：/task /ask /confirm /rerun /help` };
}

function resolvedProvider(cmdProvider) {
  if (cmdProvider) return cmdProvider;
  const cfg = state.roleConfig || DEFAULT_ROLE_CONFIG;
  const coderModel = modelMap().get(cfg?.stage_assignment?.coder);
  return coderModel?.provider || DEFAULT_COMPOSER.provider;
}

function resolvedRounds(cmdRounds) {
  if (Number.isFinite(cmdRounds)) return Math.max(1, Math.floor(cmdRounds));
  const summary = state.detail?.summary || {};
  if (Number.isFinite(summary.max_iterations)) return Math.max(1, Math.floor(summary.max_iterations));
  return DEFAULT_COMPOSER.maxIterations;
}

function commandHelpText() {
  return [
    "命令用法：",
    "",
    "聊天模式（@ 猫猫自由对话）：",
    "@牛奶 帮我看看这段代码",
    "@咖啡 review 一下这个改动",
    "@Billy 写个测试用例",
    "",
    "流水线模式（自动走 Coder→Reviewer→Tester）：",
    "/task 任务描述",
    "/task --provider codex-cli --rounds 2 修复登录接口",
    "/ask 继续追问（进入当前会话）",
    "/ask --provider claude-cli --rounds 1 这个点再细化一下",
    "/confirm 认可当前方案并开始编码实施",
    "/rerun",
    "/rerun --provider claude-cli --rounds 1 重新执行并缩短输出",
    "/help",
  ].join("\n");
}

function selectedConversationEntry() {
  return state.tasks.find((t) => t.task_id === state.selectedTaskId) || null;
}

function isSelectedThreadConversation() {
  if (state.detail?._is_thread) return true;
  const selected = selectedConversationEntry();
  if (selected?._is_thread) return true;
  return !!(state.chatThreadId && state.selectedTaskId && String(state.chatThreadId) === String(state.selectedTaskId));
}

async function refreshSelectedSessionData(opts = {}) {
  const preserveEvidence = opts.preserveEvidence !== false;
  if (!state.selectedTaskId) return;
  const [detail, messages, live] = await Promise.all([
    getJson(`/api/tasks/${state.selectedTaskId}`),
    getJson(`/api/tasks/${state.selectedTaskId}/messages`),
    getJson(`/api/tasks/${state.selectedTaskId}/live`).catch(() => null),
  ]);
  state.detail = detail;
  state.messagesData = messages;
  state.liveData = live;
  state.liveDigest = buildLiveDigest(detail, messages, live);
  if (live?.running) {
    startLivePolling(state.selectedTaskId);
  }
  if (detail?._is_thread) {
    state.chatThreadId = detail._thread_id || state.selectedTaskId;
    state.chatMode = true;
  }
  renderTaskPage({ preserveEvidence });
}

async function runNewTaskFromCommand({ prompt, provider, rounds }) {
  try {
    setBusy(true);
    setRunStatus("正在启动任务...", true);
    const effectiveProvider = resolvedProvider(provider);
    const maxIterations = resolvedRounds(rounds);
    const res = await postJson("/api/tasks/run", {
      prompt,
      provider: effectiveProvider,
      maxIterations,
      role_config: state.roleConfig || DEFAULT_ROLE_CONFIG,
      thread_slug: state.currentProjectId || undefined,
    });
    const taskId = String(res?.task_id || "").trim();
    el.chatCommandInput.value = "";
    await loadTasks();
    if (taskId) {
      state.runningTaskId = taskId;
      try {
        await selectTask(taskId);
      } catch {}
      startLivePolling(taskId);
      const newTitle = taskTitleLine(state.tasks.find((t) => t.task_id === taskId)) || taskId;
      const startText = String(res?.message || `任务已启动：${newTitle}`);
      showToast(startText, "positive");
      setRunStatus(startText, true);
    } else {
      showToast("任务已启动", "positive");
      setRunStatus("任务已启动", true);
    }
  } catch (err) {
    setRunStatus(`运行失败：${err.message}`, false);
    showToast(`运行失败：${err.message}`, "negative");
    reportClientError({ action: "run", status: err.status, message: err.message });
  } finally {
    setBusy(false);
  }
}

async function sendFollowupInThread({ message, provider, rounds, confirm = false }) {
  if (!state.selectedTaskId) {
    await runNewTaskFromCommand({ prompt: message, provider, rounds });
    return;
  }
  if (isSelectedThreadConversation()) {
    if (!state.chatMode) enterChatMode();
    await sendChatMessageUI(message);
    return;
  }
  const taskId = state.selectedTaskId;
  const taskTitle = taskTitleLine(state.tasks.find((t) => t.task_id === taskId));
  const clientMessageId = `client-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const optimisticMessage = {
    task_id: taskId,
    id: `${taskId}-followup-${clientMessageId}`,
    role: "task",
    role_label: "铲屎官",
    round: null,
    text: String(message || "").trim(),
    ts: Date.now(),
    provider: null,
    model: null,
    cost_usd: null,
    duration_ms: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_input_tokens: null,
    exit_code: null,
    ok: true,
  };

  try {
    el.chatCommandInput.value = "";
    state.optimisticMessages.push(optimisticMessage);
    renderChat();
    state.runningTaskId = taskId;
    setBusy(true);
    setRunStatus(`追问中：${taskTitle}`, true);
    startLivePolling(taskId);
    const res = await postJson(`/api/tasks/${taskId}/followup`, {
      message,
      provider: resolvedProvider(provider),
      maxIterations: resolvedRounds(rounds),
      role_config: state.roleConfig || DEFAULT_ROLE_CONFIG,
      client_message_id: clientMessageId,
      confirm: !!confirm,
    });
    if (res?.pending_confirmation) {
      setRunStatus(res.message || "等待铲屎官确认。发送 /confirm 开始实施。", false);
      showToast("已记录追问，等待确认后实施", "warning");
    } else if (String(res?.summary?.final_outcome || "").toLowerCase() === "canceled") {
      setRunStatus(`已终止：${taskTitle}`, false);
      showToast("运行已终止", "warning");
    } else {
      setRunStatus(`已更新：${taskTitle}`, false);
      showToast(confirm ? "已确认，开始实施" : "追问已加入当前会话", "positive");
    }
    removeOptimisticMessage(optimisticMessage.id);
    await loadTasks();
    if (res.task_id) await selectTask(res.task_id);
  } catch (err) {
    removeOptimisticMessage(optimisticMessage.id);
    renderChat();
    setRunStatus(`追问失败：${err.message}`, false);
    showToast(`追问失败：${err.message}`, "negative");
    reportClientError({ action: "followup", status: err.status, message: err.message, task_id: taskId });
  } finally {
    stopLivePolling();
    state.runningTaskId = null;
    setBusy(false);
  }
}

async function rerunCurrentTask(opts = {}) {
  if (!state.selectedTaskId) return;
  try {
    state.runningTaskId = state.selectedTaskId;
    setBusy(true);
    const rerunTitle = taskTitleLine(state.tasks.find((t) => t.task_id === state.selectedTaskId));
    setRunStatus(`重跑中：${rerunTitle}`, true);
    startLivePolling(state.selectedTaskId);
    const promptOverride = String(opts.prompt || "").trim();
    const provider = opts.provider || undefined;
    const maxIterations = resolvedRounds(opts.rounds);
    const res = await postJson(`/api/tasks/${state.selectedTaskId}/rerun`, {
      prompt: promptOverride || undefined,
      provider,
      maxIterations,
      role_config: state.roleConfig || DEFAULT_ROLE_CONFIG,
    });
    await loadTasks();
    const doneTitle = taskTitleLine(state.tasks.find((t) => t.task_id === res.task_id));
    if (String(res?.summary?.final_outcome || "").toLowerCase() === "canceled") {
      showToast(`重跑已终止：${doneTitle}`, "warning");
      setRunStatus(`重跑已终止：${doneTitle}`, false);
    } else {
      showToast(`重跑完成：${doneTitle}`, "positive");
      setRunStatus(`重跑完成：${doneTitle}`, false);
    }
    if (res.task_id) await selectTask(res.task_id);
  } catch (err) {
    setRunStatus(`重跑失败：${err.message}`, false);
    showToast(`重跑失败：${err.message}`, "negative");
    reportClientError({ action: "rerun", status: err.status, message: err.message, task_id: state.selectedTaskId });
  } finally {
    stopLivePolling();
    state.runningTaskId = null;
    setBusy(false);
  }
}

async function cancelCurrentRun() {
  // Cancel chat request if in chat busy state
  if (state.chatBusy) {
    try {
      setRunStatus("正在终止聊天...", true);
      const body = state.chatThreadId ? { thread_id: state.chatThreadId } : {};
      const res = await postJson("/api/chat/cancel", body);
      showToast(res?.message || "已发送终止信号。", "warning");
      setRunStatus("已终止", false);
    } catch (err) {
      showToast(`终止失败：${err.message}`, "negative");
      setRunStatus(`终止失败：${err.message}`, false);
    }
    return;
  }
  // Cancel task run
  if (!state.selectedTaskId) return;
  if (state.runningTaskId !== state.selectedTaskId) {
    showToast("当前任务没有可终止的运行。", "warning");
    return;
  }
  try {
    setRunStatus("正在终止运行...", true);
    const res = await postJson(`/api/tasks/${state.selectedTaskId}/cancel`, {});
    showToast(res?.message || "已发送终止信号。", "warning");
  } catch (err) {
    showToast(`终止失败：${err.message}`, "negative");
    setRunStatus(`终止失败：${err.message}`, false);
  }
}

// ---- Chat per-task persistence ----

const THREAD_MAP_KEY = "catcafe_task_thread_map";

function loadThreadMap() {
  try {
    return JSON.parse(localStorage.getItem(THREAD_MAP_KEY) || "{}");
  } catch { return {}; }
}

function saveThreadMapping(taskKey, threadId) {
  if (!taskKey || !threadId) return;
  const map = loadThreadMap();
  map[taskKey] = threadId;
  localStorage.setItem(THREAD_MAP_KEY, JSON.stringify(map));
}

// ---- Per-task mode persistence (localStorage) ----
const TASK_MODE_KEY = "catcafe_task_mode_map";

function loadTaskModeMap() {
  try {
    return JSON.parse(localStorage.getItem(TASK_MODE_KEY) || "{}");
  } catch { return {}; }
}

function saveTaskMode(taskKey, modeId) {
  if (!taskKey || !modeId) return;
  const map = loadTaskModeMap();
  map[taskKey] = modeId;
  localStorage.setItem(TASK_MODE_KEY, JSON.stringify(map));
}

function restoreTaskMode(taskKey) {
  if (!taskKey) return null;
  const map = loadTaskModeMap();
  return map[taskKey] || null;
}

async function refreshTasksList() {
  const data = await getJson("/api/tasks");
  state.tasks = data.tasks || [];
  applyFilter();
}

function buildThreadTitleFromMessage(message) {
  const normalized = String(message || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "新对话";
  return normalized.length > 20 ? `${normalized.slice(0, 20)}...` : normalized;
}

function adoptThreadSession(threadId) {
  if (!threadId) return;
  const previousKey = state.selectedTaskId || "__new__";
  if (state.isNewConversationDraft) {
    const draft = state.drafts.get("__new__");
    if (draft) state.drafts.set(threadId, draft);
  }
  saveThreadMapping(previousKey, threadId);
  saveThreadMapping(threadId, threadId);
  if (!state.selectedTaskId || state.isNewConversationDraft) {
    exitNewConversationDraftMode();
    state.selectedTaskId = threadId;
    state.selectedRound = null;
    state.detail = null;
    state.messagesData = null;
    state.liveDigest = "";
  }
  state.chatThreadId = threadId;
}

async function ensureChatSession(initialMessage = "", preferredMode = state.currentMode) {
  if (state.chatThreadId) return { threadId: state.chatThreadId, created: false };
  const threadSlug = state.currentProjectId || undefined;
  const apiUrl = threadSlug ? `/api/threads/${encodeURIComponent(threadSlug)}/sessions` : "/api/chat";
  const created = await postJson(apiUrl, {
    title: buildThreadTitleFromMessage(initialMessage),
    mode: preferredMode,
  });
  const threadId = created?.session?.thread_id || created?.thread?.thread_id;
  if (!threadId) throw new Error("创建对话失败：未返回 thread_id");
  const targetThreadId = threadSlug || created?.thread?.thread_id || threadId;
  expandThreadGroupByThreadId(targetThreadId);
  adoptThreadSession(threadId);
  safeSetCurrentMode(created?.thread?.mode || preferredMode || state.currentMode);
  state.currentModeState = created?.thread?.mode_state || {};
  saveTaskMode(state.selectedTaskId || "__new__", state.currentMode);
  renderModeSelector();
  await refreshTasksList();
  renderTaskPage({ preserveEvidence: true });
  fetchThreadMode(threadId);
  return { threadId, created: true };
}

function saveChatForCurrentTask() {
  const key = state.selectedTaskId || "__new__";
  const optimistic = state.chatMessages.filter((m) => !!m?._optimistic);
  if (optimistic.length > 0 || state.chatThreadId) {
    state.chatPerTask.set(key, {
      messages: [...optimistic],
      threadId: state.chatThreadId,
    });
    saveThreadMapping(key, state.chatThreadId);
  } else {
    state.chatPerTask.delete(key);
  }
  // 始终持久化当前任务的模式选择
  saveTaskMode(key, state.currentMode);
}

async function restoreChatForTask(taskId) {
  const key = taskId || "__new__";
  const saved = state.chatPerTask.get(key);
  state.chatMessages = (saved?.messages || []).filter((m) => !!m?._optimistic);
  state.chatThreadId = saved?.threadId || null;
  // Restore thread binding from localStorage mapping.
  const map = loadThreadMap();
  const threadId = map[key];
  if (threadId) {
    state.chatThreadId = threadId;
    fetchThreadMode(threadId);
  }
}

// ---- Chat mode functions ----

function catAvatarFor(catName) {
  const cats = activeRoleConfig()?.cats || {};
  const cat = cats[catName];
  return cat?.avatar || "🐱";
}

function catColorFor(catName) {
  const cats = activeRoleConfig()?.cats || {};
  const cat = cats[catName];
  return cat?.color || "#888";
}

function catDisplayName(catName) {
  const cats = activeRoleConfig()?.cats || {};
  const cat = cats[catName];
  return cat?.display_name || catName || "猫猫";
}

function mentionInsertName(cat) {
  return cat?.nickname || cat?.cat_name || "";
}

function collectMentionCats() {
  const cats = activeRoleConfig()?.cats || {};
  return Object.entries(cats).map(([catName, cat]) => ({
    ...cat,
    cat_name: catName,
    display_name: cat?.display_name || catName,
    nickname: cat?.nickname || "",
    aliases: Array.isArray(cat?.aliases) ? cat.aliases : [],
    avatar: cat?.avatar || "🐱",
  }));
}

function extractMentionContext(text, cursor) {
  const safeText = String(text || "");
  const caret = Number.isFinite(cursor) ? cursor : safeText.length;
  const before = safeText.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && /[A-Za-z0-9_.-]/.test(safeText[at - 1])) return null;
  const token = before.slice(at + 1);
  if (/\s/.test(token)) return null;
  if (!/^[\u4e00-\u9fff\w-]*$/.test(token)) return null;
  return { start: at, end: caret, query: token };
}

function scoreMention(cat, queryLower) {
  const fields = [
    String(cat.cat_name || "").toLowerCase(),
    String(cat.display_name || "").toLowerCase(),
    String(cat.nickname || "").toLowerCase(),
    ...cat.aliases.map((a) => String(a || "").toLowerCase()),
  ].filter(Boolean);
  if (!queryLower) return 1;
  if (fields.some((f) => f.startsWith(queryLower))) return 2;
  if (fields.some((f) => f.includes(queryLower))) return 1;
  return 0;
}

function buildMentionCandidates(query) {
  const queryLower = String(query || "").toLowerCase();
  return collectMentionCats()
    .map((cat) => ({ cat, score: scoreMention(cat, queryLower) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const an = String(a.cat.display_name || a.cat.cat_name || "");
      const bn = String(b.cat.display_name || b.cat.cat_name || "");
      return an.localeCompare(bn, "zh-Hans-CN");
    })
    .slice(0, 8)
    .map((x) => x.cat);
}

function hideMentionSuggest() {
  state.mentionSuggest.open = false;
  state.mentionSuggest.items = [];
  state.mentionSuggest.activeIndex = 0;
  state.mentionSuggest.query = "";
  if (el.mentionSuggest) {
    el.mentionSuggest.classList.remove("show");
    el.mentionSuggest.setAttribute("aria-hidden", "true");
    el.mentionSuggest.innerHTML = "";
  }
}

function renderMentionSuggest() {
  if (!el.mentionSuggest) return;
  if (!state.mentionSuggest.open || state.mentionSuggest.items.length === 0) {
    hideMentionSuggest();
    return;
  }
  const rows = state.mentionSuggest.items
    .map((cat, idx) => {
      const name = cat.display_name || cat.cat_name || "猫猫";
      const nick = cat.nickname ? `昵称：${cat.nickname}` : "未设置昵称";
      const insert = mentionInsertName(cat);
      const active = idx === state.mentionSuggest.activeIndex ? " active" : "";
      return `
        <button class="mention-item${active}" data-mention-index="${idx}" type="button">
          <span class="mention-main">
            <span class="mention-avatar">${escapeHtml(cat.avatar || "🐱")}</span>
            <span class="mention-name">${escapeHtml(name)}</span>
            <span class="mention-nick">${escapeHtml(nick)}</span>
          </span>
          <span class="mention-insert">@${escapeHtml(insert)}</span>
        </button>
      `;
    })
    .join("");
  el.mentionSuggest.innerHTML = rows;
  el.mentionSuggest.classList.add("show");
  el.mentionSuggest.setAttribute("aria-hidden", "false");
}

function updateMentionSuggest() {
  if (!el.chatCommandInput) {
    hideMentionSuggest();
    return;
  }
  const cursor = Number.isFinite(el.chatCommandInput.selectionStart)
    ? el.chatCommandInput.selectionStart
    : el.chatCommandInput.value.length;
  const context = extractMentionContext(el.chatCommandInput.value, cursor);
  if (!context) {
    hideMentionSuggest();
    return;
  }

  const candidates = buildMentionCandidates(context.query);
  if (candidates.length === 0) {
    hideMentionSuggest();
    return;
  }

  let nextActive = 0;
  const activeCat = state.mentionSuggest.items[state.mentionSuggest.activeIndex];
  if (activeCat?.cat_name) {
    const idx = candidates.findIndex((c) => c.cat_name === activeCat.cat_name);
    if (idx >= 0) nextActive = idx;
  }
  state.mentionSuggest.open = true;
  state.mentionSuggest.start = context.start;
  state.mentionSuggest.end = context.end;
  state.mentionSuggest.query = context.query;
  state.mentionSuggest.items = candidates;
  state.mentionSuggest.activeIndex = nextActive;
  renderMentionSuggest();
}

function moveMentionActive(delta) {
  if (!state.mentionSuggest.open || state.mentionSuggest.items.length === 0) return;
  const total = state.mentionSuggest.items.length;
  const next = (state.mentionSuggest.activeIndex + delta + total) % total;
  state.mentionSuggest.activeIndex = next;
  renderMentionSuggest();
}

function applyMentionSuggestion(index = state.mentionSuggest.activeIndex) {
  if (!state.mentionSuggest.open) return false;
  const pick = state.mentionSuggest.items[index];
  if (!pick || !el.chatCommandInput) return false;
  const mentionText = `@${mentionInsertName(pick)} `;
  const full = String(el.chatCommandInput.value || "");
  const start = Math.max(0, state.mentionSuggest.start);
  const end = Math.max(start, state.mentionSuggest.end);
  el.chatCommandInput.value = `${full.slice(0, start)}${mentionText}${full.slice(end)}`;
  const caret = start + mentionText.length;
  el.chatCommandInput.focus();
  el.chatCommandInput.setSelectionRange(caret, caret);
  saveDraft(el.chatCommandInput.value);
  hideMentionSuggest();
  return true;
}

async function sendChatMessageUI(message) {
  const optimisticId = `chat-local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const optimisticUserMessage = {
    id: optimisticId,
    sender: "铲屎官",
    sender_type: "user",
    cat_name: null,
    text: String(message || ""),
    ts: Date.now(),
    _optimistic: true,
  };

  try {
    setBusy(true);
    state.chatBusy = true;
    updateActionAvailability();
    setRunStatus("猫猫思考中...", true);
    await ensureChatSession(message, state.currentMode);
    if (state.selectedTaskId) {
      startLivePolling(state.selectedTaskId);
    }
    state.chatMessages.push(optimisticUserMessage);
    saveChatForCurrentTask();
    renderChat();
    el.chatStream.scrollTop = el.chatStream.scrollHeight;
    el.chatCommandInput.value = "";
    hideMentionSuggest();

    const body = {
      message,
      thread_id: state.chatThreadId || undefined,
      role_config: state.roleConfig || undefined,
      mode: state.currentMode || undefined,
      thread_slug: state.currentProjectId || undefined,
    };

    const res = await postJson("/api/chat", body);

    if (res.thread_id && String(res.thread_id) !== String(state.chatThreadId || "")) {
      adoptThreadSession(res.thread_id);
      fetchThreadMode(res.thread_id);
    }

    state.chatMessages = state.chatMessages.filter((m) => String(m.id) !== optimisticId);
    saveChatForCurrentTask();
    await refreshTasksList();
    await refreshSelectedSessionData({ preserveEvidence: true });
    if (state.chatThreadId) await fetchThreadMode(state.chatThreadId);
    el.chatStream.scrollTop = el.chatStream.scrollHeight;
    setRunStatus("", false);
    showToast("猫猫已回复", "positive");
  } catch (err) {
    state.chatMessages = state.chatMessages.filter((m) => String(m.id) !== optimisticId);
    saveChatForCurrentTask();
    renderTaskPage({ preserveEvidence: true });
    setRunStatus(`聊天失败：${err.message}`, false);
    showToast(`聊天失败：${err.message}`, "negative");
    reportClientError({ action: "chat", status: err.status, message: err.message });
  } finally {
    stopLivePolling();
    state.chatBusy = false;
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Session Mode — fetch, render, switch
// ---------------------------------------------------------------------------

const FALLBACK_MODES = Object.freeze([
  { id: "free_chat", label: "自由聊天", icon: "💬", desc: "猫猫们自由讨论，随意聊天" },
  { id: "workflow",  label: "流程执行", icon: "⚙️", desc: "严格流程：Coder → Reviewer → Tester" },
  { id: "werewolf",  label: "狼人杀",   icon: "🐺", desc: "猫猫们玩狼人杀游戏" },
  { id: "quiz",      label: "出题答题", icon: "🧩", desc: "猫猫之间互相出题答题" },
]);

function isValidModeList(modes) {
  return Array.isArray(modes) && modes.length > 0
    && modes.every((m) => m && typeof m.id === "string" && typeof m.label === "string");
}

async function fetchAvailableModes() {
  try {
    const data = await getJson("/api/modes");
    const modes = data.modes;
    // 校验：必须是非空数组且每项有 id/label，否则视为非法
    if (isValidModeList(modes)) {
      state.availableModes = modes;
    } else {
      console.warn("[CatCafe] /api/modes 返回数据结构非法，使用本地 FALLBACK_MODES", data);
    }
  } catch (err) {
    console.warn("[CatCafe] /api/modes 请求失败，使用本地 FALLBACK_MODES", err);
  }
  // 兜底：API 失败、返回空数组、或结构非法时，使用完整默认模式列表
  if (!state.availableModes.length) {
    state.availableModes = [...FALLBACK_MODES];
    console.info("[CatCafe] availableModes 已加载 FALLBACK_MODES，共", state.availableModes.length, "个模式");
  }
}

/** 校验 modeId 是否在当前 availableModes 白名单中 */
function isKnownMode(modeId) {
  return state.availableModes.some((m) => m.id === modeId);
}

/** 安全地设置 currentMode，非法值回退到 free_chat */
function safeSetCurrentMode(modeId) {
  if (modeId && isKnownMode(modeId)) {
    state.currentMode = modeId;
  } else {
    state.currentMode = "free_chat";
  }
}

async function fetchThreadMode(threadId) {
  if (!threadId) return;
  const seq = ++state._fetchModeSeq;
  try {
    const data = await getJson(`/api/threads/${threadId}/mode`);
    // 竞态保护：如果在等待期间又发起了新请求，丢弃旧响应
    if (seq !== state._fetchModeSeq) return;
    safeSetCurrentMode(data.mode);
    state.currentModeState = data.mode_state || {};
    if (data.workflow_nodes) {
      state.currentModeState._workflow_nodes = data.workflow_nodes;
    }
    // 持久化当前任务的模式
    saveTaskMode(state.selectedTaskId || "__new__", state.currentMode);
    renderModeSelector();
  } catch {}
}

async function switchMode(modeId) {
  try {
    // 切换模式时自动进入 chatMode
    if (!state.chatMode) {
      state.chatMode = true;
      el.chatCommandInput.placeholder = "@ 猫猫名字发消息，如：@牛奶 帮我看看这段代码";
    }
    // If no thread yet, create one with the desired mode and bind it to current session.
    if (!state.chatThreadId) {
      const ensured = await ensureChatSession(el.chatCommandInput?.value || "", modeId);
      if (ensured.created) {
        safeSetCurrentMode(modeId);
        saveTaskMode(state.selectedTaskId || "__new__", state.currentMode);
        renderModeSelector();
        const modeInfo = state.availableModes.find((m) => m.id === modeId);
        showToast(`已切换到${modeInfo?.label || modeId}模式`, "positive");
        fetchThreadMode(ensured.threadId);
        return;
      }
    }
    if (!state.chatThreadId) {
      throw new Error("当前没有可用会话");
    }
    const data = await fetch(`/api/threads/${state.chatThreadId}/mode`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: modeId }),
    }).then((r) => r.json());
    if (data.ok) {
      safeSetCurrentMode(data.mode);
      state.currentModeState = data.mode_state || {};
      saveTaskMode(state.selectedTaskId || "__new__", state.currentMode);
      renderModeSelector();
      showToast(`已切换到${data.mode_label}模式`, "positive");
      // Fetch full mode info (includes workflow_nodes)
      fetchThreadMode(state.chatThreadId);
      if (isSelectedThreadConversation()) {
        await refreshSelectedSessionData({ preserveEvidence: true });
      }
    }
  } catch (err) {
    showToast(`切换模式失败：${err.message}`, "negative");
  }
}

function renderModeSelector() {
  // 防御：如果 availableModes 为空（极端时序），立即加载 fallback
  if (!state.availableModes.length) {
    state.availableModes = [...FALLBACK_MODES];
    console.warn("[CatCafe] renderModeSelector: availableModes 为空，已加载 FALLBACK_MODES");
  }

  // 模式选择器常驻显示，不依赖 chatMode / chatThreadId
  el.modeSelectorWrap.style.display = "";

  const current = state.availableModes.find((m) => m.id === state.currentMode)
    || state.availableModes[0]
    || { id: "free_chat", label: "自由聊天", icon: "💬" };
  el.modeSelectorIcon.textContent = current.icon;
  el.modeSelectorLabel.textContent = current.label;

  renderWorkflowNodeBar();
}

function renderWorkflowNodeBar() {
  const isWorkflow = state.currentMode === "workflow" && state.chatMode;
  el.workflowNodeBar.style.display = isWorkflow ? "" : "none";
  // 工作流条在 .center-top 下方独立一行（position:absolute top:46px）
  // 显示时需加高 chatStream 的上边距，避免内容被遮挡
  el.chatStream.style.paddingTop = isWorkflow ? "104px" : "";
  if (!isWorkflow) return;

  const ms = state.currentModeState || {};
  const currentNode = ms.current_node || "coder";
  const completed = ms.completed_nodes || [];
  const nodes = ms._workflow_nodes || [
    { id: "coder", label: "编码", role: "CoreDev" },
    { id: "reviewer", label: "评审", role: "Reviewer" },
    { id: "tester", label: "测试", role: "Tester" },
  ];

  const roleMap = ms.role_map || {};
  // Reverse map: role → cat_name
  const roleToCat = {};
  for (const [cat, role] of Object.entries(roleMap)) {
    roleToCat[role] = cat;
  }

  const stepsHtml = nodes.map((n) => {
    let cls = "wf-step";
    if (completed.includes(n.id)) cls += " done";
    else if (n.id === currentNode) cls += " active";
    const catName = roleToCat[n.role] || "";
    const catLabel = catName ? ` (${catName})` : "";
    return `<span class="${cls}" data-node="${n.id}">
      <span class="wf-step-marker">${completed.includes(n.id) ? "✓" : n.id === currentNode ? "▶" : "○"}</span>
      <span class="wf-step-label">${n.label}${catLabel}</span>
    </span>`;
  });

  el.workflowNodeSteps.innerHTML = stepsHtml.join('<span class="wf-arrow">→</span>');

  // Hide advance button if at last node and it's completed
  const allDone = completed.length >= nodes.length;
  el.advanceNodeBtn.style.display = allDone ? "none" : "";
}

async function advanceWorkflowNode() {
  if (!state.chatThreadId) return;
  try {
    const data = await fetch(`/api/threads/${state.chatThreadId}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }).then((r) => r.json());
    if (data.ok) {
      state.currentModeState = data.mode_state || {};
      renderWorkflowNodeBar();
      if (data.finished) {
        showToast("流程已全部完成", "positive");
      } else {
        showToast(data.message || "已推进到下一节点", "positive");
      }
    }
  } catch (err) {
    showToast(`推进失败：${err.message}`, "negative");
  }
}

function renderModeDropdown() {
  // 防御：确保 availableModes 非空
  if (!state.availableModes.length) {
    state.availableModes = [...FALLBACK_MODES];
  }
  const items = state.availableModes.map((m) => {
    const active = m.id === state.currentMode ? " active" : "";
    return `<button class="mode-dropdown-item${active}" data-mode="${m.id}">
      <span class="mode-item-icon">${m.icon}</span>
      <span class="mode-item-info">
        <span class="mode-item-label">${m.label}</span>
        <span class="mode-item-desc">${m.desc}</span>
      </span>
    </button>`;
  });
  el.modeDropdown.innerHTML = items.join("");
}

function toggleModeDropdown(forceClose) {
  const open = forceClose ? false : !state.modeDropdownOpen;
  state.modeDropdownOpen = open;
  el.modeDropdown.setAttribute("aria-hidden", String(!open));
  if (open) renderModeDropdown();
}

// Mode selector event listeners
el.modeSelectorBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleModeDropdown();
});

el.modeDropdown.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-mode]");
  if (!btn) return;
  const modeId = btn.dataset.mode;
  toggleModeDropdown(true);
  if (modeId !== state.currentMode) switchMode(modeId);
});

// Close dropdown on outside click
document.addEventListener("click", () => {
  if (state.modeDropdownOpen) toggleModeDropdown(true);
});

// Advance workflow node button
el.advanceNodeBtn.addEventListener("click", () => {
  advanceWorkflowNode();
});

function enterChatMode() {
  state.chatMode = true;
  // Do NOT reset selectedTaskId — keep the current session context visible
  el.chatCommandInput.placeholder = "@ 猫猫名字发消息，如：@牛奶 帮我看看这段代码";
  updateMentionSuggest();
  // Re-render the main chat view which now includes inline chat messages
  renderChat();
  renderModeSelector();
  if (state.chatThreadId) fetchThreadMode(state.chatThreadId);
}

function exitChatMode() {
  state.chatMode = false;
  hideMentionSuggest();
  toggleModeDropdown(true);
  renderModeSelector();
  // Keep chatMessages and chatThreadId — they are part of the inline conversation history
  el.chatCommandInput.placeholder = '输入命令，如：/task 实现登录接口；/task --provider codex-cli --rounds 2 修复失败测试；/rerun 继续上个任务';
}

function jumpToBottom() {
  el.chatStream.scrollTop = el.chatStream.scrollHeight;
  updateJumpBottomVisibility();
}

async function handleComposerSubmit() {
  const raw = el.chatCommandInput.value.trim();
  const parsed = parseCliLikeCommand(raw);
  if (parsed.kind === "empty") return;

  // @猫猫 chat mode
  if (parsed.kind === "chat") {
    if (!state.chatMode) enterChatMode();
    clearDraft();
    await sendChatMessageUI(parsed.message);
    return;
  }

  // If already in chat mode and user types plain text, stay in chat mode
  if (state.chatMode && parsed.kind === "followup" && !parsed.fromSlashCommand) {
    clearDraft();
    await sendChatMessageUI(parsed.message);
    return;
  }

  if (parsed.kind === "help") {
    setRunStatus(commandHelpText(), false);
    return;
  }
  if (parsed.kind === "invalid") {
    showToast(parsed.error, "warning");
    setRunStatus(parsed.error, false);
    return;
  }

  // 新对话草稿模式下，任何非命令输入都作为新任务
  if (state.isNewConversationDraft) {
    clearDraft(); // 清除新对话草稿
    exitNewConversationDraftMode();
    if (parsed.kind === "chat") {
      enterChatMode();
      await sendChatMessageUI(parsed.message);
    } else if (parsed.kind === "task") {
      await runNewTaskFromCommand(parsed);
    } else if (parsed.kind === "followup") {
      // 在新对话模式下，followup 也作为新任务
      await runNewTaskFromCommand({ prompt: parsed.message, provider: parsed.provider, rounds: parsed.rounds });
    } else if (parsed.kind === "confirm" || parsed.kind === "rerun") {
      showToast("新对话模式下请先输入任务内容", "warning");
      enterNewConversationDraftMode();
    }
    return;
  }

  // 发送成功后清除草稿
  if (parsed.kind === "task") {
    clearDraft();
    await runNewTaskFromCommand(parsed);
    return;
  }
  if (parsed.kind === "followup") {
    clearDraft();
    await sendFollowupInThread(parsed);
    return;
  }
  if (parsed.kind === "confirm") {
    clearDraft();
    await sendFollowupInThread(parsed);
    return;
  }
  if (parsed.kind === "rerun") {
    if (!state.selectedTaskId) {
      showToast("当前没有可重跑任务，请先 /task 新建任务。", "warning");
      return;
    }
    clearDraft();
    await rerunCurrentTask({
      prompt: parsed.prompt || undefined,
      provider: parsed.provider || resolvedProvider(null),
      rounds: parsed.rounds,
    });
  }
}

async function exportCurrentReport() {
  if (!state.selectedTaskId) return;
  try {
    const res = await fetch(`/api/tasks/${state.selectedTaskId}/report.md`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `task-${state.selectedTaskId}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast("报告已导出", "positive");
  } catch (err) {
    showToast(`导出失败：${err.message}`, "negative");
  }
}

function collectPageCssText() {
  const chunks = [];
  for (const sheet of Array.from(document.styleSheets || [])) {
    try {
      const rules = Array.from(sheet.cssRules || []);
      chunks.push(rules.map((r) => r.cssText).join("\n"));
    } catch {}
  }
  return chunks.join("\n");
}

async function getHtml2Canvas() {
  if (typeof window.html2canvas === "function") return window.html2canvas;
  const script = document.createElement("script");
  script.src = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
  script.async = true;
  await new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = () => reject(new Error("无法加载 html2canvas"));
    document.head.appendChild(script);
  });
  if (typeof window.html2canvas !== "function") {
    throw new Error("html2canvas 未就绪");
  }
  return window.html2canvas;
}

async function exportCurrentImage() {
  if (!state.selectedTaskId) return;
  const prevRound = state.selectedRound;
  const hadRoundFilter = Number.isFinite(prevRound);
  let host = null;
  let svgUrl = null;
  let svgBlob = null;
  try {
    setBusy(true);

    if (hadRoundFilter) {
      state.selectedRound = null;
      renderRoundTag();
      renderTimeline();
      renderChat();
      await renderRoundTestResults().catch(() => {});
    }

    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    const shell = document.querySelector(".app-shell");
    if (!shell) throw new Error("页面节点不存在");

    host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "-100000px";
    host.style.top = "0";
    host.style.zIndex = "-1";
    host.style.pointerEvents = "none";
    document.body.appendChild(host);

    const clone = shell.cloneNode(true);
    clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
    clone.style.width = `${shell.clientWidth}px`;
    clone.style.height = "auto";
    clone.style.maxHeight = "none";

    // Stabilize layout for export: keep timeline viewport, expand only chat stream.
    const freezeStyle = document.createElement("style");
    freezeStyle.textContent = `
      * { animation: none !important; transition: none !important; }
      .timeline-strip { overflow: hidden !important; }
      .jump-bottom-btn, .copy-msg-btn, .toggle-expand, .evidence-open-btn, .evidence-drawer { display: none !important; }
    `;
    clone.appendChild(freezeStyle);

    const cloneLayout = clone.querySelector(".layout");
    if (cloneLayout) cloneLayout.style.height = "auto";
    const cloneCenter = clone.querySelector(".center-panel");
    if (cloneCenter) {
      cloneCenter.style.overflow = "hidden";
      cloneCenter.style.height = "auto";
      cloneCenter.style.maxHeight = "none";
    }
    const cloneChat = clone.querySelector("#chatStream");
    if (cloneChat) {
      cloneChat.style.overflow = "visible";
      cloneChat.style.height = "auto";
      cloneChat.style.maxHeight = "none";
      cloneChat.style.flex = "none";
      Array.from(cloneChat.querySelectorAll(".msg-text.collapsed")).forEach((node) => {
        node.classList.remove("collapsed");
        node.classList.add("expanded");
      });
      Array.from(cloneChat.querySelectorAll("[data-expand-btn='1']")).forEach((btn) => btn.remove());
    }
    const cloneJump = clone.querySelector("#jumpBottomBtn");
    if (cloneJump) cloneJump.remove();
    host.appendChild(clone);

    const width = Math.max(1, Math.ceil(clone.scrollWidth));
    const height = Math.max(1, Math.ceil(clone.scrollHeight));
    const maxDim = 16000;
    const fitScale = height > maxDim ? maxDim / height : 1;
    const outWidth = Math.max(1, Math.floor(width * fitScale));
    const outHeight = Math.max(1, Math.floor(height * fitScale));

    const cssText = collectPageCssText();
    const serialized = new XMLSerializer().serializeToString(clone);
    const xhtml = `
      <div xmlns="http://www.w3.org/1999/xhtml">
        <style>${cssText}</style>
        ${serialized}
      </div>
    `;
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${outWidth}" height="${outHeight}" viewBox="0 0 ${width} ${height}">
        <foreignObject x="0" y="0" width="${width}" height="${height}">${xhtml}</foreignObject>
      </svg>
    `;
    svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    svgUrl = URL.createObjectURL(svgBlob);

    try {
      const html2canvas = await getHtml2Canvas();
      const rendered = await html2canvas(clone, {
        backgroundColor: "#f4f3f1",
        useCORS: true,
        allowTaint: false,
        scale: Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
        width,
        height,
        windowWidth: width,
        windowHeight: height,
      });
      let canvas = rendered;
      if (fitScale < 1) {
        const scaled = document.createElement("canvas");
        scaled.width = outWidth;
        scaled.height = outHeight;
        const sctx = scaled.getContext("2d");
        if (!sctx) throw new Error("无法创建画布");
        sctx.drawImage(rendered, 0, 0, outWidth, outHeight);
        canvas = scaled;
      }

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 1));
      if (!blob) throw new Error("图片生成失败");
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `task-${state.selectedTaskId}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
    } catch (canvasErr) {
      const msg = String(canvasErr?.message || canvasErr || "");
      const isCanvasSecurityError =
        /insecure|security|tainted|origin-clean|cross-origin|toBlob|html2canvas/i.test(msg) ||
        canvasErr?.name === "SecurityError";
      if (!isCanvasSecurityError || !svgBlob) throw canvasErr;
      const rawUrl = URL.createObjectURL(svgBlob);
      const a = document.createElement("a");
      a.href = rawUrl;
      a.download = `task-${state.selectedTaskId}.svg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(rawUrl);
      showToast("浏览器安全限制导致 PNG 失败，已导出 SVG 长图", "warning");
      setRunStatus(`已导出 SVG：${state.selectedTaskId}`, false);
      return;
    }
    if (fitScale < 1) {
      showToast("内容过长，已按比例缩放导出", "warning");
    } else {
      showToast("图片已导出", "positive");
    }
    setRunStatus(`图片导出完成：${state.selectedTaskId}`, false);
  } catch (err) {
    showToast(`导出图片失败：${err.message}`, "negative");
    setRunStatus(`导出图片失败：${err.message}`, false);
  } finally {
    if (svgUrl) URL.revokeObjectURL(svgUrl);
    if (host) host.remove();
    if (hadRoundFilter) {
      state.selectedRound = prevRound;
      renderRoundTag();
      renderTimeline();
      renderChat();
      renderRoundTestResults().catch(() => {});
    }
    setBusy(false);
  }
}

async function exportCurrentChatImage() {
  if (!state.selectedTaskId) return;
  let host = null;
  let svgUrl = null;
  let svgBlob = null;
  try {
    setBusy(true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    host = document.createElement("div");
    host.style.position = "fixed";
    host.style.left = "-100000px";
    host.style.top = "0";
    host.style.zIndex = "-1";
    host.style.pointerEvents = "none";
    document.body.appendChild(host);

    const shell = document.createElement("section");
    shell.style.width = `${Math.max(680, el.chatStream.clientWidth)}px`;
    shell.style.background = "#fcfbfa";
    shell.style.border = "1px solid #e7e1dc";
    shell.style.borderRadius = "14px";
    shell.style.padding = "12px";
    shell.style.boxSizing = "border-box";

    const title = document.createElement("div");
    title.style.display = "flex";
    title.style.alignItems = "center";
    title.style.justifyContent = "space-between";
    title.style.marginBottom = "8px";
    title.innerHTML = `<strong style="font-size:14px;color:#2f2c29;">消息流</strong><span style="font-size:12px;color:#847b74;">${escapeHtml(
      String(state.selectedTaskId)
    )}</span>`;
    shell.appendChild(title);

    const toolbar = document.querySelector(".chat-toolbar");
    if (toolbar) {
      const toolbarClone = toolbar.cloneNode(true);
      shell.appendChild(toolbarClone);
    }

    const chatClone = el.chatStream.cloneNode(true);
    chatClone.style.marginTop = "10px";
    chatClone.style.overflow = "visible";
    chatClone.style.height = "auto";
    chatClone.style.maxHeight = "none";
    chatClone.style.flex = "none";
    Array.from(chatClone.querySelectorAll(".msg-text.collapsed")).forEach((node) => {
      node.classList.remove("collapsed");
      node.classList.add("expanded");
    });
    Array.from(chatClone.querySelectorAll(".toggle-expand,.copy-msg-btn,.ev-btn,.evidence-open-btn")).forEach((node) =>
      node.remove()
    );
    shell.appendChild(chatClone);
    host.appendChild(shell);

    const width = Math.max(1, Math.ceil(shell.scrollWidth));
    const height = Math.max(1, Math.ceil(shell.scrollHeight));
    const maxDim = 16000;
    const fitScale = height > maxDim ? maxDim / height : 1;
    const outWidth = Math.max(1, Math.floor(width * fitScale));
    const outHeight = Math.max(1, Math.floor(height * fitScale));

    const html2canvas = await getHtml2Canvas();
    const rendered = await html2canvas(shell, {
      backgroundColor: "#fcfbfa",
      useCORS: true,
      allowTaint: false,
      scale: Math.max(1, Math.min(2, window.devicePixelRatio || 1)),
      width,
      height,
      windowWidth: width,
      windowHeight: height,
    });
    let canvas = rendered;
    if (fitScale < 1) {
      const scaled = document.createElement("canvas");
      scaled.width = outWidth;
      scaled.height = outHeight;
      const sctx = scaled.getContext("2d");
      if (!sctx) throw new Error("无法创建画布");
      sctx.drawImage(rendered, 0, 0, outWidth, outHeight);
      canvas = scaled;
    }

    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png", 1));
      if (!blob) throw new Error("图片生成失败");
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `task-${state.selectedTaskId}-chat.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      showToast(fitScale < 1 ? "消息流过长，已按比例缩放导出" : "消息流图片已导出", fitScale < 1 ? "warning" : "positive");
      setRunStatus(`消息流图片导出完成：${state.selectedTaskId}`, false);
      return;
    } catch (canvasErr) {
      const cssText = collectPageCssText();
      const serialized = new XMLSerializer().serializeToString(shell);
      const xhtml = `
        <div xmlns="http://www.w3.org/1999/xhtml">
          <style>${cssText}</style>
          ${serialized}
        </div>
      `;
      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${outWidth}" height="${outHeight}" viewBox="0 0 ${width} ${height}">
          <foreignObject x="0" y="0" width="${width}" height="${height}">${xhtml}</foreignObject>
        </svg>
      `;
      svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      svgUrl = URL.createObjectURL(svgBlob);

      const msg = String(canvasErr?.message || canvasErr || "");
      const isCanvasSecurityError =
        /insecure|security|tainted|origin-clean|cross-origin|toBlob|html2canvas/i.test(msg) ||
        canvasErr?.name === "SecurityError";
      if (!isCanvasSecurityError || !svgBlob) throw canvasErr;

      const rawUrl = URL.createObjectURL(svgBlob);
      const a = document.createElement("a");
      a.href = rawUrl;
      a.download = `task-${state.selectedTaskId}-chat.svg`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(rawUrl);
      showToast("浏览器安全限制导致 PNG 失败，已导出 SVG", "warning");
      setRunStatus(`消息流已导出 SVG：${state.selectedTaskId}`, false);
    }
  } catch (err) {
    showToast(`导出消息流失败：${err.message}`, "negative");
    setRunStatus(`导出消息流失败：${err.message}`, false);
  } finally {
    if (svgUrl) URL.revokeObjectURL(svgUrl);
    if (host) host.remove();
    setBusy(false);
  }
}

function copyCurrentTaskId() {
  if (!state.selectedTaskId) return;
  navigator.clipboard
    .writeText(state.selectedTaskId)
    .then(() => showToast("任务ID已复制", "positive"))
    .catch(() => showToast("复制失败", "negative"));
}

function clearRoundFilter() {
  state.selectedRound = null;
  renderRoundTag();
  renderTimeline();
  renderChat();
  renderRoundTestResults().catch(() => {});
}

function setMoreActionsMenu(open) {
  if (!el.moreActionsMenu) return;
  el.moreActionsMenu.classList.toggle("show", !!open);
  el.moreActionsMenu.setAttribute("aria-hidden", open ? "false" : "true");
}

function setRightPanelCollapsed(collapsed) {
  rightPanelCollapsed = !!collapsed;
  if (el.appLayout) el.appLayout.classList.toggle("right-collapsed", rightPanelCollapsed);
  if (el.toggleRightPanelBtn) {
    const label = rightPanelCollapsed ? "展开状态栏" : "隐藏状态栏";
    el.toggleRightPanelBtn.title = label;
    el.toggleRightPanelBtn.setAttribute("aria-label", label);
    el.toggleRightPanelBtn.setAttribute("aria-pressed", rightPanelCollapsed ? "true" : "false");
  }
  try {
    localStorage.setItem("catcafe_right_panel_collapsed", rightPanelCollapsed ? "1" : "0");
  } catch {}
}

// ========== 草稿防丢失机制 ==========
function getDraftKey() {
  return state.isNewConversationDraft ? "__new__" : (state.selectedTaskId || "__new__");
}

function saveDraft(text) {
  const key = getDraftKey();
  const trimmed = String(text || "").trim();
  if (trimmed) {
    state.drafts.set(key, trimmed);
  } else {
    state.drafts.delete(key);
  }
}

function loadDraft() {
  const key = getDraftKey();
  return state.drafts.get(key) || "";
}

function clearDraft() {
  const key = getDraftKey();
  state.drafts.delete(key);
}

// ========== 新对话草稿模式 ==========
function enterNewConversationDraftMode() {
  if (state.busy) return;

  // 保存当前对话的草稿
  const currentInput = el.chatCommandInput.value.trim();
  if (currentInput && state.selectedTaskId) {
    state.drafts.set(state.selectedTaskId, currentInput);
  }

  // 进入新对话草稿模式
  state.isNewConversationDraft = true;
  state.selectedTaskId = null;
  state.selectedRound = null;
  state.detail = null;
  state.messagesData = null;
  state.liveDigest = "";

  // 更新左侧列表选中状态
  renderTasks();

  // 统一走主会话渲染路径
  renderTaskPage();

  // 恢复新对话的草稿（如果有）
  const newDraft = state.drafts.get("__new__") || "";
  el.chatCommandInput.value = newDraft;
  el.chatCommandInput.placeholder = "输入新对话内容，发送后自动创建对话...";
  el.chatCommandInput.focus();

  updateActionAvailability();
}

function exitNewConversationDraftMode() {
  state.isNewConversationDraft = false;
}

async function startNewConversation() {
  saveChatForCurrentTask();
  if (state.chatMode) exitChatMode();
  state.chatMessages = [];
  state.chatThreadId = null;
  safeSetCurrentMode("free_chat");
  state.currentModeState = {};
  renderModeSelector();
  enterNewConversationDraftMode();
}

async function deleteConversation(taskId) {
  if (!taskId) return;

  const confirmed = confirm(`确定要删除这个会话吗？\n\n此操作不可撤销。`);
  if (!confirmed) return;

  try {
    setBusy(true);
    const res = await fetch(`/api/tasks/${taskId}`, { method: "DELETE" });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }

    showToast("会话已删除", "positive");

    // 如果删除的是当前选中的会话，清空选中状态
    if (state.selectedTaskId === taskId) {
      state.selectedTaskId = null;
      state.detail = null;
      state.messagesData = null;
      state.liveDigest = "";
    }

    // 从草稿中移除
    state.drafts.delete(taskId);

    // 重新加载任务列表
    await loadTasks();
  } catch (err) {
    showToast(`删除失败：${err.message}`, "negative");
  } finally {
    setBusy(false);
  }
}

el.taskSearch.addEventListener("input", applyFilter);
if (el.newChatBtn) el.newChatBtn.addEventListener("click", () => startNewConversation());

// Project selector events
if (el.projectSelectorBtn) el.projectSelectorBtn.addEventListener("click", toggleProjectDropdown);
if (el.newProjectBtn) el.newProjectBtn.addEventListener("click", createNewProject);
if (el.archiveProjectBtn) el.archiveProjectBtn.addEventListener("click", archiveCurrentProject);
if (el.deleteProjectBtn) el.deleteProjectBtn.addEventListener("click", hardDeleteCurrentProject);
document.addEventListener("click", (e) => {
  if (state.projectDropdownOpen &&
      !el.projectSelectorBtn?.contains(e.target) &&
      !el.projectDropdown?.contains(e.target)) {
    state.projectDropdownOpen = false;
    el.projectDropdown?.setAttribute("aria-hidden", "true");
  }
});

// 草稿自动保存：输入时保存
el.chatCommandInput.addEventListener("input", () => {
  saveDraft(el.chatCommandInput.value);
  updateMentionSuggest();
});
el.chatCommandInput.addEventListener("click", updateMentionSuggest);
el.chatCommandInput.addEventListener("keyup", (e) => {
  const k = e.key;
  if (k === "ArrowLeft" || k === "ArrowRight" || k === "Home" || k === "End") {
    updateMentionSuggest();
  }
});
el.chatCommandInput.addEventListener("blur", () => {
  setTimeout(() => {
    if (document.activeElement !== el.chatCommandInput) {
      hideMentionSuggest();
    }
  }, 80);
});
if (el.mentionSuggest) {
  el.mentionSuggest.addEventListener("mousedown", (e) => {
    e.preventDefault();
  });
  el.mentionSuggest.addEventListener("click", (e) => {
    const target = e.target instanceof Element ? e.target.closest("[data-mention-index]") : null;
    if (!target) return;
    const idx = Number(target.getAttribute("data-mention-index"));
    if (!Number.isFinite(idx)) return;
    applyMentionSuggestion(idx);
  });
}

if (el.exportReportBtn) el.exportReportBtn.addEventListener("click", exportCurrentReport);
if (el.exportChatImageBtn) el.exportChatImageBtn.addEventListener("click", exportCurrentChatImage);
if (el.cancelRunBtn) el.cancelRunBtn.addEventListener("click", cancelCurrentRun);
if (el.toggleRightPanelBtn) {
  el.toggleRightPanelBtn.addEventListener("click", () => setRightPanelCollapsed(!rightPanelCollapsed));
}
if (el.moreActionsBtn)
  el.moreActionsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const opened = !!el.moreActionsMenu?.classList.contains("show");
    setMoreActionsMenu(!opened);
  });
if (el.moreActionsMenu)
  el.moreActionsMenu.addEventListener("click", (e) => {
    e.stopPropagation();
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const action = String(target.dataset.action || "");
    if (!action) return;
    setMoreActionsMenu(false);
    if (action === "copy-task-id") copyCurrentTaskId();
    if (action === "export-page-image") exportCurrentImage();
    if (action === "rerun-task") rerunCurrentTask();
    if (action === "clear-round-filter") clearRoundFilter();
  });
el.sendCommandBtn.addEventListener("click", handleComposerSubmit);
el.jumpBottomBtn.addEventListener("click", jumpToBottom);
el.chatStream.addEventListener("scroll", updateJumpBottomVisibility);
if (el.evidenceDrawerClose) el.evidenceDrawerClose.addEventListener("click", () => setEvidenceDrawerOpen(false));
if (el.evidenceDrawer)
  el.evidenceDrawer.addEventListener("click", (e) => {
    e.stopPropagation();
  });
if (el.evidenceDrawerKinds)
  el.evidenceDrawerKinds.addEventListener("click", (e) => {
    e.stopPropagation();
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const kind = String(target.dataset.drawerKind || "");
    const round = Number(target.dataset.drawerRound);
    const role = String(target.dataset.drawerRole || "");
    if (!kind || !Number.isFinite(round) || !role) return;
    openEvidenceDrawer(round, role, kind).catch(() => {});
  });
document.addEventListener("click", (e) => {
  if (el.moreActionsMenu?.classList.contains("show")) {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    if (!path.includes(el.moreActionsMenu) && !path.includes(el.moreActionsBtn)) {
      setMoreActionsMenu(false);
    }
  }
  if (!state.evidenceDrawer.open) return;
  const path = typeof e.composedPath === "function" ? e.composedPath() : [];
  if (el.evidenceDrawer && path.includes(el.evidenceDrawer)) return;
  if (path.some((n) => n instanceof Element && n.closest?.(".evidence-open-btn"))) return;
  setEvidenceDrawerOpen(false);
});
el.chatCommandInput.addEventListener("keydown", (e) => {
  if (state.mentionSuggest.open) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveMentionActive(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      moveMentionActive(-1);
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      if (applyMentionSuggestion()) return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      hideMentionSuggest();
      return;
    }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleComposerSubmit();
  }
});
el.saveRolesBtn.addEventListener("click", saveRoleConfig);

setRunStatus(commandHelpText(), false);
updateActionAvailability();
try {
  setRightPanelCollapsed(localStorage.getItem("catcafe_right_panel_collapsed") === "1");
} catch {
  setRightPanelCollapsed(false);
}
// 先加载项目列表、角色配置和可用模式，再加载任务列表
Promise.all([loadProjects(), loadRoleConfig(), fetchAvailableModes()])
  .then(() => loadTasks())
  .then(() => {
    renderModeSelector();
  })
  .catch((err) => {
    el.taskList.innerHTML = `<div class="empty-block">加载失败: ${err.message}</div>`;
    setRunStatus(`加载失败：${err.message}`, false);
  });
