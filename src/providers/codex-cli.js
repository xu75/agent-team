"use strict";

/**
 * Codex CLI Provider (v0.1)
 *
 * Uses `codex exec` and keeps execution concerns in Engine.
 */
function buildCodexCommand({ prompt, model }) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("buildCodexCommand: prompt must be a non-empty string");
  }

  const cmd = "codex";
  const args = ["exec"];

  if (model && typeof model === "string") {
    args.push("--model", model);
  }

  args.push(prompt);

  return { cmd, args };
}

module.exports = { buildCodexCommand };
