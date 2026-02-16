// scripts/run-codex.js

/**
 * Simple CLI entry to test Engine v0.1 with Codex CLI provider.
 *
 * Usage:
 *   node scripts/run-codex.js "your prompt"
 *   CODEX_MODEL=o4-mini node scripts/run-codex.js "your prompt"
 */

const { buildCodexCommand } = require("../src/providers/codex-cli");
const { runCommandStreaming } = require("../src/engine/runner");

const prompt = process.argv.slice(2).join(" ").trim();

if (!prompt) {
  console.error('Usage: node scripts/run-codex.js "your prompt"');
  process.exit(2);
}

(async () => {
  try {
    const { cmd, args } = buildCodexCommand({
      prompt,
      model: process.env.CODEX_MODEL,
    });

    const result = await runCommandStreaming({
      providerName: "codex-cli",
      cmd,
      args,
      stdoutParseMode: "text",
      timeoutMs: Number(process.env.CODEX_TIMEOUT_MS || 10 * 60 * 1000),
      onEvent: (evt) => {
        if (evt.type === "assistant.text") {
          process.stdout.write(evt.data.text);
        }

        if (evt.type === "run.failed") {
          console.error("\n[run.failed]", evt.data.message);
        }
      },
    });

    console.log(`[run] log dir: ${result.dir}`);
    process.exit(result.exit.code ?? 1);
  } catch (err) {
    console.error("[fatal]", err);
    process.exit(1);
  }
})();
