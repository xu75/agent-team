"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runTask } = require("../src/coordinator");

async function run() {
  const logsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cat-cafe-coordinator-"));
  let summary = null;
  try {
    summary = await runTask("smoke: unsupported provider should not crash", {
      provider: "unsupported-cli",
      maxIterations: 1,
      executionMode: "implementation",
      logsRoot,
    });
    assert(summary, "summary should exist");
    assert.strictEqual(summary.final_outcome, "provider_unsupported");
    assert.strictEqual(summary.final_status, "finalize");
    assert(Array.isArray(summary.rounds), "rounds should be an array");

    const summaryPath = path.join(summary.task_dir, "summary.json");
    const timelinePath = path.join(summary.task_dir, "task-timeline.json");
    assert(fs.existsSync(summaryPath), "summary.json should be written");
    assert(fs.existsSync(timelinePath), "task-timeline.json should be written");
  } finally {
    try {
      fs.rmSync(logsRoot, { recursive: true, force: true });
    } catch {}
  }
  process.stdout.write("coordinator provider unsupported test passed\n");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

