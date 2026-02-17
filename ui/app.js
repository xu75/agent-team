const state = {
  tasks: [],
  filtered: [],
  selectedTaskId: null,
  selectedRound: null,
  detail: null,
  messagesData: null,
  roleConfig: null,
  busy: false,
  optimisticMessages: [],
  livePollTimer: null,
  livePollBusy: false,
  liveDigest: "",
  runningTaskId: null,
  evidenceDrawer: {
    open: false,
    round: null,
    role: null,
    kind: null,
  },
  collapsedProjects: new Set(),
};

const el = {
  appLayout: document.getElementById("appLayout"),
  taskList: document.getElementById("taskList"),
  taskSearch: document.getElementById("taskSearch"),
  newChatBtn: document.getElementById("newChatBtn"),
  taskTitle: document.getElementById("taskTitle"),
  taskMeta: document.getElementById("taskMeta"),
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
};

let rightPanelCollapsed = false;

const DEFAULT_ROLE_CONFIG = {
  version: 2,
  models: [
    { id: "claude", name: "Claude", provider: "claude-cli" },
    { id: "codex", name: "Codex", provider: "codex-cli" },
  ],
  stage_assignment: { coder: "codex", reviewer: "claude", tester: "claude" },
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

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j?.error) msg = j.error;
    } catch {}
    throw new Error(msg);
  }
  return res.json();
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

function previewLine(t) {
  const raw = String(t?.last_preview || "").trim();
  if (!raw) return "暂无预览";
  return raw.length > 56 ? `${raw.slice(0, 56)}...` : raw;
}

