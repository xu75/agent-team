"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
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
    const options = {
      hostname: "127.0.0.1",
      port,
      path: urlPath,
      method,
      headers: { "Content-Type": "application/json" },
    };
    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
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
      TASK_RESOLVE_CACHE_TTL_MS: "3000",
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

function createMockTask(taskId) {
  const today = new Date().toISOString().slice(0, 10);
  const taskDir = path.join(LOGS_ROOT, today, `task-${taskId}`);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, "summary.json"),
    JSON.stringify({ task_id: taskId, final_status: "completed" })
  );
  fs.writeFileSync(path.join(taskDir, "task.md"), "Test task");
  return { taskDir, date: today };
}

function createMockThreadTask(taskId) {
  const threadSlug = `delete-test-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const taskDir = path.join(LOGS_ROOT, "threads", threadSlug, "sessions", `task-${taskId}`);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(
    path.join(taskDir, "summary.json"),
    JSON.stringify({
      task_id: taskId,
      thread_id: threadSlug,
      final_status: "completed",
      state_events: [{ ts: Date.now() }],
    })
  );
  fs.writeFileSync(path.join(taskDir, "task.md"), "Thread task");
  return { taskDir, threadRoot: path.join(LOGS_ROOT, "threads", threadSlug) };
}

function createMockThreadChatSession(sessionId) {
  const threadSlug = `delete-chat-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const sessionDir = path.join(LOGS_ROOT, "threads", threadSlug, "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "meta.json"),
    JSON.stringify({
      thread_id: sessionId,
      parent_thread: threadSlug,
      title: "Chat session for delete test",
      mode: "free_chat",
      created_at: Date.now(),
      updated_at: Date.now(),
    })
  );
  fs.writeFileSync(
    path.join(sessionDir, "messages.jsonl"),
    JSON.stringify({
      id: `${Date.now()}-m1`,
      sender: "铲屎官",
      sender_type: "user",
      text: "hello",
      ts: Date.now(),
    }) + "\n"
  );
  const threadDir = path.join(LOGS_ROOT, "threads", threadSlug);
  fs.writeFileSync(
    path.join(threadDir, "thread.json"),
    JSON.stringify({
      thread_id: threadSlug,
      name: "Delete Chat Test",
      description: "",
      created_at: Date.now(),
      updated_at: Date.now(),
      archived: false,
    })
  );
  return { sessionDir, threadRoot: threadDir };
}

async function runTests() {
  console.log("Running delete task API tests...\n");
  const port = 4700 + Math.floor(Math.random() * 200);
  const server = await startServer(port);
  let cleanupDateDir = null;
  let cleanupThreadRoot = null;

  try {
    // Test 1: Delete success
    console.log("Test 1: Delete existing task - should return 200");
    const testTaskId1 = randomTaskId();
    const { taskDir: taskDir1, date: date1 } = createMockTask(testTaskId1);
    cleanupDateDir = path.join(LOGS_ROOT, date1);
    assert(fs.existsSync(taskDir1), "Mock task should exist before delete");

    const res1 = await request(port, "DELETE", `/api/tasks/${testTaskId1}`);
    assert.strictEqual(res1.status, 200, `Expected 200, got ${res1.status}`);
    assert.strictEqual(res1.body.ok, true);
    assert.strictEqual(res1.body.task_id, testTaskId1);
    assert(!fs.existsSync(taskDir1), "Task directory should be deleted");
    console.log("  PASS\n");

    // Test 2: Task not found (404)
    console.log("Test 2: Delete non-existent task - should return 404");
    const res2 = await request(port, "DELETE", "/api/tasks/9999999999999-deadbeef");
    assert.strictEqual(res2.status, 404, `Expected 404, got ${res2.status}`);
    assert(res2.body.error, "Should have error message");
    console.log("  PASS\n");

    // Test 3: Delete thread-scoped task success (200)
    console.log("Test 3: Delete thread-scoped task - should return 200");
    const testTaskId3 = randomTaskId();
    const { taskDir: threadTaskDir, threadRoot } = createMockThreadTask(testTaskId3);
    cleanupThreadRoot = threadRoot;
    assert(fs.existsSync(threadTaskDir), "Thread-scoped task should exist before delete");
    const res3 = await request(port, "DELETE", `/api/tasks/${testTaskId3}`);
    assert.strictEqual(res3.status, 200, `Expected 200, got ${res3.status}`);
    assert(!fs.existsSync(threadTaskDir), "Thread-scoped task directory should be deleted");
    console.log("  PASS\n");

    // Test 4: Delete thread-scoped chat session success (200)
    console.log("Test 4: Delete thread-scoped chat session - should return 200 and remove dir");
    const testSessionId4 = randomTaskId();
    const { sessionDir: chatSessionDir, threadRoot: chatThreadRoot } = createMockThreadChatSession(testSessionId4);
    cleanupThreadRoot = chatThreadRoot;
    assert(fs.existsSync(chatSessionDir), "Thread-scoped chat session should exist before delete");
    const res4 = await request(port, "DELETE", `/api/tasks/${testSessionId4}`);
    assert.strictEqual(res4.status, 200, `Expected 200, got ${res4.status}`);
    assert(!fs.existsSync(chatSessionDir), "Thread-scoped chat session directory should be deleted");
    console.log("  PASS\n");

    // Test 5: Invalid task ID format (400)
    console.log("Test 5: Delete with invalid task ID format - should return 400");
    const res5 = await request(port, "DELETE", "/api/tasks/invalid-id");
    assert.strictEqual(res5.status, 400, `Expected 400, got ${res5.status}`);
    assert(res5.body.error, "Should have error message");
    console.log("  PASS\n");

    // Test 6: Path traversal attempt (400)
    console.log("Test 6: Path traversal attempt - should return 400");
    const res6 = await request(port, "DELETE", "/api/tasks/..%2F..%2Fetc");
    assert.strictEqual(res6.status, 400, `Expected 400, got ${res6.status}`);
    console.log("  PASS\n");

    // Test 7: Path with slashes (400)
    console.log("Test 7: Task ID with slashes - should return 400");
    const res7 = await request(port, "DELETE", "/api/tasks/2099-01-01/task");
    assert(res7.status === 400 || res7.status === 404, `Expected 400 or 404, got ${res7.status}`);
    console.log("  PASS\n");

    console.log("All tests passed!");
  } finally {
    await stopServer(server);
    if (cleanupDateDir && fs.existsSync(cleanupDateDir)) {
      try {
        fs.rmdirSync(cleanupDateDir);
      } catch {}
    }
    if (cleanupThreadRoot && fs.existsSync(cleanupThreadRoot)) {
      try {
        fs.rmSync(cleanupThreadRoot, { recursive: true, force: true });
      } catch {}
    }
  }
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
