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

function runSingleCommand(command, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 5 * 60 * 1000;
  const cwd = options.cwd || process.cwd();
  const env = options.env || process.env;
  const abortSignal = options.abortSignal || null;

  return new Promise((resolve) => {
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
    });
    child.stderr.on("data", (buf) => {
      stderr += buf.toString("utf8");
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
    });
  });
}

async function runTestCommands(commands, options = {}) {
  const allowedPrefixes = options.allowedPrefixes || DEFAULT_ALLOWED_PREFIXES;
  const stopOnFailure = options.stopOnFailure !== false;
  const results = [];

  for (const command of commands) {
    if (options.abortSignal?.aborted) {
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

    const r = await runSingleCommand(command, options);
    results.push(r);
    if (stopOnFailure && !r.ok) break;
  }

  const allPassed = results.every((r) => r.ok);
  return { allPassed, results };
}

module.exports = {
  DEFAULT_ALLOWED_PREFIXES,
  runTestCommands,
};
