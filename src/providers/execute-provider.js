"use strict";

const { runCommandStreaming } = require("../engine/runner");
const { buildClaudeCommand } = require("./claude-cli");
const { buildCodexCommand } = require("./codex-cli");
const { buildGeminiCommand } = require("./gemini-cli");

function nowIso() {
  return new Date().toISOString();
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

function resolveProvider(provider, prompt, model, settingsFile) {
  if (provider === "claude-cli") {
    const built = buildClaudeCommand({ prompt, model, settingsFile });
    return { ...built, stdoutParseMode: "ndjson" };
  }

  if (provider === "codex-cli") {
    const built = buildCodexCommand({ prompt, model });
    return { ...built, stdoutParseMode: "text" };
  }

  if (provider === "gemini-cli") {
    const built = buildGeminiCommand({ prompt, model });
    return { ...built, stdoutParseMode: "text" };
  }

  throw new Error(`Unsupported provider: ${provider}`);
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

async function executeProviderText({
  provider = "claude-cli",
  prompt,
  model,
  settingsFile,
  timeoutMs,
  streamOutput = false,
  eventMeta = {},
  abortSignal = null,
}) {
  const { cmd, args, stdoutParseMode } = resolveProvider(provider, prompt, model, settingsFile);
  const startedAt = Date.now();
  let text = "";
  const stderrLines = [];
  let permissionDeniedCount = 0;
  let usageData = null;
  const permissionDeniedPattern = /requested permissions to write .*haven't granted it yet/i;

  if (streamOutput) {
    process.stdout.write(
      `\n[provider][${nowIso()}] start provider=${provider} model=${model || "-"} parse=${stdoutParseMode} cmd=${cmd} ${formatArgs(args)}\n`
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

  if (streamOutput) {
    const durationMs = Date.now() - startedAt;
    const exitCode = Number.isFinite(Number(result?.exit?.code))
      ? Number(result.exit.code)
      : "null";
    const exitSignal = result?.exit?.signal || "-";
    process.stdout.write(
      `\n[provider][${nowIso()}] done provider=${provider} run_id=${result.runId} exit_code=${exitCode} signal=${exitSignal} duration_ms=${durationMs}${errorClass ? ` error=${errorClass}` : ""}\n`
    );
  }

  return {
    text,
    runId: result.runId,
    runDir: result.dir,
    exit: result.exit,
    error_class: errorClass,
    usage: usageData,
  };
}

module.exports = {
  executeProviderText,
};