function taskTitleLine(t) {
  const title = String(t?.task_title || "").trim();
  if (title) return title;
  const fallback = String(t?.last_preview || "").trim();
  if (fallback) return fallback.length > 24 ? `${fallback.slice(0, 24)}...` : fallback;
  return String(t?.task_id || "未命名任务");
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

function taskProjectInfo(t) {
  const rawName = String(t?.project_name || t?.project_id || "默认项目").trim();
  const rawId = String(t?.project_id || rawName).trim();
  return {
    id: normalizeProjectId(rawId),
    name: rawName || "默认项目",
  };
}

function roleAvatar(role) {
  if (role === "coder") return "🛠";
  if (role === "reviewer") return "🔍";
  if (role === "tester") return "🧪";
  if (role === "task") return "📌";
  return "•";
}

function metaLine(m) {
  const parts = [];
  if (m.provider) parts.push(m.provider);
  if (m.model) parts.push(m.model);
  if (Number.isFinite(m.input_tokens) || Number.isFinite(m.output_tokens)) {
    parts.push(`in ${m.input_tokens ?? 0} · out ${m.output_tokens ?? 0}`);
  }
  if (fmtCost(m.cost_usd)) parts.push(fmtCost(m.cost_usd));
  if (Number.isFinite(m.duration_ms)) parts.push(`${m.duration_ms}ms`);
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
  lines.push("");
  lines.push("查看完整 JSON：点击下方 Evidence -> json");
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
  lines.push("");
  lines.push("查看完整 JSON：点击下方 Evidence -> json");
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

function normalizeRoleConfig(input) {
  const base = JSON.parse(JSON.stringify(DEFAULT_ROLE_CONFIG));
  if (!input || typeof input !== "object") return base;
  const arr = Array.isArray(input.models) ? input.models : [];
  base.models = base.models.map((m) => {
    const found = arr.find((x) => x?.id === m.id) || {};
    return {
      id: m.id,
      name: m.name,
      provider: m.provider,
    };
  });
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
  return base;
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
  const canCancel = !!state.selectedTaskId && state.runningTaskId === state.selectedTaskId;
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
}

function setBusy(v) {
  state.busy = v;
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

function buildLiveDigest(detail, messagesData) {
  const summary = detail?.summary || {};
  const messages = messagesData?.messages || [];
  const last = messages[messages.length - 1] || {};
  const unresolved = Array.isArray(messagesData?.unresolved_must_fix)
    ? messagesData.unresolved_must_fix.length
    : 0;
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
  const map = new Map();
  for (const t of tasks) {
    const p = taskProjectInfo(t);
    if (!map.has(p.id)) map.set(p.id, { id: p.id, name: p.name, tasks: [] });
    map.get(p.id).tasks.push(t);
  }
  return Array.from(map.values())
    .map((p) => {
      p.tasks.sort((a, b) => (b.updated_ts || 0) - (a.updated_ts || 0));
      return p;
    })
    .sort((a, b) => (b.tasks[0]?.updated_ts || 0) - (a.tasks[0]?.updated_ts || 0));
}

function renderTasks() {
  el.taskList.innerHTML = "";
  if (!state.filtered.length) {
    el.taskList.innerHTML =
      '<div class="empty-block">暂无任务。先运行一次 <code>node src/index.js "你的任务"</code> 生成日志。</div>';
    return;
  }

  const projects = projectTaskGroups(state.filtered);
  projects.forEach((project) => {
    const projectSection = document.createElement("section");
    const collapsed = state.collapsedProjects.has(project.id);
    projectSection.className = `project-section${collapsed ? " collapsed" : ""}`;

    const latest = project.tasks[0];
    projectSection.innerHTML = `
      <button class="project-head" data-project-toggle="${escapeHtml(project.id)}">
        <span class="caret">${collapsed ? "▸" : "▾"}</span>
        <span class="project-name">${escapeHtml(project.name)}</span>
        <span class="project-meta">${project.tasks.length} 个对话 · ${fmtRelativeTime(latest?.updated_ts)}</span>
      </button>
      <div class="project-body"></div>
    `;
    const body = projectSection.querySelector(".project-body");
    const groups = taskGroups(project.tasks);
    groups.forEach(([date, list]) => {
      const section = document.createElement("section");
      section.className = "task-section";
      section.innerHTML = `<div class="task-section-title">${date}</div>`;
      const box = document.createElement("div");
      box.className = "task-section-list";

      list.forEach((t) => {
        const row = document.createElement("div");
        row.className =
          `task-item` +
          (t.task_id === state.selectedTaskId ? " active" : "");
        row.innerHTML = `
          <div class="task-head">
            <div class="task-title" title="${escapeHtml(t.task_id)}">${escapeHtml(taskTitleLine(t))}</div>
            <span class="mini-time">${fmtRelativeTime(t.updated_ts)}</span>
          </div>
          <div class="preview">${escapeHtml(previewLine(t))}</div>
        `;
        row.addEventListener("click", () => selectTask(t.task_id));
        box.appendChild(row);
      });

      section.appendChild(box);
      body.appendChild(section);
    });

    const toggle = projectSection.querySelector("[data-project-toggle]");
    toggle.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (state.collapsedProjects.has(project.id)) {
        state.collapsedProjects.delete(project.id);
      } else {
        state.collapsedProjects.add(project.id);
      }
      renderTasks();
    });
    el.taskList.appendChild(projectSection);
  });
}

function applyFilter() {
  const q = el.taskSearch.value.trim().toLowerCase();
  state.filtered = state.tasks.filter((t) => {
    if (!q) return true;
    return (
      String(t.project_name || "").toLowerCase().includes(q) ||
      String(t.project_id || "").toLowerCase().includes(q) ||
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

function filteredMessages() {
  const all = state.messagesData?.messages || [];
  const existingIds = new Set(all.map((m) => String(m.id || "")));
  const pending = state.optimisticMessages.filter(
    (m) =>
      String(m.task_id || "") === String(state.selectedTaskId || "") &&
      !existingIds.has(String(m.id || ""))
  );
  const merged = [...all, ...pending].sort((a, b) => {
    const ta = Number.isFinite(a.ts) ? a.ts : 0;
    const tb = Number.isFinite(b.ts) ? b.ts : 0;
    if (ta !== tb) return ta - tb;
    const ra = Number.isFinite(a.round) ? a.round : -1;
    const rb = Number.isFinite(b.round) ? b.round : -1;
    if (ra !== rb) return ra - rb;
    return String(a.role || "").localeCompare(String(b.role || ""));
  });
  if (!Number.isFinite(state.selectedRound)) return merged;
  return merged.filter((m) => m.round === state.selectedRound || m.role === "task");
}

function removeOptimisticMessage(msgId) {
  state.optimisticMessages = state.optimisticMessages.filter((m) => String(m.id || "") !== String(msgId || ""));
}

async function refreshTaskLive(taskId) {
  if (!taskId || state.livePollBusy) return;
  state.livePollBusy = true;
  try {
    const [detail, messages] = await Promise.all([
      getJson(`/api/tasks/${taskId}`),
      getJson(`/api/tasks/${taskId}/messages`),
    ]);
    if (state.selectedTaskId !== taskId) return;
    const nextDigest = buildLiveDigest(detail, messages);
    const changed = nextDigest !== state.liveDigest;
    state.detail = detail;
    state.messagesData = messages;
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
  if (state.livePollTimer) {
    clearInterval(state.livePollTimer);
    state.livePollTimer = null;
  }
}

function startLivePolling(taskId) {
  stopLivePolling();
  refreshTaskLive(taskId).catch(() => {});
  state.livePollTimer = setInterval(() => {
    refreshTaskLive(taskId).catch(() => {});
  }, 1000);
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
    el.chatStream.innerHTML = '<div class="empty-block">当前筛选条件下没有消息。</div>';
    updateJumpBottomVisibility();
    return;
  }
  const groups = [];
  for (const m of messages) {
    const g = groups[groups.length - 1];
    const sameRole = g && g.role === m.role;
    const sameRound =
      g &&
      ((Number.isFinite(g.round) && Number.isFinite(m.round) && g.round === m.round) ||
        (!Number.isFinite(g.round) && !Number.isFinite(m.round)));
    const nearTs = g && Math.abs((m.ts || 0) - (g.lastTs || 0)) <= 5 * 60 * 1000;
    if (sameRole && sameRound && nearTs) {
      g.messages.push(m);
      g.lastTs = m.ts || g.lastTs;
    } else {
      groups.push({
        role: m.role,
        round: Number.isFinite(m.round) ? m.round : null,
        roleLabel: displayRoleLabel(m.role, m.role_label),
        firstTs: m.ts || Date.now(),
        lastTs: m.ts || Date.now(),
        messages: [m],
      });
    }
  }

  groups.forEach((g) => {
    const block = document.createElement("article");
    block.className = `chat-group role-${g.role}`;
    block.innerHTML = `
      <header class="group-head">
        <div class="lhs">
          <span class="avatar">${roleAvatar(g.role)}</span>
          <span class="role">${escapeHtml(g.roleLabel)}</span>
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
      const textHtml = collapsible
        ? `<pre class="msg-text collapsed" data-collapsible="1">${escapeHtml(rawText)}</pre>
           <button class="toggle-expand" data-expand-btn="1">展开全文</button>`
        : `<pre class="msg-text">${escapeHtml(rawText)}</pre>`;
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
  el.taskTitle.textContent = String(selected?.task_title || selected?.task_id || "对话");
  el.taskMeta.textContent = `${summary.provider || "-"} · ${summary.final_outcome || "-"}`;
  el.taskMeta.className = `meta-pill ${toneFromOutcome(summary.final_outcome)}`.trim();
  if (el.rightRuntimeHint) {
    const current = state.messagesData?.current_stage || summary.final_status || "-";
    el.rightRuntimeHint.textContent = `${summary.provider || "-"} · ${current}`;
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
  state.selectedTaskId = taskId;
  state.selectedRound = null;
  renderTasks();

  const [detail, messages] = await Promise.all([
    getJson(`/api/tasks/${taskId}`),
    getJson(`/api/tasks/${taskId}/messages`),
  ]);

  state.detail = detail;
  state.messagesData = messages;
  state.liveDigest = buildLiveDigest(detail, messages);
  renderTaskPage();
}

function renderEmptyScreen() {
  el.taskTitle.textContent = "对话";
  el.taskMeta.className = "meta-pill";
  el.taskMeta.textContent = "暂无任务";
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
  setMoreActionsMenu(false);
  if (el.rightRuntimeHint) el.rightRuntimeHint.textContent = "空闲";
  renderEvidencePlaceholder();
  setEvidenceDrawerOpen(false);
  updateJumpBottomVisibility();
  updateActionAvailability();
}

async function loadTasks() {
  const data = await getJson("/api/tasks");
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
    state.liveDigest = "";
    renderEmptyScreen();
  }
}

function parseCliLikeCommand(rawLine) {
  const line = String(rawLine || "").trim();
  if (!line) return { kind: "empty" };
  if (!line.startsWith("/")) return { kind: "followup", message: line, provider: null, rounds: null };

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
    return { kind: "followup", message: prompt, provider, rounds };
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

async function runNewTaskFromCommand({ prompt, provider, rounds }) {
  try {
    setBusy(true);
    setRunStatus("正在运行任务...", true);
    const effectiveProvider = resolvedProvider(provider);
    const maxIterations = resolvedRounds(rounds);
    const res = await postJson("/api/tasks/run", {
      prompt,
      provider: effectiveProvider,
      maxIterations,
      role_config: state.roleConfig || DEFAULT_ROLE_CONFIG,
    });
    showToast(`任务已完成：${res.task_id}`, "positive");
    el.chatCommandInput.value = "";
    setRunStatus(`完成：${res.task_id}`, false);
    await loadTasks();
    if (res.task_id) await selectTask(res.task_id);
  } catch (err) {
    setRunStatus(`运行失败：${err.message}`, false);
    showToast(`运行失败：${err.message}`, "negative");
  } finally {
    setBusy(false);
  }
}

async function sendFollowupInThread({ message, provider, rounds, confirm = false }) {
  if (!state.selectedTaskId) {
    await runNewTaskFromCommand({ prompt: message, provider, rounds });
    return;
  }
  const taskId = state.selectedTaskId;
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
    setRunStatus(`追问中：${taskId}`, true);
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
      setRunStatus(`已终止：${res.task_id}`, false);
      showToast("运行已终止", "warning");
    } else {
      setRunStatus(`已更新：${res.task_id}`, false);
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
    setRunStatus(`重跑中：${state.selectedTaskId}`, true);
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
    if (String(res?.summary?.final_outcome || "").toLowerCase() === "canceled") {
      showToast(`重跑已终止：${res.task_id}`, "warning");
      setRunStatus(`重跑已终止：${res.task_id}`, false);
    } else {
      showToast(`重跑完成：${res.task_id}`, "positive");
      setRunStatus(`重跑完成：${res.task_id}`, false);
    }
    await loadTasks();
    if (res.task_id) await selectTask(res.task_id);
  } catch (err) {
    setRunStatus(`重跑失败：${err.message}`, false);
    showToast(`重跑失败：${err.message}`, "negative");
  } finally {
    stopLivePolling();
    state.runningTaskId = null;
    setBusy(false);
  }
}

async function cancelCurrentRun() {
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

function jumpToBottom() {
  el.chatStream.scrollTop = el.chatStream.scrollHeight;
  updateJumpBottomVisibility();
}

async function handleComposerSubmit() {
  const raw = el.chatCommandInput.value.trim();
  const parsed = parseCliLikeCommand(raw);
  if (parsed.kind === "empty") return;
  if (parsed.kind === "help") {
    setRunStatus(commandHelpText(), false);
    return;
  }
  if (parsed.kind === "invalid") {
    showToast(parsed.error, "warning");
    setRunStatus(parsed.error, false);
    return;
  }
  if (parsed.kind === "task") {
    await runNewTaskFromCommand(parsed);
    return;
  }
  if (parsed.kind === "followup") {
    await sendFollowupInThread(parsed);
    return;
  }
  if (parsed.kind === "confirm") {
    await sendFollowupInThread(parsed);
    return;
  }
  if (parsed.kind === "rerun") {
    if (!state.selectedTaskId) {
      showToast("当前没有可重跑任务，请先 /task 新建任务。", "warning");
      return;
    }
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

async function startNewTaskDialog() {
  if (state.busy) return;
  const input = window.prompt("输入新对话任务：");
  if (input == null) return;
  const prompt = String(input || "").trim();
  if (!prompt) {
    showToast("任务内容不能为空", "warning");
    return;
  }
  await runNewTaskFromCommand({ prompt, provider: null, rounds: null });
}

el.taskSearch.addEventListener("input", applyFilter);
if (el.newChatBtn) el.newChatBtn.addEventListener("click", () => startNewTaskDialog().catch(() => {}));

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
Promise.all([loadRoleConfig(), loadTasks()])
  .catch((err) => {
    el.taskList.innerHTML = `<div class="empty-block">加载失败: ${err.message}</div>`;
    setRunStatus(`加载失败：${err.message}`, false);
  });
