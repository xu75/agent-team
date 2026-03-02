"use strict";

const { runCommandStreaming } = require("../engine/runner");
const { buildClaudeCommand } = require("./claude-cli");
const { buildCodexCommand } = require("./codex-cli");
const { buildGeminiCommand } = require("./gemini-cli");

function envFlag(name, defaultValue = false) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return !!defaultValue;
  return /^(1|true|yes|on)$/i.test(raw);
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

function formatArgs(args) {
  if (!Array.isArray(args) || args.length === 0) return "";
  return args
    .map((a) => {
      const s = String(a);
      return /\s/.test(s) ? JSON.stringify(s) : s;
    })
    .join(" ");
}

function resolveCodexSandboxMode(eventMeta = {}) {
  const role = String(
    eventMeta?.agent_role || eventMeta?.workflow_node || eventMeta?.role || ""
  ).trim().toLowerCase();
  if (role === "coder") return "workspace-write";
  if (role === "reviewer") return "read-only";
  return null;
}

function resolveProvider(provider, prompt, model, settingsFile, eventMeta = {}) {
  if (provider === "claude-cli") {
    const built = buildClaudeCommand({ prompt, model, settingsFile });
    return { ...built, stdoutParseMode: "ndjson" };
  }

  if (provider === "codex-cli") {
    const sandboxMode = resolveCodexSandboxMode(eventMeta);
    const built = buildCodexCommand({ prompt, model, sandboxMode });
    return { ...built, stdoutParseMode: "text" };
  }

  if (provider === "gemini-cli") {
    const built = buildGeminiCommand({ prompt, model });
    return { ...built, stdoutParseMode: "text" };
  }

  const err = new Error(`Unsupported provider: ${provider}`);
  err.code = "PROVIDER_UNSUPPORTED";
  throw err;
}

function classifyProviderError({ provider, exit, stderrLines = [], text = "", permissionDeniedCount = 0 }) {
  const code = Number(exit?.code);
  const hasFailure = !!exit?.error || (Number.isFinite(code) && code !== 0);
  if (!hasFailure) return null;

  if (permissionDeniedCount >= 3) return "provider_permission_denied";

  const errMsg = String(exit?.error?.message || "");
  const haystack = [errMsg, String(text || ""), ...stderrLines].join("\n").toLowerCase();

  if (provider === "codex-cli" && /enoent/.test(errMsg.toLowerCase())) {
    return "provider_not_found";
  }
  if (/(quota|usage limit|rate limit|too many requests|status 429|insufficient credits|credit balance|billing|monthly limit)/i.test(haystack)) {
    return "provider_quota_exceeded";
  }
  if (/(unauthorized|forbidden|invalid api key|auth|token expired|status 401|status 403)/i.test(haystack)) {
    return "provider_auth_error";
  }
  if (/(timed out|timeout|etimedout)/i.test(haystack)) {
    return "provider_timeout";
  }
  if (/(stream disconnected before completion|error sending request|econn|enotfound|socket hang up|network)/i.test(haystack)) {
    return "provider_network_error";
  }
  return "provider_runtime_error";
}

