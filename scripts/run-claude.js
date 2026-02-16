// scripts/run-claude.js

/**
 * Simple CLI entry to test Engine v0.1 with Claude CLI provider.
 *
 * Usage:
 *   node scripts/run-claude.js "your prompt"
 */

const { buildClaudeCommand } = require("../src/providers/claude-cli");
const { runCommandStreaming } = require("../src/engine/runner");

const prompt = process.argv.slice(2).join(" ").trim();

if (!prompt) {
  console.error('Usage: node scripts/run-claude.js "your prompt"');
  process.exit(2);
}

(async () => {
  try {
    const { cmd, args } = buildClaudeCommand({ prompt });

    const result = await runCommandStreaming({
      providerName: "claude-cli",
      cmd,
      args,
      timeoutMs: Number(process.env.CLAUDE_TIMEOUT_MS || 10 * 60 * 1000),
      onEvent: (evt) => {
        // Stream assistant text live to stdout
        if (evt.type === "assistant.text") {
          process.stdout.write(evt.data.text);
        }

        if (evt.type === "run.failed") {
          console.error("\n[run.failed]", evt.data.message);
        }
      },
    });

    process.stdout.write("\n");
    console.log(`[run] log dir: ${result.dir}`);

    process.exit(result.exit.code ?? 1);
  } catch (err) {
    console.error("[fatal]", err);
    process.exit(1);
  }
})();