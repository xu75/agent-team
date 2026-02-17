

// src/engine/runner.js
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");

const { makeEvent } = require("./run-event");
const { createRunLogDir, createLineWriter } = require("./logger");

/**
 * runCommandStreaming
 *
 * Core Engine v0.1
 * - Spawns provider process
 * - Treats stdout + stderr as activity
 * - Idle timeout (no activity)
 * - Graceful SIGTERM -> SIGKILL fallback
 * - Persists raw NDJSON + normalized events
 */
async function runCommandStreaming({
  providerName,
  cmd,
  args,
  env = process.env,
  stdoutParseMode = "ndjson",
  eventMeta = {},
  timeoutMs = 10 * 60 * 1000,
  killGraceMs = 5000,
  logsRoot = "logs",
  onEvent = () => {},
  shouldTerminate = null,
  abortSignal = null,
}) {
  const { runId, dir } = createRunLogDir(logsRoot);

  const eventsWriter = createLineWriter(path.join(dir, "events.jsonl"));
  const rawWriter = createLineWriter(path.join(dir, "raw.ndjson"));

  const baseMeta = { run_id: runId, provider: providerName, ...eventMeta };

  let lastActivity = Date.now();
  let finished = false;
  let child = null;
  let abortedBySignal = false;

  function emit(type, data = {}, meta = {}) {
    const evt = makeEvent(type, data, { ...baseMeta, ...meta });
    onEvent(evt);
    eventsWriter.writeLine(JSON.stringify(evt));
    if (typeof shouldTerminate === "function" && !finished) {
      try {
        const decision = shouldTerminate(evt);
        if (decision) {
          const reason =
            typeof decision === "string"
              ? decision
              : "provider requested early termination";
          gracefulKill(reason);
        }
      } catch {}
    }
  }

  function markActivity() {
    lastActivity = Date.now();
  }

  function gracefulKill(reason) {
    if (finished) return;
    finished = true;

    emit("run.terminating", { reason });
    if (reason === "aborted by operator") {
      abortedBySignal = true;
    }

    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }

    setTimeout(() => {
      try {
        if (child && !child.killed) child.kill("SIGKILL");
      } catch {}
    }, killGraceMs);
  }

  emit("run.started", { cmd, args, log_dir: dir });

  if (abortSignal?.aborted) {
    gracefulKill("aborted by operator");
  }

  child = spawn(cmd, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });

  emit("run.spawned", { pid: child.pid });

  // Parent signal handling
  const onSigint = () => gracefulKill("parent SIGINT");
  const onSigterm = () => gracefulKill("parent SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  const onAbort = () => gracefulKill("aborted by operator");
  if (abortSignal && typeof abortSignal.addEventListener === "function") {
    abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  const rlOut = readline.createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });

  const rlErr = readline.createInterface({
    input: child.stderr,
    crlfDelay: Infinity,
  });

  rlOut.on("line", (line) => {
    markActivity();

    rawWriter.writeLine(line);
    emit("run.stdout.line", { line });

    if (stdoutParseMode === "text") {
      emit("assistant.text", { text: line + "\n" });
      return;
    }

    try {
      const obj = JSON.parse(line);
      emit("provider.ndjson", { obj });

      // Extract a normalized usage/cost summary when the provider emits a final result.
      // Claude stream-json commonly emits: { type: "result", subtype: "success", ... }
      if (obj?.type === "result") {
        emit("run.usage", {
          subtype: obj?.subtype ?? null,
          is_error: obj?.is_error ?? null,
          model: obj?.model ?? null,
          duration_ms: obj?.duration_ms ?? null,
          duration_api_ms: obj?.duration_api_ms ?? null,
          total_cost_usd: obj?.total_cost_usd ?? null,
          usage: obj?.usage ?? null,
          modelUsage: obj?.modelUsage ?? null,
        });
      }

      if (obj?.type === "assistant") {
        const content = obj?.message?.content;
        if (Array.isArray(content)) {
          const texts = content
            .filter((p) => p?.type === "text")
            .map((p) => p.text)
            .filter(Boolean);

          if (texts.length) {
            emit("assistant.text", { text: texts.join("") });
          }
        }
      }
    } catch {
      emit("provider.ndjson.parse_error", { line });
    }
  });

  rlErr.on("line", (line) => {
    // IMPORTANT: stderr counts as activity
    markActivity();
    emit("run.stderr.line", { line });
  });

  const timer = setInterval(() => {
    const idle = Date.now() - lastActivity;
    if (idle > timeoutMs) {
      clearInterval(timer);
      gracefulKill(`idle timeout after ${Math.round(idle / 1000)}s`);
    }
  }, 1000);

  const exit = await new Promise((resolve) => {
    child.on("error", (err) =>
      resolve({ code: 1, signal: null, error: err })
    );
    child.on("close", (code, signal) =>
      resolve({ code, signal, error: null })
    );
  });

  clearInterval(timer);
  rlOut.close();
  rlErr.close();

  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  if (abortSignal && typeof abortSignal.removeEventListener === "function") {
    abortSignal.removeEventListener("abort", onAbort);
  }

  finished = true;

  if (exit.error) {
    emit("run.failed", { message: exit.error.message });
  } else if (exit.signal) {
    emit("run.completed", { code: null, signal: exit.signal });
  } else {
    emit("run.completed", { code: exit.code, signal: null });
  }

  await rawWriter.close();
  await eventsWriter.close();

  return { runId, dir, exit, aborted: abortedBySignal };
}

module.exports = { runCommandStreaming };
