#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { rebuildIndex, validateAndRepairIndex } = require("../src/engine/project-manager");

const ROOT = path.resolve(__dirname, "..");
const LOGS_ROOT = path.join(ROOT, "logs");
const force = process.argv.includes("--force");

const result = force
  ? { repaired: true, index: rebuildIndex(LOGS_ROOT) }
  : validateAndRepairIndex(LOGS_ROOT);

const index = result?.index || { threads: {}, rebuilt_at: null };
process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      logs_root: LOGS_ROOT,
      repaired: !!result?.repaired,
      thread_count: Object.keys(index.threads || {}).length,
      rebuilt_at: index.rebuilt_at || null,
    },
    null,
    2
  ) + "\n"
);