function detectSoftQuotaBlock({ provider, text = "", stderrLines = [] }) {
  if (provider !== "claude-cli") return false;
  const merged = [String(text || ""), ...stderrLines].join("\n");
  const head = merged.slice(0, 500).toLowerCase();
  if (!head.trim()) return false;
  if (/you'?ve hit your limit/i.test(head)) return true;
  if (/(usage limit|monthly limit|credit balance|insufficient credits|status 429|too many requests)/i.test(head)) {
    return true;
  }
  if (/resets?\s+\d{1,2}(:\d{2})?\s*(am|pm)/i.test(head) && /limit/i.test(head)) {
    return true;
  }
  return false;
}

function shouldAutoFallback({
  provider,
  errorClass,
  fallbackDepth = 0,
  fallbackProvider,
}) {
  if (fallbackDepth > 0) return false;
  if (provider !== "claude-cli") return false;
  if (!fallbackProvider || fallbackProvider === provider) return false;
  if (!envFlag("CATCAFE_AUTO_FALLBACK_TO_CODEX", true)) return false;
  return errorClass === "provider_quota_exceeded";
}

async function executeProviderText({
  provider = "claude-cli",
  prompt,
  model,
  settingsFile,
  timeoutMs,
  streamOutput = false,
  eventMeta = {},
  abortSignal = null,
  onLiveEvent = null,
  fallbackDepth = 0,
}) {
  let resolvedProvider;
  try {
    resolvedProvider = resolveProvider(
      provider,
      prompt,
      model,
      settingsFile,
      eventMeta
    );
  } catch (err) {
    const isUnsupportedProvider =
      err?.code === "PROVIDER_UNSUPPORTED" || /unsupported provider/i.test(String(err?.message || ""));
    if (!isUnsupportedProvider) throw err;
    const message = String(err?.message || `Unsupported provider: ${provider}`);
    if (streamOutput) {
      process.stdout.write(
        `\n[provider] done\n` +
        `  time: ${formatLocalDateTime()}\n` +
        `  provider: ${provider}\n` +
        `  run_id: -\n` +
        `  exit_code: null\n` +
        `  signal: -\n` +
        `  duration_ms: 0\n` +
        `  error: provider_unsupported\n`
      );
    }
    return {
      text: `Runtime Error: ${message}\n`,
      runId: null,
      runDir: null,
      exit: {
        code: null,
        signal: null,
        error: { message },
      },
      error_class: "provider_unsupported",
      usage: null,
    };
  }
  const { cmd, args, stdoutParseMode } = resolvedProvider;
  const startedAt = Date.now();
  let text = "";
  const stderrLines = [];
  let permissionDeniedCount = 0;
  let usageData = null;
  const permissionDeniedPattern = /requested permissions to write .*haven't granted it yet/i;

  if (streamOutput) {
    const cmdLine = `${cmd}${args?.length ? ` ${formatArgs(args)}` : ""}`;
    process.stdout.write(
      `\n[provider] start\n` +
      `  time: ${formatLocalDateTime()}\n` +
      `  provider: ${provider}\n` +
      `  model: ${model || "-"}\n` +
      `  parse: ${stdoutParseMode}\n` +
      `  cmd: ${cmdLine}\n`
    );
  }

  function maybePermissionDenied(evt) {
    if (provider !== "claude-cli" || !evt) return false;
    if (evt.type === "run.stderr.line") {
      return permissionDeniedPattern.test(String(evt.data?.line || ""));
    }
    if (evt.type === "run.stdout.line") {
      return permissionDeniedPattern.test(String(evt.data?.line || ""));
    }
    if (evt.type === "provider.ndjson") {
      return permissionDeniedPattern.test(JSON.stringify(evt.data?.obj || {}));
    }
    return false;
  }

  const result = await runCommandStreaming({
    providerName: provider,
    cmd,
    args,
    stdoutParseMode,
    timeoutMs,
    eventMeta,
    abortSignal,
    shouldTerminate: (evt) => {
      if (!maybePermissionDenied(evt)) return false;
      permissionDeniedCount += 1;
      if (permissionDeniedCount >= 3) {
        return "permission denied loop: file write not granted";
      }
      return false;
    },
    onEvent: (evt) => {
      if (typeof onLiveEvent === "function") {
        try {
          onLiveEvent(evt);
        } catch {}
      }
      if (evt.type === "assistant.text") {
        text += evt.data.text;
        if (streamOutput) process.stdout.write(evt.data.text);
        return;
      }
      if (evt.type === "run.stderr.chunk") {
        const chunk = String(evt.data?.text || "");
        if (!chunk) return;
        if (streamOutput) process.stderr.write(chunk);
        const lines = chunk
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        if (lines.length) stderrLines.push(...lines);
        return;
      }
      if (evt.type === "run.usage") {
        usageData = evt.data || null;
        return;
      }
      if (evt.type === "run.stderr.line") {
        const line = String(evt.data?.line || "").trim();
        if (stdoutParseMode === "text") return;
        if (line) stderrLines.push(line);
      }
    },
  });

  if (!text.trim() && result.exit?.error) {
    const errMsg = String(result.exit.error.message || "unknown provider error");
    if (provider === "codex-cli" && /ENOENT/i.test(errMsg)) {
      text =
        "Runtime Error: codex command not found (ENOENT).\n" +
        "Please install Codex CLI or set CODEX_BIN to the executable path.\n" +
        "Example: export CODEX_BIN=/Applications/Codex.app/Contents/Resources/codex\n";
    } else {
      text = `Runtime Error: ${errMsg}\n`;
    }
  } else if (!text.trim() && provider === "claude-cli" && permissionDeniedCount >= 3) {
    text =
      "Runtime Error: Claude repeatedly requested file-write permission but was denied.\n" +
      "This run was stopped early to avoid hanging.\n" +
      "Please either grant write permission in Claude CLI, or switch coder to a provider/mode that does not require tool writes.\n";
  } else if (!text.trim() && Number(result.exit?.code) !== 0 && stderrLines.length) {
    const tail = stderrLines.slice(-6).join("\n");
    text = `Runtime Error: provider exited with code ${result.exit.code}\n${tail}\n`;
  }

  if (result.aborted || abortSignal?.aborted) {
    const err = new Error("run aborted by operator");
    err.code = "ABORTED";
    throw err;
  }

  const errorClass = classifyProviderError({
    provider,
    exit: result.exit,
    stderrLines,
    text,
    permissionDeniedCount,
  });
  const resolvedErrorClass = errorClass || (
    detectSoftQuotaBlock({ provider, text, stderrLines }) ? "provider_quota_exceeded" : null
  );

  const fallbackProvider = String(process.env.CATCAFE_FALLBACK_PROVIDER || "codex-cli").trim() || "codex-cli";
  if (
    shouldAutoFallback({
      provider,
      errorClass: resolvedErrorClass,
      fallbackDepth,
      fallbackProvider,
    })
  ) {
    if (streamOutput) {
      const durationMs = Date.now() - startedAt;
      const exitCode = Number.isFinite(Number(result?.exit?.code))
        ? Number(result.exit.code)
        : "null";
      const exitSignal = result?.exit?.signal || "-";
      process.stdout.write(
        `\n[provider] done\n` +
        `  time: ${formatLocalDateTime()}\n` +
        `  provider: ${provider}\n` +
        `  run_id: ${result.runId}\n` +
        `  exit_code: ${exitCode}\n` +
        `  signal: ${exitSignal}\n` +
        `  duration_ms: ${durationMs}\n` +
        `  error: ${resolvedErrorClass || "-"}\n` +
        `  note: fallback_triggered\n`
      );
    }
    const fallbackModel = String(process.env.CATCAFE_FALLBACK_MODEL || "").trim() || null;
    if (streamOutput) {
      process.stdout.write(
        `\n[provider] fallback\n` +
        `  time: ${formatLocalDateTime()}\n` +
        `  from: ${provider}\n` +
        `  to: ${fallbackProvider}\n` +
        `  reason: ${resolvedErrorClass}\n`
      );
    }
    const fallbackResult = await executeProviderText({
      provider: fallbackProvider,
      prompt,
      model: fallbackModel,
      settingsFile: null,
      timeoutMs,
      streamOutput,
      eventMeta: {
        ...eventMeta,
        fallback_from: provider,
        fallback_reason: resolvedErrorClass,
      },
      abortSignal,
      onLiveEvent,
      fallbackDepth: fallbackDepth + 1,
    });
    const fallbackExitCode = Number(fallbackResult?.exit?.code);
    const fallbackOk = !fallbackResult?.error_class && (!Number.isFinite(fallbackExitCode) || fallbackExitCode === 0);
    if (fallbackOk) {
      return {
        ...fallbackResult,
        fallback_from: provider,
        fallback_reason: resolvedErrorClass,
        primary_error_class: resolvedErrorClass,
      };
    }
    if (streamOutput) {
      process.stdout.write(
        `\n[provider] fallback_failed\n` +
        `  time: ${formatLocalDateTime()}\n` +
        `  from: ${provider}\n` +
        `  to: ${fallbackProvider}\n` +
        `  reason: ${resolvedErrorClass}\n` +
        `  fallback_error: ${fallbackResult?.error_class || "unknown"}\n`
      );
    }
  }

  if (streamOutput) {
    const durationMs = Date.now() - startedAt;
    const exitCode = Number.isFinite(Number(result?.exit?.code))
      ? Number(result.exit.code)
      : "null";
    const exitSignal = result?.exit?.signal || "-";
    process.stdout.write(
      `\n[provider] done\n` +
      `  time: ${formatLocalDateTime()}\n` +
      `  provider: ${provider}\n` +
      `  run_id: ${result.runId}\n` +
      `  exit_code: ${exitCode}\n` +
      `  signal: ${exitSignal}\n` +
      `  duration_ms: ${durationMs}\n` +
      `  error: ${resolvedErrorClass || "-"}\n`
    );
  }

  return {
    text,
    runId: result.runId,
    runDir: result.dir,
    exit: result.exit,
    error_class: resolvedErrorClass,
    usage: usageData,
  };
}

module.exports = {
  executeProviderText,
};
