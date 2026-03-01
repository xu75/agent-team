"use strict";

const { spawn } = require("node:child_process");

const DEFAULT_ALLOWED_PREFIXES = [
  "npm test",
  "npm run test",
  "node --test",
  "pnpm test",
  "yarn test",
];

function isAllowedCommand(command, allowedPrefixes = DEFAULT_ALLOWED_PREFIXES) {
  const c = String(command || "").trim();
  if (!c) return false;
  return allowedPrefixes.some((prefix) => c === prefix || c.startsWith(prefix + " "));
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

function logTestDebug(title, details = [], streamOutput = true) {
  if (!streamOutput) return;
  const lines = [
    `[test] ${title}`,
    `  time: ${formatLocalDateTime()}`,
    ...details.map((x) => `  ${x}`),
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

function runSingleCommand(command, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5 * 60 * 1000;
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const abortSignal = options.abortSignal || null;
  const streamOutput = options.streamOutput !== false;

  return new Promise((resolve) => {
    const startedAt = Date.now();
    logTestDebug(
      "start",
      [
        `cmd: ${JSON.stringify(command)}`,
        `cwd: ${cwd}`,
        `timeout_ms: ${timeoutMs}`,
      ],
      streamOutput
    );

    const child = spawn("sh", ["-lc", command], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let finished = false;
    let aborted = false;

    const timer = setTimeout(() => {
      if (finished) return;
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          if (!child.killed) child.kill("SIGKILL");
        } catch {}
      }, 3000);
    }, timeoutMs);

    const onAbort = () => {
      if (finished) return;
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      setTimeout(() => {
        try {
          if (!child.killed) child.kill("SIGKILL");
        } catch {}
      }, 1000);
    };
    if (abortSignal && typeof abortSignal.addEventListener === "function") {
      abortSignal.addEventListener("abort", onAbort, { once: true });
    }

    child.stdout.on("data", (buf) => {
      stdout += buf.toString("utf8");
      if (streamOutput) process.stdout.write(buf);
    });
    child.stderr.on("data", (buf) => {
      stderr += buf.toString("utf8");
      if (streamOutput) process.stderr.write(buf);
    });

    child.on("close", (code, signal) => {
      finished = true;
      clearTimeout(timer);
      if (abortSignal && typeof abortSignal.removeEventListener === "function") {
        abortSignal.removeEventListener("abort", onAbort);
      }
      resolve({
        command,
        code: code ?? 1,
        signal: signal || (aborted ? "SIGTERM" : null),
        ok: code === 0 && !signal && !aborted,
        stdout,
        stderr,
      });
      const durationMs = Date.now() - startedAt;
      logTestDebug(
        "done",
        [
          `cmd: ${JSON.stringify(command)}`,
          `ok: ${code === 0 && !signal && !aborted}`,
          `code: ${code ?? 1}`,
          `signal: ${signal || (aborted ? "SIGTERM" : "-")}`,
          `duration_ms: ${durationMs}`,
        ],
        streamOutput
      );
    });

    child.on("error", (err) => {
      finished = true;
      clearTimeout(timer);
      if (abortSignal && typeof abortSignal.removeEventListener === "function") {
        abortSignal.removeEventListener("abort", onAbort);
      }
      resolve({
        command,
        code: 1,
        signal: null,
        ok: false,
        stdout,
        stderr: stderr + `\nspawn error: ${err.message}\n`,
      });
      const durationMs = Date.now() - startedAt;
      logTestDebug(
        "done",
        [
          `cmd: ${JSON.stringify(command)}`,
          "ok: false",
          "code: 1",
          "signal: -",
          `duration_ms: ${durationMs}`,
          `error: ${JSON.stringify(err.message)}`,
        ],
        streamOutput
      );
    });
  });
}

async function runTestCommands(commands, options = {}) {
  const allowedPrefixes = options.allowedPrefixes || DEFAULT_ALLOWED_PREFIXES;
  const stopOnFailure = options.stopOnFailure !== false;
  const streamOutput = options.streamOutput !== false;
  const results = [];

  for (const command of commands) {
    if (options.abortSignal?.aborted) {
      logTestDebug("abort", [`cmd: ${JSON.stringify(command)}`], streamOutput);
      results.push({
        command,
        code: 1,
        signal: "SIGTERM",
        ok: false,
        stdout: "",
        stderr: "aborted by operator",
      });
      break;
    }
    if (!isAllowedCommand(command, allowedPrefixes)) {
      logTestDebug(
        "blocked",
        [
          `cmd: ${JSON.stringify(command)}`,
          "reason: allowlist",
          `allowed: ${JSON.stringify(allowedPrefixes)}`,
        ],
        streamOutput
      );
      results.push({
        command,
        code: 1,
        signal: null,
        ok: false,
        stdout: "",
        stderr: `blocked command: not in allowlist (${allowedPrefixes.join(", ")})`,
      });
      if (stopOnFailure) break;
      continue;
    }

    const r = await runSingleCommand(command, { ...options, streamOutput });
    results.push(r);
    if (stopOnFailure && !r.ok) break;
  }

  const allPassed = results.every((r) => r.ok);
  logTestDebug(
    "summary",
    [
      `total: ${results.length}`,
      `all_passed: ${allPassed}`,
    ],
    streamOutput
  );
  return { allPassed, results };
}

module.exports = {
  DEFAULT_ALLOWED_PREFIXES,
  runTestCommands,
};
