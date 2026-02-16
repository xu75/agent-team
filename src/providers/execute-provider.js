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
}) {
  const { cmd, args, stdoutParseMode } = resolveProvider(provider, prompt, model);
  let text = "";
  const stderrLines = [];

  const result = await runCommandStreaming({
    providerName: provider,
    cmd,
    args,
    stdoutParseMode,
    timeoutMs,
    eventMeta,
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
  } else if (!text.trim() && Number(result.exit?.code) !== 0 && stderrLines.length) {
    const tail = stderrLines.slice(-6).join("\n");
    text = `Runtime Error: provider exited with code ${result.exit.code}\n${tail}\n`;
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
