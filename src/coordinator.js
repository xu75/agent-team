"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const { runCoder } = require("./agents/coder");
const { runReviewer } = require("./agents/reviewer");
const { runTester } = require("./agents/tester");
const {
  runTestCommands,
  DEFAULT_ALLOWED_PREFIXES,
  normalizeAllowedPrefixes,
} = require("./engine/test-runner");
const { createTaskLogDir, roundDir, writeText, writeJson } = require("./engine/task-logger");

const FSM_STATES = Object.freeze({
  INTAKE: "intake",
  PLAN: "plan",
  BUILD: "build",
  REVIEW: "review",
  TEST: "test",
  ITERATE: "iterate",
  FINALIZE: "finalize",
});

const STATE_LABELS = Object.freeze({
  [FSM_STATES.INTAKE]: "Intake",
  [FSM_STATES.PLAN]: "Plan",
  [FSM_STATES.BUILD]: "Build",
  [FSM_STATES.REVIEW]: "Review",
  [FSM_STATES.TEST]: "Test",
  [FSM_STATES.ITERATE]: "Iterate",
  [FSM_STATES.FINALIZE]: "Finalize",
});

const TESTER_BLOCKED_POLICIES = new Set(["strict", "resilient"]);

function normalizeTesterBlockedPolicy(value) {
  const policy = String(value || "").trim().toLowerCase();
  if (TESTER_BLOCKED_POLICIES.has(policy)) return policy;
  return "strict";
}

function summarizeTestRun(testRun) {
  const results = Array.isArray(testRun?.results) ? testRun.results : [];
  const blockedResults = results.filter((r) => r?.blocked === true);
  const runnableResults = results.filter((r) => r?.runnable === true);
  const retryableBlocked = blockedResults.filter((r) => r?.retryable_blocked === true);
  const maliciousBlocked = blockedResults.filter((r) => r?.blocked_severity === "malicious");
  const failedRunnable = runnableResults.find((r) => !r?.ok) || null;
  const firstBlocked = blockedResults[0] || null;
  return {
    blocked_commands: Number.isFinite(testRun?.blocked_commands)
      ? Number(testRun.blocked_commands)
      : blockedResults.length,
    runnable_commands: Number.isFinite(testRun?.runnable_commands)
      ? Number(testRun.runnable_commands)
      : runnableResults.length,
    retryable_blocked_commands: Number.isFinite(testRun?.retryable_blocked_commands)
      ? Number(testRun.retryable_blocked_commands)
      : retryableBlocked.length,
    malicious_blocked_commands: maliciousBlocked.length,
    first_blocked_command: testRun?.first_blocked_command || firstBlocked?.command || null,
    blocked_reason: testRun?.blocked_reason || firstBlocked?.blocked_reason || null,
    first_failed_runnable: failedRunnable,
    failed_runnable_commands: runnableResults.filter((r) => !r?.ok).length,
  };
}

function shouldRetryBlockedCommands({ policy, summary, retryCount = 0 }) {
  if (policy !== "resilient") return false;
  if (!summary || typeof summary !== "object") return false;
  if (retryCount >= 1) return false;
  if (summary.blocked_commands <= 0) return false;
  if (summary.runnable_commands !== 0) return false;
  if (summary.malicious_blocked_commands > 0) return false;
  return summary.retryable_blocked_commands === summary.blocked_commands;
}

function shouldFinalizeAsTesterCommandBlocked(summary) {
  if (!summary || typeof summary !== "object") return false;
  return summary.runnable_commands === 0 && summary.blocked_commands > 0;
}

function buildTesterBlockedRetryFeedback({
  blockedCommands = [],
  allowedPrefixes = DEFAULT_ALLOWED_PREFIXES,
}) {
  const blockedList = blockedCommands.length
    ? blockedCommands.map((cmd, idx) => `${idx + 1}. ${cmd}`).join("\n")
    : "1. (none)";
  const allowedList = allowedPrefixes.map((x) => `- ${x}`).join("\n");
  return [
    "Your previous commands were blocked by the allowlist. Re-generate commands with strict compliance.",
    "Blocked commands:",
    blockedList,
    "",
    "Allowed command prefixes:",
    allowedList,
    "",
    "Reusable valid examples:",
    "- node --test tests/**/*.test.js",
    "- npm test -- --grep \"keyword\"",
    "- pnpm test -- --filter unit",
  ].join("\n");
}

function copyRunArtifacts(runDir, roundPath, prefix) {
  if (!runDir) return;

  const eventsSrc = path.join(runDir, "events.jsonl");
  const rawSrc = path.join(runDir, "raw.ndjson");
  const eventsDst = path.join(roundPath, `${prefix}.events.jsonl`);
  const rawDst = path.join(roundPath, `${prefix}.raw.ndjson`);

  if (fs.existsSync(eventsSrc)) fs.copyFileSync(eventsSrc, eventsDst);
  if (fs.existsSync(rawSrc)) fs.copyFileSync(rawSrc, rawDst);
}

