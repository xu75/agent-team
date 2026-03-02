"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { createThread, appendMessage } = require("../src/engine/chat-session");

const ROOT = path.resolve(__dirname, "..");

function mkLogsRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cat-cafe-thread-session-"));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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
      THREAD_FALLBACK_ENABLED: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("ui-server start timeout"));
    }, 10000);

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
      reject(new Error(`ui-server exited early: ${code}`));
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
    const timer = setTimeout(resolve, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function testAppendMessageUpdatesMetaAndRollback() {
  const logsRoot = mkLogsRoot();
  const parent = "blocker-a";
  const session = createThread(logsRoot, "test", "free_chat", null, parent);
  const sessionDir = path.join(logsRoot, "threads", parent, "sessions", session.thread_id);
  const metaPath = path.join(sessionDir, "meta.json");
  const msgPath = path.join(sessionDir, "messages.jsonl");

  const meta0 = readJson(metaPath);
  appendMessage(logsRoot, session.thread_id, {
    sender: "user",
    sender_type: "user",
    text: "one",
    ts: Date.now(),
  }, parent);
  const meta1 = readJson(metaPath);
  assert(meta1.updated_at > meta0.updated_at, "updated_at should increase after first append");

  appendMessage(logsRoot, session.thread_id, {
    sender: "user",
    sender_type: "user",
    text: "two",
    ts: meta1.updated_at,
  }, parent);
  const meta2 = readJson(metaPath);
  assert(meta2.updated_at > meta1.updated_at, "updated_at should be strictly monotonic");

  const before = fs.existsSync(msgPath) ? fs.readFileSync(msgPath, "utf8") : "";
  fs.rmSync(metaPath, { force: true });
  assert.throws(
    () => appendMessage(logsRoot, session.thread_id, {
      sender: "user",
      sender_type: "user",
      text: "rollback",
      ts: Date.now(),
    }, parent),
    (err) => err && err.code === "SESSION_META_MISSING"
  );
  const after = fs.existsSync(msgPath) ? fs.readFileSync(msgPath, "utf8") : "";
  assert.strictEqual(after, before, "message append should rollback when meta touch fails");
}

async function testAssertThreadIdCompatibility() {
  const port = 4300 + Math.floor(Math.random() * 200);
  const server = await startServer(port);
  const slug = `compat-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  let created = false;

  try {
    const createThreadRes = await request(port, "POST", "/api/threads", {
      slug,
      name: slug,
    });
    assert.strictEqual(createThreadRes.status, 201, `create thread failed: ${createThreadRes.status}`);
    created = true;

    const createSessionRes = await request(port, "POST", `/api/threads/${slug}/sessions`, {
      title: "compat-session",
    });
    assert.strictEqual(createSessionRes.status, 200, `create session failed: ${createSessionRes.status}`);
    const sessionId = String(createSessionRes.body?.session?.thread_id || "");
    assert(sessionId, "missing session id");

    const chatRes = await request(port, "POST", "/api/chat", {
      thread_id: sessionId,
      message: "compat check",
      role_config: { models: [], stage_assignment: {}, role_profiles: {} },
    });
    assert.notStrictEqual(chatRes.status, 404, "legacy /api/chat thread_id(session) should not 404");
    assert.notStrictEqual(chatRes.status, 422, "legacy /api/chat thread_id(session) should resolve container");

    const taskRunRes = await request(port, "POST", "/api/tasks/run", {
      prompt: "container route should reject session thread_id",
      thread_id: sessionId,
    });
    assert.strictEqual(taskRunRes.status, 422, "non-chat route should reject session thread_id");
  } finally {
    if (created) {
      await request(port, "PATCH", `/api/threads/${slug}`, {
        archived: true,
        operator: "test",
        reason: "cleanup",
      });
      await request(port, "DELETE", `/api/threads/${slug}`, {
        operator: "test",
        reason: "cleanup",
      });
    }
    await stopServer(server);
  }
}

async function run() {
  testAppendMessageUpdatesMetaAndRollback();
  if (String(process.env.ALLOW_UI_SOCKET_TESTS || "").trim() === "1") {
    await testAssertThreadIdCompatibility();
  } else {
    process.stdout.write("skip ui integration (set ALLOW_UI_SOCKET_TESTS=1 to enable)\n");
  }
  process.stdout.write("thread-session blockers tests passed\n");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
