

// src/providers/claude-cli.js

/**
 * Claude CLI Provider (v0.1)
 *
 * This module is intentionally minimal:
 * - Build the command + args for Claude CLI in stream-json mode
 * - Keep authentication and environment concerns outside (handled by user's shell)
 */

function buildClaudeCommand({ prompt }) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("buildClaudeCommand: prompt must be a non-empty string");
  }

  const cmd = "claude";

  // NOTE:
  // - stream-json outputs NDJSON (one JSON object per line)
  // - --verbose is required with stream-json in Claude CLI
  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];

  return { cmd, args };
}

module.exports = { buildClaudeCommand };