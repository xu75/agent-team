"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Gemini CLI Provider (v0.1)
 *
 * Placeholder provider for Gemini CLI.
 * Uses `gemini` command if available, similar pattern to codex-cli.
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

function resolveGeminiBinary() {
  const explicit = String(process.env.GEMINI_BIN || "").trim();
  if (explicit && isExecutable(explicit)) return explicit;

  const byPath = resolveFromPath("gemini", process.env.PATH);
  if (byPath) return byPath;

  const candidates = [
    "/opt/homebrew/bin/gemini",
    "/usr/local/bin/gemini",
  ];
  for (const c of candidates) {
    if (isExecutable(c)) return c;
  }

  return explicit || "gemini";
}

function buildGeminiCommand({ prompt, model }) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("buildGeminiCommand: prompt must be a non-empty string");
  }

  const cmd = resolveGeminiBinary();
  const args = [];

  if (model && typeof model === "string") {
    args.push("--model", model);
  }

  args.push(prompt);

  return { cmd, args };
}

module.exports = { buildGeminiCommand };
