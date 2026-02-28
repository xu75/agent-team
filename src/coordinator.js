"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { runCoder } = require("./agents/coder");
const { runReviewer } = require("./agents/reviewer");
const { runTester } = require("./agents/tester");
const { runTestCommands, DEFAULT_ALLOWED_PREFIXES } = require("./engine/test-runner");
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
  const allowedTestCommands = Array.isArray(options.allowedTestCommands)
    ? options.allowedTestCommands
    : DEFAULT_ALLOWED_PREFIXES;
  const abortSignal = options.abortSignal || null;

  const appendToTask = !!options.appendToTask;
  const requestedMode = options.executionMode === "implementation" ? "implementation" : "proposal";
  const existingTaskId = options.taskId ? String(options.taskId) : null;
  const existingTaskDir = options.taskDir ? String(options.taskDir) : null;
  const created = appendToTask
    ? { taskId: existingTaskId, dir: existingTaskDir }
    : createTaskLogDir("logs", options.taskId);
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
  let finalOutcome = priorSummary?.final_outcome || "max_iterations_reached";
  if (executionMode === "implementation") {
    // Never inherit proposal outcomes into implementation runs.
    finalOutcome = "max_iterations_reached";
  }
  let currentState = priorSummary?.final_status || null;
  const stateEvents = Array.isArray(priorSummary?.state_events) ? [...priorSummary.state_events] : [];

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

  try {
    throwIfAborted();
    transition(FSM_STATES.INTAKE, { reason: appendToTask ? "task_followup_received" : "task_received" });

    if (executionMode === "proposal") {
    const round = rounds.length + 1;
    const roundPath = roundDir(taskDir, round);

    transition(FSM_STATES.PLAN, { round, reason: "draft_proposal" });
      throwIfAborted();
      const proposal = await runCoder({
      provider: providerFor("coder"),
      model: modelFor("coder"),
      settingsFile: settingsFileFor("coder"),
      roleProfile: profileFor("coder"),
      peerProfiles: peersFor("coder"),
      taskPrompt,
      mustFix,
      mode: "proposal",
      timeoutMs,
      abortSignal,
      eventMeta: {
        task_id: taskId,
        round_id: round,
        agent_role: "coder",
        attempt: round,
      },
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

    transition(FSM_STATES.REVIEW, { round, reason: "roundtable_reviewer" });
      throwIfAborted();
      const reviewer = await runReviewer({
      provider: providerFor("reviewer"),
      model: modelFor("reviewer"),
      settingsFile: settingsFileFor("reviewer"),
      roleProfile: profileFor("reviewer"),
      peerProfiles: peersFor("reviewer"),
      taskPrompt,
      coderOutput: proposal.text,
      mode: "discussion",
      timeoutMs,
      abortSignal,
      eventMeta: {
        task_id: taskId,
        round_id: round,
        agent_role: "reviewer",
        attempt: round,
      },
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

    transition(FSM_STATES.TEST, { round, reason: "roundtable_tester" });
      throwIfAborted();
      const tester = await runTester({
      provider: providerFor("tester"),
      model: modelFor("tester"),
      settingsFile: settingsFileFor("tester"),
      roleProfile: profileFor("tester"),
      peerProfiles: peersFor("tester"),
      taskPrompt,
      coderOutput: proposal.text,
      mode: "discussion",
      timeoutMs,
      abortSignal,
      eventMeta: {
        task_id: taskId,
        round_id: round,
        agent_role: "tester",
        attempt: round,
      },
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

    rounds.push({
      round,
      phase: "proposal",
      coder: {
        run_id: proposal.runId,
        exit_code: proposal.exit.code,
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

      const coder = await runCoder({
      provider: providerFor("coder"),
      model: modelFor("coder"),
      settingsFile: settingsFileFor("coder"),
      roleProfile: profileFor("coder"),
      peerProfiles: peersFor("coder"),
      taskPrompt,
      mustFix,
      mode: "implementation",
      timeoutMs,
      abortSignal,
      eventMeta: {
        task_id: taskId,
        round_id: round,
        agent_role: "coder",
        attempt,
      },
    });

    writeText(path.join(roundPath, "coder_output.md"), coder.text);
    writeJson(path.join(roundPath, "coder_run.json"), {
      run_id: coder.runId,
      run_dir: coder.runDir,
      exit: coder.exit,
    });
    copyRunArtifacts(coder.runDir, roundPath, "coder");

    if (!isProviderRunOk(coder) || !String(coder.text || "").trim()) {
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

    transition(FSM_STATES.REVIEW, { round, reason: "start_reviewer" });

      throwIfAborted();
      const reviewer = await runReviewer({
      provider: providerFor("reviewer"),
      model: modelFor("reviewer"),
      settingsFile: settingsFileFor("reviewer"),
      roleProfile: profileFor("reviewer"),
      peerProfiles: peersFor("reviewer"),
      taskPrompt,
      coderOutput: coder.text,
      timeoutMs,
      abortSignal,
      eventMeta: {
        task_id: taskId,
        round_id: round,
        agent_role: "reviewer",
        attempt,
      },
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

    rounds.push({
      round,
      phase: "implementation",
      coder: {
        run_id: coder.runId,
        exit_code: coder.exit.code,
      },
      reviewer: {
        run_id: reviewer.runId,
        ok: reviewer.ok,
        parse_error: reviewer.parse_error,
        decision: reviewer.review.decision,
        must_fix_count: reviewer.review.must_fix.length,
      },
    });

    if (!reviewer.ok) {
      finalOutcome = reviewer.error_class || "review_schema_invalid";
      mustFix = reviewer.review.must_fix;
      transition(FSM_STATES.FINALIZE, {
        round,
        reason: finalOutcome,
      });
      break;
    }

    if (reviewer.review.decision === "approve") {
      transition(FSM_STATES.TEST, { round, reason: "review_approved" });

      throwIfAborted();
      const tester = await runTester({
        provider: providerFor("tester"),
        model: modelFor("tester"),
        settingsFile: settingsFileFor("tester"),
        roleProfile: profileFor("tester"),
        peerProfiles: peersFor("tester"),
        taskPrompt,
        coderOutput: coder.text,
        timeoutMs,
        abortSignal,
        eventMeta: {
          task_id: taskId,
          round_id: round,
          agent_role: "tester",
          attempt,
        },
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

      const commands = tester.test_spec.commands || [];
      throwIfAborted();
      const testRun = await runTestCommands(commands, {
        timeoutMs: testCommandTimeoutMs,
        cwd: process.cwd(),
        env: process.env,
        allowedPrefixes: allowedTestCommands,
        stopOnFailure: true,
        abortSignal,
      });

      writeJson(path.join(roundPath, "test-results.json"), testRun);
      writeText(
        path.join(roundPath, "test-results.txt"),
        testRun.results
          .map((r, idx) => {
            return [
              `# Command ${idx + 1}`,
              `cmd: ${r.command}`,
              `ok: ${r.ok}`,
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
        };
      }

      if (!tester.ok) {
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
        const blockedResults = testRun.results.filter(
          (r) => !r.ok && r.stderr?.includes("blocked command")
        );

        if (
          blockedResults.length > 0 &&
          testRun.results.every((r) => r.ok || r.stderr?.includes("blocked command"))
        ) {
          // All failures are blocked commands → Tester's fault, no point iterating
          mustFix = [
            `Tester generated blocked command(s): ${blockedResults.map((r) => r.command).join("; ")}`,
            `Only allowed: ${allowedTestCommands.join(", ")}`,
          ];
          finalOutcome = "tester_command_blocked";
          transition(FSM_STATES.FINALIZE, { round, reason: "tester_command_blocked" });
          break;
        }

        // Real test failure
        const failed = testRun.results.find((r) => !r.ok);
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
      transition(FSM_STATES.FINALIZE, { round, reason: "tests_passed" });
      break;
    }

    mustFix = reviewer.review.must_fix;
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
      throw err;
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
    max_iterations: maxIterations,
    fsm_states: Object.values(FSM_STATES),
    state_events: stateEvents,
    rounds,
    unresolved_must_fix: mustFix,
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

module.exports = { FSM_STATES, runTask, runOnce };
