"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Codex CLI Provider (v0.1)
 *
 * Uses `codex exec` and keeps execution concerns in Engine.
 */
function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveFromPath(bin, pathEnv) {
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = String(pathEnv || "")
    .split(sep)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, bin);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

function resolveCodexBinary() {
  const explicit = String(process.env.CODEX_BIN || "").trim();
  if (explicit && isExecutable(explicit)) return explicit;

  const byPath = resolveFromPath("codex", process.env.PATH);
  if (byPath) return byPath;

  const candidates = [
    "/Applications/Codex.app/Contents/Resources/codex",
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ];
  for (const c of candidates) {
    if (isExecutable(c)) return c;
  }

  return explicit || "codex";
}

function buildCodexCommand({ prompt, model }) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("buildCodexCommand: prompt must be a non-empty string");
  }

  const cmd = resolveCodexBinary();
  const args = ["exec"];

  if (model && typeof model === "string") {
    args.push("--model", model);
  }

  args.push(prompt);

  return { cmd, args };
}

module.exports = { buildCodexCommand };
