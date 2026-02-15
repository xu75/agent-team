#!/usr/bin/env node
/**
 * minimal-claude.js (Lesson 02 hardened)
 * Usage:
 *   node minimal-claude.js "你好，请用一句话介绍自己"
 *
 * Env:
 *   CLAUDE_TIMEOUT_MS=600000   # 默认 10 分钟
 */

const { spawn } = require("node:child_process");
const readline = require("node:readline");

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error('Usage: node minimal-claude.js "your prompt"');
  process.exit(2);
}

const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 10 * 60 * 1000);
const GRACE_MS = 5000;

const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];

const child = spawn("claude", args, {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});

let lastActivity = Date.now();
let finished = false;
let sawAnyOutput = false;

function markActivity() {
  lastActivity = Date.now();
  sawAnyOutput = true;
}

function gracefulKill(reason) {
  if (finished) return;
  finished = true;

  try {
    // 1) try SIGTERM
    child.kill("SIGTERM");
  } catch {}

  // 2) after grace period, SIGKILL if still alive
  setTimeout(() => {
    try {
      if (!child.killed) child.kill("SIGKILL");
    } catch {}
    if (reason) console.error(reason);
  }, GRACE_MS);
}

// Parent signal handling (avoid orphan child)
process.on("SIGINT", () => gracefulKill("\n[parent] SIGINT -> stopping claude..."));
process.on("SIGTERM", () => gracefulKill("\n[parent] SIGTERM -> stopping claude..."));

const rlOut = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
const rlErr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });

function printAssistantText(evt) {
  // Matches your example:
  // {"type":"assistant","message":{"content":[{"type":"text","text":"Hello!"}]}}
  const content = evt?.message?.content;
  if (!Array.isArray(content)) return;

  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      process.stdout.write(part.text);
    }
  }
}

rlOut.on("line", (line) => {
  markActivity();
  const s = line.trim();
  if (!s) return;

  let evt;
  try {
    evt = JSON.parse(s);
  } catch {
    return;
  }
  if (evt?.type === "assistant") printAssistantText(evt);
});

rlErr.on("line", (_line) => {
  // verbose / tool/thinking logs may go to stderr;
  // count as activity to avoid false timeout.
  markActivity();
  // 这里不打印 stderr，保持输出干净；需要调试可改为 console.error(_line)
});

const timer = setInterval(() => {
  const idle = Date.now() - lastActivity;
  if (idle > TIMEOUT_MS) {
    clearInterval(timer);
    gracefulKill(`[timeout] no activity for ${Math.round(idle / 1000)}s`);
  }
}, 1000);

child.on("error", (err) => {
  clearInterval(timer);
  console.error("[spawn error]", err.message);
  process.exit(1);
});

child.on("close", (code, signal) => {
  clearInterval(timer);
  finished = true;

  // ensure newline after streaming output
  if (sawAnyOutput) process.stdout.write("\n");

  if (signal) {
    console.error(`[exit] terminated by signal: ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
