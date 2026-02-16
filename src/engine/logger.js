
// src/engine/logger.js
const fs = require("node:fs");
const path = require("node:path");

/**
 * Ensure directory exists (recursive).
 */
function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Format date as YYYY-MM-DD.
 */
function formatDateYYYYMMDD(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Generate a simple runId.
 * Not globally unique, but sufficient for local dev.
 */
function makeRunId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * Create directory for this run:
 * logs/YYYY-MM-DD/run-<id>/
 */
function createRunLogDir(root = "logs") {
  const date = formatDateYYYYMMDD();
  const runId = makeRunId();
  const dir = path.join(root, date, `run-${runId}`);

  ensureDir(dir);

  return { runId, dir };
}

/**
 * Create a simple line-based writer.
 * Each call to writeLine will append one line.
 */
function createLineWriter(filePath) {
  const stream = fs.createWriteStream(filePath, {
    flags: "a",
  });

  return {
    writeLine(line) {
      if (!line.endsWith("\n")) {
        stream.write(line + "\n");
      } else {
        stream.write(line);
      }
    },
    close() {
      return new Promise((resolve) => stream.end(resolve));
    },
  };
}

module.exports = {
  createRunLogDir,
  createLineWriter,
};