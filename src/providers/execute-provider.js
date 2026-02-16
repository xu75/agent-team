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

  const result = await runCommandStreaming({
    providerName: provider,
    cmd,
    args,
    stdoutParseMode,
    timeoutMs,
    eventMeta,
    onEvent: (evt) => {
      if (evt.type !== "assistant.text") return;
      text += evt.data.text;
      if (streamOutput) process.stdout.write(evt.data.text);
    },
  });

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
