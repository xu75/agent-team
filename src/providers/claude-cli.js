

// src/providers/claude-cli.js

/**
 * Claude CLI Provider (v0.1)
 *
 * This module is intentionally minimal:
 * - Build the command + args for Claude CLI in stream-json mode
 * - Keep authentication and environment concerns outside (handled by user's shell)
 */

function buildClaudeCommand({ prompt, model }) {
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

  const resolvedModel = (model || process.env.CLAUDE_MODEL || "").trim();
  if (resolvedModel) {
    args.push("--model", resolvedModel);
  }

  return { cmd, args };
}

module.exports = { buildClaudeCommand };
