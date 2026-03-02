"use strict";

const { runTask } = require("./coordinator");

const prompt = process.argv.slice(2).join(" ").trim() || "用一句话介绍你自己";
const provider = process.env.PROVIDER || "claude-cli";
const model = process.env.CODEX_MODEL || undefined;
const maxIterations = Number(process.env.MAX_ITERATIONS || 3);
const testCommandTimeoutMs = Number(process.env.TEST_COMMAND_TIMEOUT_MS || 120000);
const allowedTestCommands = process.env.ALLOWED_TEST_COMMANDS
  ? process.env.ALLOWED_TEST_COMMANDS.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;
const testerBlockedPolicy = process.env.TESTER_BLOCKED_POLICY
  ? String(process.env.TESTER_BLOCKED_POLICY).trim()
  : undefined;

runTask(prompt, {
  provider,
  model,
  maxIterations,
  testCommandTimeoutMs,
  allowedTestCommands,
  testerBlockedPolicy,
})
  .then((summary) => {
    console.error("\n--- task summary ---\n" + JSON.stringify(summary, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exit(1);
  });
