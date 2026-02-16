const state = {
  tasks: [],
  filtered: [],
  selectedTaskId: null,
  selectedRound: null,
  statusFilter: "all",
  detail: null,
  messagesData: null,
  busy: false,
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
  runPromptInput: document.getElementById("runPromptInput"),
  runProviderSelect: document.getElementById("runProviderSelect"),
  runIterationsInput: document.getElementById("runIterationsInput"),
  runTaskBtn: document.getElementById("runTaskBtn"),
  runTaskStatus: document.getElementById("runTaskStatus"),
  liveStage: document.getElementById("liveStage"),
  agentStatus: document.getElementById("agentStatus"),
  stats: document.getElementById("stats"),
  latestFailure: document.getElementById("latestFailure"),
  testResults: document.getElementById("testResults"),
  evidenceMeta: document.getElementById("evidenceMeta"),
  evidenceViewer: document.getElementById("evidenceViewer"),
  mustFixList: document.getElementById("mustFixList"),
};

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

function setRunStatus(text = "", running = false) {
  el.runTaskStatus.className = running ? "run-status running" : "run-status";
  el.runTaskStatus.textContent = text;
}

function updateActionAvailability() {
  const hasTask = !!state.selectedTaskId;
  const busy = !!state.busy;
  el.runTaskBtn.disabled = busy;
  el.refreshBtn.disabled = busy;
  el.runPromptInput.disabled = busy;
  el.runProviderSelect.disabled = busy;
  el.runIterationsInput.disabled = busy;
  el.copyTaskBtn.disabled = busy || !hasTask;
  el.exportReportBtn.disabled = busy || !hasTask;
  el.rerunTaskBtn.disabled = busy || !hasTask;
  el.clearRoundBtn.disabled = busy || !hasTask;
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
  if (!Number.isFinite(state.selectedRound)) return all;
  return all.filter((m) => m.round === state.selectedRound || m.role === "task");
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
    item.innerHTML = `
      <header>
        <div class="lhs">
          <span class="avatar">${roleAvatar(m.role)}</span>
          <span class="role">${m.role_label}</span>
          ${Number.isFinite(m.round) ? `<span class="round">R${m.round}</span>` : ""}
          <span class="dot ${statusDot}"></span>
        </div>
        <time>${fmtTime(m.ts)}</time>
      </header>
      <div class="meta">${metaLine(m) || "no runtime metadata"}</div>
      <pre>${m.text || ""}</pre>
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
  const outcome = state.messagesData?.final_outcome || state.detail?.summary?.final_outcome || "-";
  const tone = toneFromOutcome(outcome);
  const progress = state.messagesData?.progress || {};
  const done = progress.rounds_total ?? 0;
  const total = progress.rounds_max ?? "-";

  el.liveStage.innerHTML = `
    <div class="stage-card ${tone}">
      <div class="k">Current Stage</div>
      <div class="v">${current}</div>
      <div class="k">Progress</div>
      <div class="v">${done} / ${total}</div>
    </div>
  `;
}

function renderAgentStatus() {
  const messages = state.messagesData?.messages || [];
  const latest = { coder: null, reviewer: null, tester: null };
  for (const m of messages) {
    if (!["coder", "reviewer", "tester"].includes(m.role)) continue;
    if (!latest[m.role] || (m.ts || 0) >= (latest[m.role].ts || 0)) {
      latest[m.role] = m;
    }
  }

  const rows = ["coder", "reviewer", "tester"].map((role) => {
    const m = latest[role];
    const status = !m ? "idle" : m.ok === false ? "error" : m.ok === true ? "ok" : "running";
    return `
      <div class="agent-row">
        <span class="name">${roleAvatar(role)} ${role}</span>
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
    { k: "Rounds", v: (summary.rounds || []).length, cls: "stat" },
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
  el.latestFailure.textContent = `${failed.role_label} R${failed.round ?? "-"}\n${
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
  if (summary.provider && !state.busy) {
    el.runProviderSelect.value = summary.provider;
  }
  if (Number.isFinite(summary.max_iterations) && !state.busy) {
    el.runIterationsInput.value = String(summary.max_iterations);
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

async function runNewTaskFromComposer() {
  const prompt = el.runPromptInput.value.trim();
  if (!prompt) {
    showToast("请先输入任务描述", "warning");
    return;
  }

  const provider = el.runProviderSelect.value || "claude-cli";
  const maxIterations = Number(el.runIterationsInput.value || 3);

  try {
    setBusy(true);
    setRunStatus("正在运行任务...", true);
    const res = await postJson("/api/tasks/run", {
      prompt,
      provider,
      maxIterations: Number.isFinite(maxIterations) ? Math.max(1, maxIterations) : 3,
    });
    showToast(`任务已完成：${res.task_id}`, "positive");
    el.runPromptInput.value = "";
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

async function rerunCurrentTask() {
  if (!state.selectedTaskId) return;
  try {
    setBusy(true);
    setRunStatus(`重跑中：${state.selectedTaskId}`, true);
    const promptOverride = el.runPromptInput.value.trim();
    const provider = el.runProviderSelect.value || undefined;
    const maxIterations = Number(el.runIterationsInput.value || 3);
    const res = await postJson(`/api/tasks/${state.selectedTaskId}/rerun`, {
      prompt: promptOverride || undefined,
      provider,
      maxIterations: Number.isFinite(maxIterations) ? Math.max(1, maxIterations) : 3,
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
el.runTaskBtn.addEventListener("click", runNewTaskFromComposer);
el.runPromptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    runNewTaskFromComposer();
  }
});

setRunStatus("就绪", false);
updateActionAvailability();
loadTasks().catch((err) => {
  el.taskList.innerHTML = `<div class="empty-block">加载失败: ${err.message}</div>`;
  setRunStatus(`加载失败：${err.message}`, false);
});