function buildTimeline(taskId, stateEvents) {
  const transitions = stateEvents.map((evt, idx) => {
    const next = stateEvents[idx + 1] || null;
    return {
      index: idx,
      ts: evt.ts,
      from: evt.from,
      to: evt.to,
      label: STATE_LABELS[evt.to] || evt.to,
      reason: evt.reason || null,
      round: Number.isFinite(evt.round) ? evt.round : null,
      duration_ms: next ? Math.max(0, next.ts - evt.ts) : null,
    };
  });

  const roundMap = new Map();
  for (const t of transitions) {
    if (!Number.isFinite(t.round)) continue;
    const current = roundMap.get(t.round) || {
      round: t.round,
      first_ts: t.ts,
      last_ts: t.ts,
      duration_ms: 0,
      states: [],
    };
    current.first_ts = Math.min(current.first_ts, t.ts);
    current.last_ts = Math.max(current.last_ts, t.ts);
    if (Number.isFinite(t.duration_ms)) {
      current.duration_ms += t.duration_ms;
    }
    current.states.push(t.to);
    roundMap.set(t.round, current);
  }

  const rounds = Array.from(roundMap.values()).sort((a, b) => a.round - b.round);
  const totalDurationMs =
    transitions.length > 1
      ? Math.max(0, transitions[transitions.length - 1].ts - transitions[0].ts)
      : 0;

  return {
    task_id: taskId,
    generated_at: Date.now(),
    total_transitions: transitions.length,
    total_duration_ms: totalDurationMs,
    transitions,
    rounds,
  };
}

function isProviderRunOk(result) {
  const code = Number(result?.exit?.code);
  const hasExitFailure = Number.isFinite(code) && code !== 0;
  return !result?.error_class && !hasExitFailure;
}

function clipText(text, maxLen = 1200) {
  const s = String(text || "").trim();
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return `${s.slice(0, Math.max(0, maxLen - 3))}...`;
}

function compactStringArray(list, maxItems = 8, maxItemLen = 220) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => clipText(x, maxItemLen))
    .filter(Boolean)
    .slice(0, Math.max(1, maxItems));
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

function writeWorkflowLog(title, fields = {}) {
  const lines = [`[workflow] ${title}`, `  time: ${formatLocalDateTime()}`];
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined || v === null || v === "") continue;
    lines.push(`  ${k}: ${v}`);
  }
  process.stdout.write(`\n${lines.join("\n")}\n`);
}

function createDiscussionContractHash(contract) {
  const base = JSON.stringify({
    version: contract?.version || 1,
    source_round: contract?.source_round || null,
    goal: contract?.goal || "",
    core_plan: contract?.core_plan || "",
    reviewer_notes: contract?.reviewer_notes || "",
    tester_notes: contract?.tester_notes || "",
    acceptance_criteria: contract?.acceptance_criteria || [],
    constraints: contract?.constraints || [],
    must_fix: contract?.must_fix || [],
    open_risks: contract?.open_risks || [],
  });
  return crypto.createHash("sha1").update(base).digest("hex").slice(0, 12);
}

function normalizeDiscussionContract(raw) {
  if (!raw || typeof raw !== "object") return null;
  const normalized = {
    version: Number.isFinite(raw.version) ? Number(raw.version) : 1,
    source_round: Number.isFinite(raw.source_round) ? Number(raw.source_round) : null,
    goal: clipText(raw.goal, 1200),
    core_plan: clipText(raw.core_plan, 2200),
    reviewer_notes: clipText(raw.reviewer_notes, 1200),
    tester_notes: clipText(raw.tester_notes, 1200),
    acceptance_criteria: compactStringArray(raw.acceptance_criteria, 10, 220),
    constraints: compactStringArray(raw.constraints, 10, 220),
    must_fix: compactStringArray(raw.must_fix, 10, 240),
    open_risks: compactStringArray(raw.open_risks, 10, 240),
    updated_at: Number.isFinite(raw.updated_at) ? Number(raw.updated_at) : Date.now(),
  };
  if (
    !normalized.goal &&
    !normalized.core_plan &&
    !normalized.reviewer_notes &&
    !normalized.tester_notes &&
    !normalized.must_fix.length
  ) {
    return null;
  }
  normalized.hash = raw.hash || createDiscussionContractHash(normalized);
  return normalized;
}

function extractAcceptanceCriteria(text) {
  const out = [];
  for (const line of String(text || "").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    if (/^(acceptance|criteria|验收|通过条件)/i.test(s) || /^[\-\*\d]+[.)]?\s+/.test(s)) {
      out.push(s.replace(/^[\-\*\d]+[.)]?\s+/, ""));
    }
    if (out.length >= 10) break;
  }
  return compactStringArray(out, 10, 220);
}

