"use strict";

const { spawn } = require("node:child_process");
const readline = require("node:readline");

/**
 * Run Claude CLI and return the full assistant text as a string.
 *
 * options:
 *  - timeoutMs: idle timeout (default 10 min)
 *  - verbose: whether to pass --verbose (default true for stream-json)
 *  - output:  "inherit" | "silent"  (default "inherit" prints streamed text)
 */
function runClaude(prompt, options = {}) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    return Promise.reject(new Error("prompt must be a non-empty string"));
  }

  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 10 * 60 * 1000;
  const verbose = options.verbose !== false; // default true
  const output = options.output || "inherit";

  const args = ["-p", prompt, "--output-format", "stream-json"];
  if (verbose) args.push("--verbose");

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let finished = false;
    let lastActivity = Date.now();
    let fullText = "";

    function markActivity() {
      lastActivity = Date.now();
    }

    // Avoid crashing on EPIPE when user pipes output (e.g. | head)
    // If stdout closes early, we just stop writing.
    let canWrite = true;
    process.stdout.on("error", (err) => {
      if (err && err.code === "EPIPE") canWrite = false;
    });

    function writeOut(s) {
      if (output !== "inherit") return;
      if (!canWrite) return;
      try {
        process.stdout.write(s);
      } catch (e) {
        // If downstream closes, ignore
        canWrite = false;
      }
    }

    function done(err, code) {
      if (finished) return;
      finished = true;
      clearInterval(timer);

      // Close readers (safe even if already closed)
      try { rlOut.close(); } catch {}
      try { rlErr.close(); } catch {}

      if (err) return reject(err);
      if (code !== 0) return reject(new Error(`claude exited with code ${code}`));
      return resolve(fullText);
    }

    // Two-phase termination
    const GRACE_MS = 5000;
    let killTimer = null;

    function terminate(reason) {
      if (finished) return;
      clearInterval(timer);

      try { child.kill("SIGTERM"); } catch {}

      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        if (reason) {
          // keep this on stderr so it doesn't pollute stdout output
          console.error(reason);
        }
        // If close never arrives, force exit path
        done(new Error(reason || "killed"), 1);
      }, GRACE_MS);

      // Don’t keep node alive just for the kill timer
      if (killTimer && typeof killTimer.unref === "function") killTimer.unref();
    }

    // Parent signal forwarding
    process.once("SIGINT", () => terminate("[parent] SIGINT -> terminating claude"));
    process.once("SIGTERM", () => terminate("[parent] SIGTERM -> terminating claude"));

    // stdout NDJSON parser
    const rlOut = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
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

      // Example: {"type":"assistant","message":{"content":[{"type":"text","text":"Hello!"}]}}
      if (evt?.type !== "assistant") return;

      const content = evt?.message?.content;
      if (!Array.isArray(content)) return;

      for (const part of content) {
        if (part?.type === "text" && typeof part.text === "string") {
          fullText += part.text;
          writeOut(part.text);
        }
      }
    });

    // stderr: count as activity to avoid false timeouts
    const rlErr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    rlErr.on("line", () => {
      markActivity();
      // Keep stderr clean by default; enable if you want:
      // console.error(line);
    });

    child.on("error", (err) => {
      if (killTimer) clearTimeout(killTimer);
      done(new Error(`spawn error: ${err.message}`), 1);
    });

    child.on("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      // Ensure a newline if we streamed output
      if (output === "inherit") writeOut("\n");

      if (signal) return done(new Error(`terminated by signal: ${signal}`), 1);
      return done(null, code ?? 1);
    });

    // Idle timeout (counts stdout + stderr)
    const timer = setInterval(() => {
      const idle = Date.now() - lastActivity;
      if (idle > timeoutMs) {
        terminate(`[timeout] no activity for ${Math.round(idle / 1000)}s`);
      }
    }, 1000);
    if (typeof timer.unref === "function") timer.unref();
  });
}

module.exports = { runClaude };
