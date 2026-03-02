"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { createThread: createLegacyChatSession } = require("../src/engine/chat-session");

const ROOT = path.resolve(__dirname, "..");
const LOGS_ROOT = path.join(ROOT, "logs");

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
      TASK_RESOLVE_CACHE_TTL_MS: "1000",
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

function threadDir(threadId) {
  return path.join(LOGS_ROOT, "threads", threadId);
}

async function run() {
  const port = 5100 + Math.floor(Math.random() * 200);
  const threadA = `visible-a-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const threadB = `visible-b-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const threadEmpty = `visible-empty-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const createdDirs = [
    threadDir(threadA),
    threadDir(threadB),
    threadDir(threadEmpty),
  ];

  const server = await startServer(port);
  try {
    const createdA = await request(port, "POST", "/api/threads", {
      slug: threadA,
      name: "CAT CAFE",
    });
    assert.strictEqual(createdA.status, 201, `create thread A failed: ${createdA.status}`);

    const createdB = await request(port, "POST", "/api/threads", {
      slug: threadB,
      name: "CAT CAFE",
    });
    assert.strictEqual(createdB.status, 201, `create thread B failed: ${createdB.status}`);

    const createdEmpty = await request(port, "POST", "/api/threads", {
      slug: threadEmpty,
      name: "Agent-Team",
    });
    assert.strictEqual(createdEmpty.status, 201, `create empty thread failed: ${createdEmpty.status}`);

    const a1 = await request(port, "POST", `/api/threads/${threadA}/sessions`, { title: "A1" });
    const a2 = await request(port, "POST", `/api/threads/${threadA}/sessions`, { title: "A2" });
    const b1 = await request(port, "POST", `/api/threads/${threadB}/sessions`, { title: "B1" });
    assert.strictEqual(a1.status, 200);
    assert.strictEqual(a2.status, 200);
    assert.strictEqual(b1.status, 200);

    const legacyBound = createLegacyChatSession(LOGS_ROOT, "legacy-bound", "free_chat", null, null);
    const legacyBoundDir = threadDir(legacyBound.thread_id);
    createdDirs.push(legacyBoundDir);
    const legacyBoundMetaPath = path.join(legacyBoundDir, "meta.json");
    const legacyBoundMeta = JSON.parse(fs.readFileSync(legacyBoundMetaPath, "utf8"));
    legacyBoundMeta.parent_thread = threadA;
    fs.writeFileSync(legacyBoundMetaPath, `${JSON.stringify(legacyBoundMeta, null, 2)}\n`, "utf8");

    const legacyUnassigned = createLegacyChatSession(LOGS_ROOT, "legacy-unassigned", "free_chat", null, null);
    const legacyUnassignedDir = threadDir(legacyUnassigned.thread_id);
    createdDirs.push(legacyUnassignedDir);

    const threadListRes = await request(port, "GET", "/api/threads");
    assert.strictEqual(threadListRes.status, 200);
    const threads = Array.isArray(threadListRes.body?.threads) ? threadListRes.body.threads : [];
    const rowA = threads.find((t) => t.thread_id === threadA);
    const rowB = threads.find((t) => t.thread_id === threadB);
    const rowEmpty = threads.find((t) => t.thread_id === threadEmpty);
    assert(rowA, "thread A missing in /api/threads");
    assert(rowB, "thread B missing in /api/threads");
    assert(rowEmpty, "empty thread missing in /api/threads");
    assert.strictEqual(rowA.visible_count, rowA.breakdown.scoped + rowA.breakdown.legacy);
    assert.strictEqual(rowB.visible_count, rowB.breakdown.scoped + rowB.breakdown.legacy);
    assert.strictEqual(rowEmpty.visible_count, 0, "empty thread visible_count should be 0");

    const tasksA = await request(port, "GET", `/api/tasks?thread_id=${encodeURIComponent(threadA)}`);
    assert.strictEqual(tasksA.status, 200);
    const listA = tasksA.body?.tasks || [];
    assert.strictEqual(listA.length, rowA.visible_count, "thread A count should match visible_count");
    assert(listA.every((t) => String(t.thread_id || "") === threadA), "thread A filter should not leak unassigned");
    assert(listA.some((t) => t.task_id === legacyBound.thread_id), "bound legacy session should appear in thread A");
    assert(!listA.some((t) => t.task_id === legacyUnassigned.thread_id), "unassigned legacy should not appear in thread A");

    const tasksB = await request(port, "GET", `/api/tasks?thread_id=${encodeURIComponent(threadB)}`);
    assert.strictEqual(tasksB.status, 200);
    const listB = tasksB.body?.tasks || [];
    assert.strictEqual(listB.length, rowB.visible_count, "thread B count should match visible_count");
    assert(listB.every((t) => String(t.thread_id || "") === threadB), "thread B filter should only return thread B tasks");

    const allTasksRes = await request(port, "GET", "/api/tasks");
    assert.strictEqual(allTasksRes.status, 200);
    const allTasks = allTasksRes.body?.tasks || [];
    const unassignedRow = allTasks.find((t) => t.task_id === legacyUnassigned.thread_id);
    assert(unassignedRow, "unassigned legacy row should exist in all-task view");
    assert.strictEqual(unassignedRow.thread_id, null, "unassigned legacy row thread_id should be null");
    assert.strictEqual(unassignedRow.project_name, null, "unassigned legacy row project_name should be null");

    process.stdout.write("thread visible count tests passed\n");
  } finally {
    await stopServer(server);
    for (const dir of createdDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
