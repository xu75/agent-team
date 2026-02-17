"use strict";

const { runCommandStreaming } = require("../engine/runner");
const { buildClaudeCommand } = require("./claude-cli");
const { buildCodexCommand } = require("./codex-cli");

function resolveProvider(provider, prompt, model) {
  if (provider === "claude-cli") {
    const built = buildClaudeCommand({ prompt });
    return { ...built, stdoutParseMode: "ndjson" };
  }

  if (provider === "codex-cli") {
    const built = buildCodexCommand({ prompt, model });
    return { ...built, stdoutParseMode: "text" };
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

async function executeProviderText({
  provider = "claude-cli",
  prompt,
  model,
  timeoutMs,
  streamOutput = false,
  eventMeta = {},
  abortSignal = null,
}) {
  const { cmd, args, stdoutParseMode } = resolveProvider(provider, prompt, model);
  let text = "";
  const stderrLines = [];
  let permissionDeniedCount = 0;
  const permissionDeniedPattern = /requested permissions to write .*haven't granted it yet/i;

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
      if (evt.type === "run.stderr.line") {
        const line = String(evt.data?.line || "").trim();
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

  return {
    text,
    runId: result.runId,
    runDir: result.dir,
    exit: result.exit,
  };
}

module.exports = {
  executeProviderText,
};