function extractConstraints(taskPrompt) {
  const out = [];
  for (const line of String(taskPrompt || "").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    if (/^(must|should|do not|don't|不能|不要|必须|禁止)/i.test(s)) out.push(s);
    if (out.length >= 10) break;
  }
  return compactStringArray(out, 10, 220);
}

function buildDiscussionContract({
  taskPrompt,
  proposalText,
  reviewerText,
  testerText,
  mustFix = [],
  sourceRound = null,
}) {
  const normalized = normalizeDiscussionContract({
    version: 1,
    source_round: Number.isFinite(sourceRound) ? Number(sourceRound) : null,
    goal: clipText(taskPrompt, 1200),
    core_plan: clipText(proposalText, 2200),
    reviewer_notes: clipText(reviewerText, 1200),
    tester_notes: clipText(testerText, 1200),
    acceptance_criteria: extractAcceptanceCriteria(`${reviewerText || ""}\n${testerText || ""}`),
    constraints: extractConstraints(taskPrompt),
    must_fix: compactStringArray(mustFix, 10, 240),
    open_risks: compactStringArray([], 10, 240),
    updated_at: Date.now(),
  });
  if (!normalized) return null;
  normalized.hash = createDiscussionContractHash(normalized);
  return normalized;
}

function buildFallbackDiscussionContract(taskDir, rounds, taskPrompt) {
  const proposalRounds = Array.isArray(rounds)
    ? rounds
      .filter((r) => r && r.phase === "proposal" && Number.isFinite(r.round))
      .map((r) => Number(r.round))
      .sort((a, b) => a - b)
    : [];
  if (!proposalRounds.length) return null;
  const sourceRound = proposalRounds[proposalRounds.length - 1];
  const proposalDir = path.join(taskDir, "rounds", String(sourceRound).padStart(2, "0"));
  if (!fs.existsSync(proposalDir)) return null;
  const readText = (name) => {
    const p = path.join(proposalDir, name);
    if (!fs.existsSync(p)) return "";
    return fs.readFileSync(p, "utf8");
  };
  return buildDiscussionContract({
    taskPrompt,
    proposalText: readText("coder_output.md"),
    reviewerText: readText("reviewer_raw.md"),
    testerText: readText("tester_raw.md"),
    sourceRound,
  });
}

async function runTask(taskPrompt, options = {}) {
  if (typeof taskPrompt !== "string" || !taskPrompt.trim()) {
    throw new Error("taskPrompt must be a non-empty string");
  }

  const provider = options.provider || "claude-cli";
  const model = options.model;
  const roleProviders = options.roleProviders || {};
  const roleProfiles = options.roleProfiles || {};
  const roleConfig = options.roleConfig || null;
  const maxIterations = Number.isFinite(options.maxIterations)
    ? Math.max(1, Math.floor(options.maxIterations))
    : 3;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10 * 60 * 1000;
  const testCommandTimeoutMs = Number.isFinite(options.testCommandTimeoutMs)
    ? options.testCommandTimeoutMs
    : 2 * 60 * 1000;
  const allowlist = normalizeAllowedPrefixes(
    Array.isArray(options.allowedTestCommands) ? options.allowedTestCommands : DEFAULT_ALLOWED_PREFIXES
  );
  const allowedTestCommands = allowlist.prefixes;
  const testerBlockedPolicy = normalizeTesterBlockedPolicy(
    options.testerBlockedPolicy || process.env.TESTER_BLOCKED_POLICY
  );
  const abortSignal = options.abortSignal || null;
  const projectId = options.projectId || null;
  const threadSlug = options.threadSlug || null;
  const logsRoot = String(options.logsRoot || "logs");
  const liveHooks = options.liveHooks && typeof options.liveHooks === "object"
    ? options.liveHooks
    : null;

  const appendToTask = !!options.appendToTask;
  const requestedMode = options.executionMode === "implementation" ? "implementation" : "proposal";
  const existingTaskId = options.taskId ? String(options.taskId) : null;
  const existingTaskDir = options.taskDir ? String(options.taskDir) : null;
  const created = appendToTask
    ? { taskId: existingTaskId, dir: existingTaskDir }
    : createTaskLogDir(logsRoot, options.taskId, threadSlug);
  const { taskId, dir: taskDir } = created;
  if (!taskId || !taskDir) {
    throw new Error("appendToTask requires both taskId and taskDir");
  }
  fs.mkdirSync(path.join(taskDir, "rounds"), { recursive: true });
  const taskEventsFile = path.join(taskDir, "task-events.jsonl");
  const priorSummary = appendToTask ? JSON.parse(JSON.stringify(safeSummary(taskDir))) : null;
  const awaitingOperatorConfirm = priorSummary?.awaiting_operator_confirm === true;
  const executionMode =
    options.operatorConfirmed || (awaitingOperatorConfirm && requestedMode === "implementation")
      ? "implementation"
      : requestedMode;

  if (!appendToTask) {
    writeText(path.join(taskDir, "task.md"), taskPrompt + "\n");
  }

  const rounds = priorSummary?.rounds ? [...priorSummary.rounds] : [];
  let mustFix = Array.isArray(priorSummary?.unresolved_must_fix) ? [...priorSummary.unresolved_must_fix] : [];
  let discussionContract = normalizeDiscussionContract(priorSummary?.discussion_contract);
  let finalOutcome = priorSummary?.final_outcome || "max_iterations_reached";
  if (executionMode === "implementation") {
    // Never inherit proposal outcomes into implementation runs.
    finalOutcome = "max_iterations_reached";
    if (!discussionContract) {
      discussionContract = buildFallbackDiscussionContract(taskDir, rounds, taskPrompt);
    }
    writeWorkflowLog(
      discussionContract ? "inherit_contract" : "inherit_contract_missing",
      discussionContract
        ? {
          task_id: taskId,
          source_round: discussionContract.source_round ?? "-",
          contract_version: discussionContract.version,
          contract_hash: discussionContract.hash,
          must_fix_count: discussionContract.must_fix.length,
        }
        : { task_id: taskId }
    );
  }
  let currentState = priorSummary?.final_status || null;
  const stateEvents = Array.isArray(priorSummary?.state_events) ? [...priorSummary.state_events] : [];

  if (allowlist.rejected.length) {
    writeWorkflowLog("allowed_test_commands_sanitized", {
      task_id: taskId,
      rejected_count: allowlist.rejected.length,
      used_fallback: allowlist.used_fallback ? "true" : "false",
    });
  }

  function transition(to, payload = {}) {
    const evt = {
      type: "fsm.transition",
      ts: Date.now(),
      task_id: taskId,
      from: currentState,
      to,
      ...payload,
    };
    currentState = to;
    stateEvents.push(evt);
    fs.appendFileSync(taskEventsFile, JSON.stringify(evt) + "\n", "utf8");
  }

  function providerFor(role) {
    const cfg = roleProviders[role];
    return cfg?.provider || provider;
  }

  function modelFor(role) {
    const cfg = roleProviders[role];
    return cfg?.model || model;
  }

  function settingsFileFor(role) {
    const cfg = roleProviders[role];
    return cfg?.settings_file || null;
  }

  function modelIdFor(role) {
    const cfg = roleProviders[role];
    return cfg?.model_id || null;
  }

  function profileFor(role) {
    const p = roleProfiles[role] || {};
    const displayName = p.display_name || role;
    const roleTitle = p.role_title || role;
    const nickname = p.nickname || p.alias || displayName;
    return {
      display_name: String(displayName),
      role_title: String(roleTitle),
      nickname: String(nickname),
    };
  }

  function peersFor(role) {
    const out = {};
    for (const k of ["coder", "reviewer", "tester"]) {
      if (k === role) continue;
      out[k] = profileFor(k);
    }
    return out;
  }

  function throwIfAborted() {
    if (abortSignal?.aborted) {
      const err = new Error("run aborted by operator");
      err.code = "ABORTED";
      throw err;
    }
  }

  function classifyUnhandledError(err) {
    const haystack = [err?.error_class, err?.code, err?.message]
      .map((x) => String(x || "").toLowerCase())
      .join(" ");
    if (haystack.includes("provider_unsupported") || haystack.includes("unsupported provider")) {
      return "provider_unsupported";
    }
    return "internal_error";
  }

  function emitLiveAgentState(role, patch = {}) {
    if (!liveHooks || typeof liveHooks.onAgentState !== "function") return;
    try {
      liveHooks.onAgentState({
        task_id: taskId,
        role,
        stage: role,
        ts: Date.now(),
        ...patch,
      });
    } catch {}
  }

  function emitLiveAgentEvent(role, event) {
    if (!liveHooks || typeof liveHooks.onAgentEvent !== "function") return;
    try {
      liveHooks.onAgentEvent({
        task_id: taskId,
        role,
        stage: role,
        ts: Date.now(),
        event,
      });
    } catch {}
  }

  try {
    throwIfAborted();
    transition(FSM_STATES.INTAKE, { reason: appendToTask ? "task_followup_received" : "task_received" });

    if (executionMode === "proposal") {
    const round = rounds.length + 1;
    const roundPath = roundDir(taskDir, round);

    transition(FSM_STATES.PLAN, { round, reason: "draft_proposal" });
      throwIfAborted();
      emitLiveAgentState("coder", { state: "thinking", run_mode: "proposal", round });
      const proposal = await runCoder({
      provider: providerFor("coder"),
      model: modelFor("coder"),
      settingsFile: settingsFileFor("coder"),
      roleProfile: profileFor("coder"),
      peerProfiles: peersFor("coder"),
      taskPrompt,
      mustFix,
      discussionContract,
      mode: "proposal",
      timeoutMs,
      abortSignal,
      eventMeta: {
        task_id: taskId,
        round_id: round,
        agent_role: "coder",
        attempt: round,
      },
      onLiveEvent: (evt) => emitLiveAgentEvent("coder", evt),
    });

    writeText(path.join(roundPath, "coder_output.md"), proposal.text);
    writeJson(path.join(roundPath, "coder_run.json"), {
      run_id: proposal.runId,
      run_dir: proposal.runDir,
      exit: proposal.exit,
      mode: "proposal",
    });
    copyRunArtifacts(proposal.runDir, roundPath, "coder");

    if (!isProviderRunOk(proposal) || !String(proposal.text || "").trim()) {
      emitLiveAgentState("coder", { state: "error", round, error: proposal.error_class || "coder_runtime_error" });
      const reason = proposal.error_class || "coder_runtime_error";
      finalOutcome = reason;
      mustFix = [`Coder failed in proposal phase: ${reason}`];
      rounds.push({
        round,
        phase: "proposal",
        coder: {
          run_id: proposal.runId,
          exit_code: proposal.exit?.code ?? null,
        },
        reviewer: null,
        tester: null,
      });
      transition(FSM_STATES.FINALIZE, {
        round,
        reason,
      });
    } else {
    emitLiveAgentState("coder", { state: "done", round });

    transition(FSM_STATES.REVIEW, { round, reason: "roundtable_reviewer" });
      throwIfAborted();
      emitLiveAgentState("reviewer", { state: "thinking", run_mode: "discussion", round });
      const reviewer = await runReviewer({
      provider: providerFor("reviewer"),
      model: modelFor("reviewer"),
      settingsFile: settingsFileFor("reviewer"),
      roleProfile: profileFor("reviewer"),
      peerProfiles: peersFor("reviewer"),
      taskPrompt,
      coderOutput: proposal.text,
      discussionContract,
      mode: "discussion",
      timeoutMs,
      abortSignal,
      eventMeta: {
        task_id: taskId,
        round_id: round,
        agent_role: "reviewer",
        attempt: round,
      },
      onLiveEvent: (evt) => emitLiveAgentEvent("reviewer", evt),
    });

    writeText(path.join(roundPath, "reviewer_raw.md"), reviewer.text);
    writeJson(path.join(roundPath, "reviewer.json"), reviewer.review);
    writeJson(path.join(roundPath, "reviewer_meta.json"), {
      ok: reviewer.ok,
      parse_error: reviewer.parse_error,
      error_class: reviewer.error_class || null,
      run_id: reviewer.runId,
      run_dir: reviewer.runDir,
      exit: reviewer.exit,
      mode: "discussion",
    });
    copyRunArtifacts(reviewer.runDir, roundPath, "reviewer");
    emitLiveAgentState(
      "reviewer",
      reviewer.ok
        ? { state: "done", round }
        : { state: "error", round, error: reviewer.error_class || reviewer.parse_error || "review_invalid" }
    );

    transition(FSM_STATES.TEST, { round, reason: "roundtable_tester" });
      throwIfAborted();
      emitLiveAgentState("tester", { state: "thinking", run_mode: "discussion", round });
      const tester = await runTester({
      provider: providerFor("tester"),
      model: modelFor("tester"),
      settingsFile: settingsFileFor("tester"),
      roleProfile: profileFor("tester"),
      peerProfiles: peersFor("tester"),
      taskPrompt,
      coderOutput: proposal.text,
      discussionContract,
      mode: "discussion",
      timeoutMs,
      abortSignal,
      eventMeta: {
        task_id: taskId,
        round_id: round,
        agent_role: "tester",
        attempt: round,
      },
      onLiveEvent: (evt) => emitLiveAgentEvent("tester", evt),
    });

    writeText(path.join(roundPath, "tester_raw.md"), tester.text);
    writeJson(path.join(roundPath, "tester.json"), tester.test_spec);
    writeJson(path.join(roundPath, "tester_meta.json"), {
      ok: tester.ok,
      parse_error: tester.parse_error,
      error_class: tester.error_class || null,
      run_id: tester.runId,
      run_dir: tester.runDir,
      exit: tester.exit,
      mode: "discussion",
    });
    copyRunArtifacts(tester.runDir, roundPath, "tester");
    emitLiveAgentState(
      "tester",
      tester.ok
        ? { state: "done", round }
        : { state: "error", round, error: tester.error_class || tester.parse_error || "tester_invalid" }
    );

    rounds.push({
      round,
      phase: "proposal",
      coder: {
        run_id: proposal.runId,
        exit_code: proposal.exit?.code ?? null,
      },
      reviewer: {
        run_id: reviewer.runId,
        ok: reviewer.ok,
        parse_error: reviewer.parse_error,
        decision: "discussion",
        must_fix_count: 0,
      },
      tester: {
        run_id: tester.runId,
        ok: tester.ok,
        parse_error: tester.parse_error,
        command_count: 0,
        tests_passed: null,
      },
    });

    discussionContract = buildDiscussionContract({
      taskPrompt,
      proposalText: proposal.text,
      reviewerText: reviewer.text,
      testerText: tester.text,
      sourceRound: round,
    }) || discussionContract;
    if (discussionContract) {
      writeWorkflowLog("proposal_contract_updated", {
        task_id: taskId,
        source_round: discussionContract.source_round ?? round,
        contract_hash: discussionContract.hash,
      });
    }

    finalOutcome = "awaiting_operator_confirm";
    mustFix = [];
    transition(FSM_STATES.FINALIZE, {
      round,
      reason: "await_operator_confirm",
    });
    }
    } else {
    transition(FSM_STATES.PLAN, { reason: "implementation_confirmed" });

    const startRound = rounds.length + 1;
    const endRoundExclusive = startRound + maxIterations;
      for (let round = startRound; round < endRoundExclusive; round += 1) {
      throwIfAborted();
      transition(FSM_STATES.BUILD, { round, reason: "start_coder" });

    const roundPath = roundDir(taskDir, round);
    const attempt = round;

      emitLiveAgentState("coder", { state: "thinking", run_mode: "implementation", round });
      const coder = await runCoder({
      provider: providerFor("coder"),
      model: modelFor("coder"),
      settingsFile: settingsFileFor("coder"),
      roleProfile: profileFor("coder"),
      peerProfiles: peersFor("coder"),
      taskPrompt,
      mustFix,
      discussionContract,
      mode: "implementation",
      timeoutMs,
      abortSignal,
      eventMeta: {
        task_id: taskId,
        round_id: round,
        agent_role: "coder",
        attempt,
      },
      onLiveEvent: (evt) => emitLiveAgentEvent("coder", evt),
    });

    writeText(path.join(roundPath, "coder_output.md"), coder.text);
    writeJson(path.join(roundPath, "coder_run.json"), {
      run_id: coder.runId,
      run_dir: coder.runDir,
      exit: coder.exit,
    });
    copyRunArtifacts(coder.runDir, roundPath, "coder");

    if (!isProviderRunOk(coder) || !String(coder.text || "").trim()) {
      emitLiveAgentState("coder", { state: "error", round, error: coder.error_class || "coder_runtime_error" });
      finalOutcome = coder.error_class || "coder_runtime_error";
      mustFix = [`Coder failed in implementation phase: ${finalOutcome}`];
      rounds.push({
        round,
        phase: "implementation",
        coder: {
          run_id: coder.runId,
          exit_code: coder.exit?.code ?? null,
        },
        reviewer: null,
      });
      transition(FSM_STATES.FINALIZE, {
        round,
        reason: finalOutcome,
      });
      break;
    }
    emitLiveAgentState("coder", { state: "done", round });

    transition(FSM_STATES.REVIEW, { round, reason: "start_reviewer" });

      throwIfAborted();
      emitLiveAgentState("reviewer", { state: "thinking", run_mode: "implementation", round });
      const reviewer = await runReviewer({
      provider: providerFor("reviewer"),
      model: modelFor("reviewer"),
      settingsFile: settingsFileFor("reviewer"),
      roleProfile: profileFor("reviewer"),
      peerProfiles: peersFor("reviewer"),
      taskPrompt,
      coderOutput: coder.text,
      discussionContract,
      timeoutMs,
      abortSignal,
      eventMeta: {
        task_id: taskId,
        round_id: round,
        agent_role: "reviewer",
        attempt,
      },
      onLiveEvent: (evt) => emitLiveAgentEvent("reviewer", evt),
    });

    writeText(path.join(roundPath, "reviewer_raw.md"), reviewer.text);
    writeJson(path.join(roundPath, "reviewer.json"), reviewer.review);
    writeJson(path.join(roundPath, "reviewer_meta.json"), {
      ok: reviewer.ok,
      parse_error: reviewer.parse_error,
      error_class: reviewer.error_class || null,
      run_id: reviewer.runId,
      run_dir: reviewer.runDir,
      exit: reviewer.exit,
    });
    copyRunArtifacts(reviewer.runDir, roundPath, "reviewer");
    emitLiveAgentState(
      "reviewer",
      reviewer.ok
        ? { state: "done", round }
        : { state: "error", round, error: reviewer.error_class || reviewer.parse_error || "review_invalid" }
    );
    const reviewerDecision = reviewer.review?.decision || "changes_requested";
    const reviewerMustFix = Array.isArray(reviewer.review?.must_fix) ? reviewer.review.must_fix : [];

    rounds.push({
      round,
      phase: "implementation",
      coder: {
        run_id: coder.runId,
        exit_code: coder.exit?.code ?? null,
      },
      reviewer: {
        run_id: reviewer.runId,
        ok: reviewer.ok,
        parse_error: reviewer.parse_error,
        decision: reviewerDecision,
        must_fix_count: reviewerMustFix.length,
      },
    });

    if (!reviewer.ok) {
      finalOutcome = reviewer.error_class || "review_schema_invalid";
      mustFix = reviewerMustFix;
      transition(FSM_STATES.FINALIZE, {
        round,
        reason: finalOutcome,
      });
      break;
    }

    if (reviewerDecision === "approve") {
      transition(FSM_STATES.TEST, { round, reason: "review_approved" });

      throwIfAborted();
      emitLiveAgentState("tester", { state: "thinking", run_mode: "implementation", round });
      let tester = await runTester({
        provider: providerFor("tester"),
        model: modelFor("tester"),
        settingsFile: settingsFileFor("tester"),
        roleProfile: profileFor("tester"),
        peerProfiles: peersFor("tester"),
        taskPrompt,
        coderOutput: coder.text,
        discussionContract,
        timeoutMs,
        abortSignal,
        eventMeta: {
          task_id: taskId,
          round_id: round,
          agent_role: "tester",
          attempt,
        },
        onLiveEvent: (evt) => emitLiveAgentEvent("tester", evt),
      });

      writeText(path.join(roundPath, "tester_raw.md"), tester.text);
      writeJson(path.join(roundPath, "tester.json"), tester.test_spec);
      writeJson(path.join(roundPath, "tester_meta.json"), {
        ok: tester.ok,
        parse_error: tester.parse_error,
        error_class: tester.error_class || null,
        run_id: tester.runId,
        run_dir: tester.runDir,
        exit: tester.exit,
      });
      copyRunArtifacts(tester.runDir, roundPath, "tester");

      if (!tester.ok) {
        const roundRef = rounds[rounds.length - 1];
        if (roundRef) {
          roundRef.tester = {
            run_id: tester.runId,
            ok: tester.ok,
            parse_error: tester.parse_error,
            command_count: 0,
            tests_passed: false,
            blocked_commands: 0,
            runnable_commands: 0,
            retry_used: false,
            retry_trigger: null,
            first_blocked_command: null,
            blocked_reason: null,
          };
        }
        emitLiveAgentState("tester", { state: "error", round, error: tester.error_class || tester.parse_error || "tester_invalid" });
        if (tester.error_class) {
          mustFix = [`Tester provider error: ${tester.error_class}`];
          finalOutcome = tester.error_class;
          transition(FSM_STATES.FINALIZE, {
            round,
            reason: finalOutcome,
          });
          break;
        }
        mustFix = ["Tester output schema invalid"];
        finalOutcome = "tester_schema_invalid";
        transition(FSM_STATES.ITERATE, {
          round,
          reason: "tester_schema_invalid",
        });
        continue;
      }

      let commands = Array.isArray(tester.test_spec?.commands) ? tester.test_spec.commands : [];
      let retryUsed = false;
      let retryTrigger = null;
      let testRun = null;
      let testSummary = null;
      let retryCount = 0;

      throwIfAborted();
      emitLiveAgentState("tester", { state: "tool", round, test_commands: commands.length });
      testRun = await runTestCommands(commands, {
        timeoutMs: testCommandTimeoutMs,
        cwd: process.cwd(),
        env: process.env,
        allowedPrefixes: allowedTestCommands,
        stopOnFailure: true,
        abortSignal,
        streamOutput: true,
      });
      testSummary = summarizeTestRun(testRun);

      if (shouldRetryBlockedCommands({ policy: testerBlockedPolicy, summary: testSummary, retryCount })) {
        retryUsed = true;
        retryCount = 1;
        retryTrigger = "all_blocked_allowlist_mismatch";
        writeJson(path.join(roundPath, "test-results-initial.json"), testRun);
        const blockedCommands = testRun.results
          .filter((r) => r?.blocked === true)
          .map((r) => r.command)
          .filter(Boolean);
        const retryFeedback = buildTesterBlockedRetryFeedback({
          blockedCommands,
          allowedPrefixes: allowedTestCommands,
        });
        writeText(path.join(roundPath, "tester_retry_feedback.txt"), retryFeedback + "\n");

        throwIfAborted();
        emitLiveAgentState("tester", {
          state: "thinking",
          run_mode: "implementation",
          round,
          retry: retryCount,
          retry_reason: retryTrigger,
        });
        tester = await runTester({
          provider: providerFor("tester"),
          model: modelFor("tester"),
          settingsFile: settingsFileFor("tester"),
          roleProfile: profileFor("tester"),
          peerProfiles: peersFor("tester"),
          taskPrompt,
          coderOutput: coder.text,
          discussionContract,
          retryFeedback,
          timeoutMs,
          abortSignal,
          eventMeta: {
            task_id: taskId,
            round_id: round,
            agent_role: "tester",
            attempt: `${attempt}-retry1`,
          },
          onLiveEvent: (evt) => emitLiveAgentEvent("tester", evt),
        });
        writeText(path.join(roundPath, "tester_retry_raw.md"), tester.text);
        writeJson(path.join(roundPath, "tester_retry.json"), tester.test_spec);
        writeJson(path.join(roundPath, "tester_retry_meta.json"), {
          ok: tester.ok,
          parse_error: tester.parse_error,
          error_class: tester.error_class || null,
          run_id: tester.runId,
          run_dir: tester.runDir,
          exit: tester.exit,
        });
        copyRunArtifacts(tester.runDir, roundPath, "tester_retry");

        if (tester.ok) {
          commands = Array.isArray(tester.test_spec?.commands) ? tester.test_spec.commands : [];
          throwIfAborted();
          emitLiveAgentState("tester", {
            state: "tool",
            round,
            test_commands: commands.length,
            retry: retryCount,
          });
          testRun = await runTestCommands(commands, {
            timeoutMs: testCommandTimeoutMs,
            cwd: process.cwd(),
            env: process.env,
            allowedPrefixes: allowedTestCommands,
            stopOnFailure: true,
            abortSignal,
            streamOutput: true,
          });
          testSummary = summarizeTestRun(testRun);
        }
      }

      writeJson(path.join(roundPath, "test-results.json"), testRun);
      writeText(
        path.join(roundPath, "test-results.txt"),
        testRun.results
          .map((r, idx) => {
            return [
              `# Command ${idx + 1}`,
              `cmd: ${r.command}`,
              `ok: ${r.ok}`,
              `runnable: ${r.runnable === true}`,
              `blocked: ${r.blocked === true}`,
              `blocked_reason: ${r.blocked_reason || "-"}`,
              `code: ${r.code}`,
              r.stdout ? `stdout:\n${r.stdout}` : "stdout:",
              r.stderr ? `stderr:\n${r.stderr}` : "stderr:",
              "",
            ].join("\n");
          })
          .join("\n")
      );

      const roundRef = rounds[rounds.length - 1];
      if (roundRef) {
        roundRef.tester = {
          run_id: tester.runId,
          ok: tester.ok,
          parse_error: tester.parse_error,
          command_count: commands.length,
          tests_passed: testRun.allPassed,
          blocked_commands: testSummary.blocked_commands,
          runnable_commands: testSummary.runnable_commands,
          retry_used: retryUsed,
          retry_trigger: retryTrigger,
          first_blocked_command: testSummary.first_blocked_command,
          blocked_reason: testSummary.blocked_reason,
        };
      }

      if (!tester.ok) {
        emitLiveAgentState("tester", { state: "error", round, error: tester.error_class || tester.parse_error || "tester_invalid" });
        if (tester.error_class) {
          mustFix = [`Tester provider error: ${tester.error_class}`];
          finalOutcome = tester.error_class;
          transition(FSM_STATES.FINALIZE, {
            round,
            reason: finalOutcome,
          });
          break;
        }
        mustFix = ["Tester output schema invalid"];
        finalOutcome = "tester_schema_invalid";
        transition(FSM_STATES.ITERATE, {
          round,
          reason: "tester_schema_invalid",
        });
        continue;
      }

      if (!testRun.allPassed) {
        emitLiveAgentState("tester", { state: "error", round, error: "test_failed" });

        if (shouldFinalizeAsTesterCommandBlocked(testSummary)) {
          mustFix = [
            `Tester generated blocked command(s): ${testRun.results
              .filter((r) => r?.blocked === true)
              .map((r) => r.command)
              .join("; ")}`,
            `First blocked reason: ${testSummary.blocked_reason || "unknown"}`,
            `Only allowed: ${allowedTestCommands.join(", ")}`,
          ];
          finalOutcome = "tester_command_blocked";
          transition(FSM_STATES.FINALIZE, { round, reason: "tester_command_blocked" });
          break;
        }

        const failed = testSummary.first_failed_runnable || testRun.results.find((r) => r.runnable === true && !r.ok);
        const stderrSnippet = failed?.stderr ? failed.stderr.slice(0, 500) : "";
        mustFix = [
          "Tests failed in tester stage",
          failed ? `Failed command: ${failed.command}` : "Unknown test failure",
          stderrSnippet ? `Error output: ${stderrSnippet}` : "",
        ].filter(Boolean);

        // Save failed command for repeated-failure detection
        const roundRef2 = rounds[rounds.length - 1];
        if (roundRef2) {
          roundRef2._failed_command = failed ? failed.command : null;
        }

        // Check for repeated identical failure
        const prevRound = rounds.length >= 2 ? rounds[rounds.length - 2] : null;
        if (prevRound?._failed_command && failed && prevRound._failed_command === failed.command) {
          finalOutcome = "repeated_test_failure";
          transition(FSM_STATES.FINALIZE, { round, reason: "repeated_test_failure" });
          break;
        }

        finalOutcome = "test_failed";
        transition(FSM_STATES.ITERATE, {
          round,
          reason: "tests_failed",
          failed_command: failed ? failed.command : null,
        });
        continue;
      }

      finalOutcome = "approved";
      mustFix = [];
      emitLiveAgentState("tester", {
        state: "done",
        round,
        tests_passed: true,
        blocked_commands: testSummary.blocked_commands,
        runnable_commands: testSummary.runnable_commands,
      });
      transition(FSM_STATES.FINALIZE, { round, reason: "tests_passed" });
      break;
    }

    mustFix = reviewerMustFix;
    finalOutcome = "review_changes_requested";
    transition(FSM_STATES.ITERATE, {
      round,
      reason: "review_changes_requested",
      must_fix_count: mustFix.length,
    });
  }
    }
  } catch (err) {
    if (err?.code === "ABORTED") {
      finalOutcome = "canceled";
      mustFix = [];
      if (currentState !== FSM_STATES.FINALIZE) {
        transition(FSM_STATES.FINALIZE, { reason: "aborted_by_operator" });
      }
    } else {
      const errorMessage = clipText(err?.message || String(err), 600);
      finalOutcome = classifyUnhandledError(err);
      mustFix = [`Unhandled workflow error: ${errorMessage}`];
      writeWorkflowLog("unhandled_error", {
        task_id: taskId,
        outcome: finalOutcome,
        message: errorMessage,
      });
      if (err?.stack) {
        process.stderr.write(`[workflow] stack task=${taskId}\n${String(err.stack)}\n`);
      }
      if (currentState !== FSM_STATES.FINALIZE) {
        transition(FSM_STATES.FINALIZE, {
          reason: finalOutcome,
          error_message: errorMessage,
        });
      }
    }
  }

  if (currentState !== FSM_STATES.FINALIZE) {
    if (executionMode === "implementation" && finalOutcome === "awaiting_operator_confirm") {
      finalOutcome = mustFix.length ? "review_changes_requested" : "max_iterations_reached";
    }
    transition(FSM_STATES.FINALIZE, {
      reason: finalOutcome === "max_iterations_reached" ? "max_iterations_reached" : "finalized",
    });
  }

  const summary = {
    task_id: taskId,
    task_dir: taskDir,
    project_id: projectId || undefined,
    thread_id: threadSlug || projectId || undefined,
    timeline_file: path.join(taskDir, "task-timeline.json"),
    provider,
    model: model || null,
    role_providers: {
      coder: {
        model_id: modelIdFor("coder"),
        provider: providerFor("coder"),
        model: modelFor("coder") || null,
      },
      reviewer: {
        model_id: modelIdFor("reviewer"),
        provider: providerFor("reviewer"),
        model: modelFor("reviewer") || null,
      },
      tester: {
        model_id: modelIdFor("tester"),
        provider: providerFor("tester"),
        model: modelFor("tester") || null,
      },
    },
    role_profiles: {
      coder: profileFor("coder"),
      reviewer: profileFor("reviewer"),
      tester: profileFor("tester"),
    },
    role_config: roleConfig,
    final_status: currentState,
    final_outcome: finalOutcome,
    awaiting_operator_confirm: finalOutcome === "awaiting_operator_confirm",
    workflow_phase: executionMode,
    tester_blocked_policy: testerBlockedPolicy,
    allowed_test_commands: allowedTestCommands,
    max_iterations: maxIterations,
    fsm_states: Object.values(FSM_STATES),
    state_events: stateEvents,
    rounds,
    unresolved_must_fix: mustFix,
    discussion_contract: discussionContract || null,
    discussion_contract_hash: discussionContract?.hash || null,
    discussion_contract_source_round: discussionContract?.source_round ?? null,
  };
  const timeline = buildTimeline(taskId, stateEvents);

  writeJson(path.join(taskDir, "summary.json"), summary);
  writeJson(path.join(taskDir, "task-timeline.json"), timeline);

  return summary;
}

function safeSummary(taskDir) {
  try {
    const raw = fs.readFileSync(path.join(taskDir, "summary.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function runOnce(prompt, options = {}) {
  const summary = await runTask(prompt, options);
  const lastRound = summary.rounds[summary.rounds.length - 1] || null;
  return { summary, review: lastRound ? lastRound.reviewer : null };
}

module.exports = {
  FSM_STATES,
  normalizeTesterBlockedPolicy,
  summarizeTestRun,
  shouldRetryBlockedCommands,
  shouldFinalizeAsTesterCommandBlocked,
  buildTesterBlockedRetryFeedback,
  runTask,
  runOnce,
};
