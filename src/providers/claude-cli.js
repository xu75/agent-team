

// src/providers/claude-cli.js

const path = require("node:path");
const os = require("node:os");

/**
 * Claude CLI Provider (v0.2)
 *
 * This module is intentionally minimal:
 * - Build the command + args for Claude CLI in stream-json mode
 * - Support --settings for switching API backend (e.g. GLM via settings_glm.json)
 * - Keep authentication and environment concerns outside (handled by user's shell)
 */

function expandHome(filePath) {
  if (!filePath || typeof filePath !== "string") return filePath;
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function buildClaudeCommand({ prompt, model, settingsFile }) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("buildClaudeCommand: prompt must be a non-empty string");
  }

  const cmd = "claude";
  const permissionMode = String(
    process.env.CLAUDE_PERMISSION_MODE || "acceptEdits"
  ).trim();
  const validModes = new Set([
    "acceptEdits",
    "bypassPermissions",
    "default",
    "delegate",
    "dontAsk",
    "plan",
  ]);
  const resolvedPermissionMode = validModes.has(permissionMode)
    ? permissionMode
    : "acceptEdits";

  // NOTE:
  // - stream-json outputs NDJSON (one JSON object per line)
  // - --verbose is required with stream-json in Claude CLI
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    resolvedPermissionMode,
  ];

  if (settingsFile && typeof settingsFile === "string") {
    args.push("--settings", expandHome(settingsFile.trim()));
  }

  // NOTE:
  // Some custom BASE_URL backends do not support stable model ids via --model.
  // Default behavior: do NOT pass --model; let backend/server-side default model resolve.
  // Set CLAUDE_USE_MODEL_ARG=1 to restore explicit --model passing.
  const useModelArg = /^(1|true|yes)$/i.test(String(process.env.CLAUDE_USE_MODEL_ARG || "").trim());
  if (useModelArg && model && typeof model === "string" && model.trim()) {
    args.push("--model", model.trim());
  }

  return { cmd, args };
}

module.exports = { buildClaudeCommand };
