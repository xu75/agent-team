"use strict";

const { spawn } = require("node:child_process");

const DEFAULT_ALLOWED_PREFIXES = [
  "npm test",
  "npm run test",
  "node --test",
  "pnpm test",
  "yarn test",
];

const SAFE_ALLOWLIST_BINARIES = new Set(["npm", "node", "pnpm", "yarn"]);
const DISALLOWED_SHELL_SYNTAX_RE = /(;|&&|\|\||\||\$\(|`|\n|\r|\t)/;
const MALICIOUS_COMMAND_RE_LIST = [
  /\brm\s+-rf\b/i,
  /\bcurl\b[\s\S]*\|\s*(bash|sh)\b/i,
  /\bwget\b[\s\S]*\|\s*(bash|sh)\b/i,
];

function tokenizeShellCommand(command) {
  const input = String(command || "");
  const tokens = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];

    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (ch === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (escaping) current += "\\";
  if (quote) return { tokens: [], error: "unterminated_quote" };
  if (current) tokens.push(current);
  return { tokens, error: null };
}

function containsDisallowedShellSyntax(command) {
  return DISALLOWED_SHELL_SYNTAX_RE.test(String(command || ""));
}

function looksMaliciousCommand(command, tokens = []) {
  const raw = String(command || "");
  if (containsDisallowedShellSyntax(raw)) return true;
  if (MALICIOUS_COMMAND_RE_LIST.some((re) => re.test(raw))) return true;
  if (tokens[0] === "node" && (tokens[1] === "-e" || tokens[1] === "--eval")) return true;
  return false;
}

function normalizeAllowedPrefixes(allowedPrefixes, fallback = DEFAULT_ALLOWED_PREFIXES) {
  const input = Array.isArray(allowedPrefixes) ? allowedPrefixes : [];
  const output = [];
  const rejected = [];
  const seen = new Set();

  for (const rawPrefix of input) {
    const prefix = String(rawPrefix || "").trim();
    if (!prefix) continue;

    if (containsDisallowedShellSyntax(prefix)) {
      rejected.push({ prefix, reason: "disallowed_shell_syntax" });
      continue;
    }

    const parsed = tokenizeShellCommand(prefix);
    if (parsed.error || !parsed.tokens.length) {
      rejected.push({ prefix, reason: parsed.error || "empty_prefix" });
      continue;
    }

    if (!SAFE_ALLOWLIST_BINARIES.has(parsed.tokens[0])) {
      rejected.push({ prefix, reason: "unsupported_binary" });
      continue;
    }

    const normalizedPrefix = parsed.tokens.join(" ");
    if (seen.has(normalizedPrefix)) continue;
    seen.add(normalizedPrefix);
    output.push(normalizedPrefix);
  }

  if (output.length > 0) {
    return { prefixes: output, rejected, used_fallback: false };
  }

  // Default rules are hardcoded and safe.
  return { prefixes: [...fallback], rejected, used_fallback: true };
}

function buildAllowedRules(allowedPrefixes = DEFAULT_ALLOWED_PREFIXES) {
  return allowedPrefixes
    .map((prefix) => {
      const parsed = tokenizeShellCommand(prefix);
      if (parsed.error || !parsed.tokens.length) return null;
      return { prefix, tokens: parsed.tokens };
    })
    .filter(Boolean);
}

function tokensMatchPrefix(commandTokens, prefixTokens) {
  if (!Array.isArray(commandTokens) || !Array.isArray(prefixTokens)) return false;
  if (commandTokens.length < prefixTokens.length) return false;
  for (let i = 0; i < prefixTokens.length; i += 1) {
    if (commandTokens[i] !== prefixTokens[i]) return false;
  }
  return true;
}

function classifyCommandAgainstAllowlist(command, allowedRules = buildAllowedRules(DEFAULT_ALLOWED_PREFIXES)) {
  const raw = String(command || "").trim();
  if (!raw) {
    return {
      allowed: false,
      blocked_reason: "empty_command",
      blocked_severity: "normal",
      retryable: false,
      command_argv0: null,
      matched_prefix: null,
    };
  }

  if (containsDisallowedShellSyntax(raw)) {
    return {
      allowed: false,
      blocked_reason: "command_injection_characters",
      blocked_severity: "malicious",
      retryable: false,
      command_argv0: null,
      matched_prefix: null,
    };
  }

  const parsed = tokenizeShellCommand(raw);
  if (parsed.error || !parsed.tokens.length) {
    return {
      allowed: false,
      blocked_reason: "parse_error",
      blocked_severity: "normal",
      retryable: false,
      command_argv0: null,
      matched_prefix: null,
    };
  }

  const tokens = parsed.tokens;
  const argv0 = tokens[0];
  if (looksMaliciousCommand(raw, tokens)) {
    return {
      allowed: false,
      blocked_reason: "malicious_command",
      blocked_severity: "malicious",
      retryable: false,
      command_argv0: argv0,
      matched_prefix: null,
    };
  }

  const matchedRule = allowedRules.find((rule) => tokensMatchPrefix(tokens, rule.tokens));
  if (matchedRule) {
    return {
      allowed: true,
      blocked_reason: null,
      blocked_severity: null,
      retryable: false,
      command_argv0: argv0,
      matched_prefix: matchedRule.prefix,
    };
  }

  return {
    allowed: false,
    blocked_reason: "allowlist_mismatch",
    blocked_severity: "normal",
    retryable: true,
    command_argv0: argv0,
    matched_prefix: null,
  };
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
  const normalizedAllowlist = normalizeAllowedPrefixes(options.allowedPrefixes, DEFAULT_ALLOWED_PREFIXES);
  const allowedPrefixes = normalizedAllowlist.prefixes;
  const allowedRules = buildAllowedRules(allowedPrefixes);
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
    const policy = classifyCommandAgainstAllowlist(command, allowedRules);
    if (!policy.allowed) {
      logTestDebug(
        "blocked",
        [
          `cmd: ${JSON.stringify(command)}`,
          `reason: ${policy.blocked_reason}`,
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
        stderr: `blocked command: ${policy.blocked_reason} (allowed: ${allowedPrefixes.join(", ")})`,
        runnable: false,
        blocked: true,
        blocked_reason: policy.blocked_reason,
        blocked_severity: policy.blocked_severity,
        retryable_blocked: policy.retryable,
        command_argv0: policy.command_argv0,
      });
      // Blocked commands are skipped; they should not stop runnable test execution.
      continue;
    }

    const r = await runSingleCommand(command, { ...options, streamOutput });
    results.push({
      ...r,
      runnable: true,
      blocked: false,
      blocked_reason: null,
      blocked_severity: null,
      retryable_blocked: false,
      command_argv0: policy.command_argv0,
      matched_prefix: policy.matched_prefix,
    });
    if (stopOnFailure && !r.ok) break;
  }

  const runnableResults = results.filter((r) => r.runnable === true);
  const blockedResults = results.filter((r) => r.blocked === true);
  const runnableFailures = runnableResults.filter((r) => !r.ok);
  const firstBlocked = blockedResults[0] || null;
  const allPassed =
    runnableResults.length === 0
      ? results.length === 0
      : runnableFailures.length === 0;
  logTestDebug(
    "summary",
    [
      `total: ${results.length}`,
      `runnable_commands: ${runnableResults.length}`,
      `blocked_commands: ${blockedResults.length}`,
      `all_passed: ${allPassed}`,
    ],
    streamOutput
  );
  return {
    allPassed,
    results,
    blocked_commands: blockedResults.length,
    runnable_commands: runnableResults.length,
    retryable_blocked_commands: blockedResults.filter((r) => r.retryable_blocked === true).length,
    first_blocked_command: firstBlocked ? firstBlocked.command : null,
    blocked_reason: firstBlocked ? firstBlocked.blocked_reason : null,
  };
}

module.exports = {
  DEFAULT_ALLOWED_PREFIXES,
  normalizeAllowedPrefixes,
  tokenizeShellCommand,
  containsDisallowedShellSyntax,
  classifyCommandAgainstAllowlist,
  runTestCommands,
};
