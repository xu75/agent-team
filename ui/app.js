const state = {
  tasks: [],
  filtered: [],
  selectedTaskId: null,
  selectedRound: null,
  statusFilter: "all",
  detail: null,
  messagesData: null,
  roleConfig: null,
  busy: false,
  optimisticMessages: [],
  livePollTimer: null,
  livePollBusy: false,
};

const el = {
  taskList: document.getElementById("taskList"),
  taskSearch: document.getElementById("taskSearch"),
  refreshBtn: document.getElementById("refreshBtn"),
  statusFilters: document.getElementById("statusFilters"),
  taskTitle: document.getElementById("taskTitle"),
  taskMeta: document.getElementById("taskMeta"),
  timeline: document.getElementById("timeline"),
  roundTag: document.getElementById("roundTag"),
  copyTaskBtn: document.getElementById("copyTaskBtn"),
  exportReportBtn: document.getElementById("exportReportBtn"),
  rerunTaskBtn: document.getElementById("rerunTaskBtn"),
  clearRoundBtn: document.getElementById("clearRoundBtn"),
  chatStream: document.getElementById("chatStream"),
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
  if (s.includes("max_iterations") || s.includes("changes_requested")) return "warning";
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

function fmtCost(v) {
  if (!Number.isFinite(v)) return null;
  return `$${v.toFixed(4)}`;
}

function previewLine(t) {
  const raw = String(t?.last_preview || "").trim();
  if (!raw) return "暂无预览";
  return raw.length > 56 ? `${raw.slice(0, 56)}...` : raw;
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
  el.sendCommandBtn.disabled = busy;
  el.refreshBtn.disabled = busy;
  el.chatCommandInput.disabled = busy;
  el.copyTaskBtn.disabled = busy || !hasTask;
  el.exportReportBtn.disabled = busy || !hasTask;
  el.rerunTaskBtn.disabled = busy || !hasTask;
  el.clearRoundBtn.disabled = busy || !hasTask;
  el.saveRolesBtn.disabled = busy;
}

function setBusy(v) {
  state.busy = v;
  updateActionAvailability();
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

function renderTasks() {
  el.taskList.innerHTML = "";
  if (!state.filtered.length) {
    el.taskList.innerHTML =
      '<div class="empty-block">暂无任务。先运行一次 <code>node src/index.js "你的任务"</code> 生成日志。</div>';
    return;
  }

  const groups = taskGroups(state.filtered);
  groups.forEach(([date, list]) => {
    const section = document.createElement("section");
    section.className = "task-section";
    section.innerHTML = `<div class="task-section-title">${date}</div>`;
    const box = document.createElement("div");
    box.className = "task-section-list";

    list.forEach((t) => {
      const row = document.createElement("div");
      row.className =
        `task-item tone-${t.status_tone || toneFromOutcome(t.final_outcome)}` +
        (t.task_id === state.selectedTaskId ? " active" : "");
      row.innerHTML = `
        <div class="task-head">
          <div class="id">${t.task_id}</div>
          <div class="task-right">
            <span class="mini-time">${fmtTime(t.updated_ts)}</span>
            ${Number(t.alert_count) > 0 ? `<span class="alert-badge">${t.alert_count}</span>` : ""}
          </div>
        </div>
        <div class="main">${t.provider} · ${t.final_outcome || "-"}</div>
        <div class="preview">${previewLine(t)}</div>
        <div class="id">rounds ${t.rounds}</div>
      `;
      row.addEventListener("click", () => selectTask(t.task_id));
      box.appendChild(row);
    });

    section.appendChild(box);
    el.taskList.appendChild(section);
  });
}

function applyFilter() {
  const q = el.taskSearch.value.trim().toLowerCase();
  state.filtered = state.tasks.filter((t) => {
    const tone = t.status_tone || toneFromOutcome(t.final_outcome);
    if (state.statusFilter !== "all" && tone !== state.statusFilter) return false;
    if (!q) return true;
    return (
      t.task_id.toLowerCase().includes(q) ||
      String(t.provider).toLowerCase().includes(q) ||
      String(t.final_outcome).toLowerCase().includes(q) ||
      String(t.last_preview || "").toLowerCase().includes(q)
    );
  });
  renderTasks();
}

function setStatusFilter(v) {
  state.statusFilter = v;
  Array.from(el.statusFilters.querySelectorAll(".chip")).forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.filter === v);
  });
  applyFilter();
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
    state.detail = detail;
    state.messagesData = messages;
    renderTaskPage();
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
  const prev = el.chatStream;
  const prevScrollTop = prev.scrollTop;
  const prevScrollHeight = prev.scrollHeight;
  const prevClientHeight = prev.clientHeight;
  const nearBottom = prevScrollHeight - prevScrollTop - prevClientHeight < 64;
  el.chatStream.innerHTML = "";
  if (!messages.length) {
    el.chatStream.innerHTML = '<div class="empty-block">当前筛选条件下没有消息。</div>';
    return;
  }
  messages.forEach((m) => {
    const item = document.createElement("article");
    item.className = `chat-msg role-${m.role}`;
    const statusDot = m.ok === false ? "status-bad" : m.ok === true ? "status-ok" : "status-idle";
    const evidenceButtons =
      Number.isFinite(m.round) && m.role !== "task"
        ? evidenceKindsForRole(m.role)
            .map(
              (kind) =>
                `<button class="ev-btn" data-round="${m.round}" data-role="${m.role}" data-kind="${kind}">${kind}</button>`
            )
            .join("")
        : "";
    const meta = metaLine(m);
    const metaHtml = meta ? `<div class="meta">${meta}</div>` : "";
    const renderedText = renderMessageText(m);
    const rawText = String(renderedText || "");
    const lineCount = rawText.split("\n").length;
    const collapsible = rawText.length > 700 || lineCount > 18;
    const textHtml = collapsible
      ? `<pre class="msg-text collapsed" data-collapsible="1">${rawText}</pre>
         <button class="toggle-expand" data-expand-btn="1">展开全文</button>`
      : `<pre class="msg-text">${rawText}</pre>`;
    item.innerHTML = `
      <header>
        <div class="lhs">
          <span class="avatar">${roleAvatar(m.role)}</span>
          <span class="role">${displayRoleLabel(m.role, m.role_label)}</span>
          ${Number.isFinite(m.round) ? `<span class="round">R${m.round}</span>` : ""}
          <span class="dot ${statusDot}"></span>
        </div>
        <time>${fmtTime(m.ts)}</time>
      </header>
      ${metaHtml}
      ${textHtml}
      ${evidenceButtons ? `<div class="evidence-row"><span>Evidence:</span>${evidenceButtons}</div>` : ""}
    `;
    el.chatStream.appendChild(item);
  });

  Array.from(el.chatStream.querySelectorAll(".ev-btn")).forEach((btn) => {
    btn.addEventListener("click", () => {
      const round = Number(btn.dataset.round);
      const role = btn.dataset.role;
      const kind = btn.dataset.kind;
      openEvidence(round, role, kind);
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
}

function renderRoundTag() {
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
      `/task --provider ${provider} --rounds ${rounds} 你的任务；/rerun 继续当前任务`;
  }
}

function renderTaskPage() {
  const summary = state.detail?.summary || {};
  el.taskTitle.textContent = `协作对话 · ${state.selectedTaskId}`;
  el.taskMeta.textContent = `${summary.provider || "-"} · ${summary.final_outcome || "-"}`;
  el.taskMeta.className = `meta-pill ${toneFromOutcome(summary.final_outcome)}`.trim();
  renderRoundTag();
  renderTimeline();
  renderChat();
  renderLiveStage();
  renderAgentStatus();
  renderStats();
  renderLatestFailure();
  renderMustFix();
  renderRoundTestResults().catch(() => {});
  renderEvidencePlaceholder();
  syncComposerWithCurrentTask();
  updateActionAvailability();
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
  renderTaskPage();
}

function renderEmptyScreen() {
  el.taskTitle.textContent = "协作对话";
  el.taskMeta.className = "meta-pill";
  el.taskMeta.textContent = "暂无任务";
  el.timeline.innerHTML = '<div class="timeline-empty">还没有任务数据。</div>';
  el.roundTag.textContent = "All Rounds";
  el.chatStream.innerHTML = '<div class="empty-block">先运行一个任务，然后在这里查看多 Agent 对话回放。</div>';
  el.liveStage.innerHTML = '<div class="stage-card"><div class="k">Current Stage</div><div class="v">-</div></div>';
  el.agentStatus.innerHTML = "";
  el.stats.innerHTML = "";
  el.latestFailure.className = "plain-block warning";
  el.latestFailure.textContent = "暂无失败信息。";
  el.testResults.className = "plain-block warning";
  el.testResults.textContent = "暂无测试结果。";
  el.mustFixList.innerHTML = "<li>无</li>";
  renderEvidencePlaceholder();
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

  return { kind: "invalid", error: `未知命令 /${cmd}。可用命令：/task /ask /rerun /help` };
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

async function sendFollowupInThread({ message, provider, rounds }) {
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
    setBusy(true);
    setRunStatus(`追问中：${taskId}`, true);
    startLivePolling(taskId);
    const res = await postJson(`/api/tasks/${taskId}/followup`, {
      message,
      provider: resolvedProvider(provider),
      maxIterations: resolvedRounds(rounds),
      role_config: state.roleConfig || DEFAULT_ROLE_CONFIG,
      client_message_id: clientMessageId,
    });
    setRunStatus(`已更新：${res.task_id}`, false);
    showToast("追问已加入当前会话", "positive");
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
    setBusy(false);
  }
}

async function rerunCurrentTask(opts = {}) {
  if (!state.selectedTaskId) return;
  try {
    setBusy(true);
    setRunStatus(`重跑中：${state.selectedTaskId}`, true);
    const promptOverride = String(opts.prompt || "").trim();
    const provider = opts.provider || undefined;
    const maxIterations = resolvedRounds(opts.rounds);
    const res = await postJson(`/api/tasks/${state.selectedTaskId}/rerun`, {
      prompt: promptOverride || undefined,
      provider,
      maxIterations,
      role_config: state.roleConfig || DEFAULT_ROLE_CONFIG,
    });
    showToast(`重跑完成：${res.task_id}`, "positive");
    setRunStatus(`重跑完成：${res.task_id}`, false);
    await loadTasks();
    if (res.task_id) await selectTask(res.task_id);
  } catch (err) {
    setRunStatus(`重跑失败：${err.message}`, false);
    showToast(`重跑失败：${err.message}`, "negative");
  } finally {
    setBusy(false);
  }
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

el.taskSearch.addEventListener("input", applyFilter);
el.refreshBtn.addEventListener("click", () => {
  loadTasks().catch((err) => {
    el.taskList.innerHTML = `<div class="empty-block">刷新失败: ${err.message}</div>`;
  });
});
Array.from(el.statusFilters.querySelectorAll(".chip")).forEach((btn) => {
  btn.addEventListener("click", () => setStatusFilter(btn.dataset.filter || "all"));
});

el.clearRoundBtn.addEventListener("click", clearRoundFilter);
el.copyTaskBtn.addEventListener("click", copyCurrentTaskId);
el.exportReportBtn.addEventListener("click", exportCurrentReport);
el.rerunTaskBtn.addEventListener("click", rerunCurrentTask);
el.sendCommandBtn.addEventListener("click", handleComposerSubmit);
el.chatCommandInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleComposerSubmit();
  }
});
el.saveRolesBtn.addEventListener("click", saveRoleConfig);

setRunStatus(commandHelpText(), false);
updateActionAvailability();
Promise.all([loadRoleConfig(), loadTasks()])
  .catch((err) => {
    el.taskList.innerHTML = `<div class="empty-block">加载失败: ${err.message}</div>`;
    setRunStatus(`加载失败：${err.message}`, false);
  });
