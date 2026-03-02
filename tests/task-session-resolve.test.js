"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const LOGS_ROOT = path.join(ROOT, "logs");

function randomTaskId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function request(port, method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: { "Content-Type": "application/json" },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString("utf8");
        });
        res.on("end", () => {
          let parsed = data;
          try {
            parsed = JSON.parse(data);
          } catch {}
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function startServer(port) {
  const child = spawn(process.execPath, ["scripts/ui-server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      UI_HOST: "127.0.0.1",
      UI_PORT: String(port),
      TASK_RESOLVE_CACHE_TTL_MS: "5000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("ui-server start timeout"));
    }, 12000);

    function onData(chunk) {
      const text = chunk.toString("utf8");
      if (text.includes("UI server running:")) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
    }

    child.stdout.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      const detail = stderr.trim() ? `\n${stderr.trim()}` : "";
      reject(new Error(`ui-server exited early: ${code}${detail}`));
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  return child;
}

async function stopServer(child) {
  if (!child || child.killed) return;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 4000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function writeTaskDir(taskDir, { taskId, threadId = null, ts }) {
  fs.mkdirSync(path.join(taskDir, "rounds"), { recursive: true });
  const summary = {
    task_id: taskId,
    thread_id: threadId,
    project_id: threadId || "cat-cafe",
    project_name: "Resolver Test",
    provider: "workflow",
    final_status: "completed",
    final_outcome: "approved",
    rounds: [],
    unresolved_must_fix: [],
    state_events: [{ ts, to: "done" }],
  };
  fs.writeFileSync(path.join(taskDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(taskDir, "task.md"), `Task ${taskId}\n`, "utf8");
}

function cleanupDirs(paths) {
  for (const p of paths) {
    if (!p) continue;
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {}
  }
}

async function run() {
  const port = 4500 + Math.floor(Math.random() * 200);
  const threadSlug = `resolver-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const today = new Date().toISOString().slice(0, 10);

  const conflictId = randomTaskId();
  const threadOnlyId = randomTaskId();
  const legacyOnlyId = randomTaskId();

  const threadRoot = path.join(LOGS_ROOT, "threads", threadSlug, "sessions");
  const conflictThreadDir = path.join(threadRoot, `task-${conflictId}`);
  const threadOnlyDir = path.join(threadRoot, `task-${threadOnlyId}`);
  const legacyDateDir = path.join(LOGS_ROOT, today);
  const conflictLegacyDir = path.join(legacyDateDir, `task-${conflictId}`);
  const legacyOnlyDir = path.join(legacyDateDir, `task-${legacyOnlyId}`);

  const created = [
    conflictThreadDir,
    threadOnlyDir,
    conflictLegacyDir,
    legacyOnlyDir,
    path.join(LOGS_ROOT, "threads", threadSlug),
  ];

  const now = Date.now();
  writeTaskDir(conflictLegacyDir, { taskId: conflictId, ts: now - 20_000 });
  writeTaskDir(conflictThreadDir, { taskId: conflictId, threadId: threadSlug, ts: now - 5_000 });
  writeTaskDir(threadOnlyDir, { taskId: threadOnlyId, threadId: threadSlug, ts: now - 3_000 });
  writeTaskDir(legacyOnlyDir, { taskId: legacyOnlyId, ts: now - 4_000 });

  const server = await startServer(port);
  try {
    const detailConflict = await request(port, "GET", `/api/tasks/${conflictId}`);
    assert.strictEqual(detailConflict.status, 200);
    assert.strictEqual(detailConflict.body.task_source, "thread", "new thread path should win on newer timestamp");

    const msgConflict = await request(port, "GET", `/api/tasks/${conflictId}/messages`);
    assert.strictEqual(msgConflict.status, 200);
    assert.strictEqual(msgConflict.body.task_id, conflictId);

    const liveConflict = await request(port, "GET", `/api/tasks/${conflictId}/live`);
    assert.strictEqual(liveConflict.status, 200);
    assert.strictEqual(liveConflict.body.task_id, conflictId);

    const listRes = await request(port, "GET", "/api/tasks");
    assert.strictEqual(listRes.status, 200);
    const conflictRows = (listRes.body.tasks || []).filter((t) => t.task_id === conflictId);
    assert.strictEqual(conflictRows.length, 1, "list should dedupe same task_id");

    const legacyDetail = await request(port, "GET", `/api/tasks/${legacyOnlyId}`);
    assert.strictEqual(legacyDetail.status, 200);

    const legacyMessages = await request(port, "GET", `/api/tasks/${legacyOnlyId}/messages`);
    assert.strictEqual(legacyMessages.status, 200);

    const deleteThread = await request(port, "DELETE", `/api/tasks/${threadOnlyId}`);
    assert.strictEqual(deleteThread.status, 200);

    const afterDeleteThread = await request(port, "GET", `/api/tasks/${threadOnlyId}`);
    assert.strictEqual(afterDeleteThread.status, 404);

    const deleteLegacy = await request(port, "DELETE", `/api/tasks/${legacyOnlyId}`);
    assert.strictEqual(deleteLegacy.status, 200);

    const afterDeleteLegacy = await request(port, "GET", `/api/tasks/${legacyOnlyId}`);
    assert.strictEqual(afterDeleteLegacy.status, 404);

    process.stdout.write("task session resolve tests passed\n");
  } finally {
    await stopServer(server);
    cleanupDirs(created);
    // Best-effort cleanup empty date dir used by this test.
    try {
      fs.rmdirSync(legacyDateDir);
    } catch {}
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
