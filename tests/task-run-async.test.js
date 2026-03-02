"use strict";

const assert = require("node:assert");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_THREAD = path.basename(ROOT).toLowerCase();

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

async function run() {
  const port = 4900 + Math.floor(Math.random() * 200);
  const server = await startServer(port);
  let acceptedTaskId = "";

  try {
    const invalidRoleConfig = {
      version: 3,
      models: [{ id: "bad", name: "Bad", provider: "unsupported-cli" }],
      stage_assignment: { coder: "bad", reviewer: "bad", tester: "bad" },
      role_profiles: {
        coder: { display_name: "Coder", role_title: "CoreDev", nickname: "C1" },
        reviewer: { display_name: "Reviewer", role_title: "Reviewer", nickname: "R1" },
        tester: { display_name: "Tester", role_title: "Tester", nickname: "T1" },
      },
    };

    const invalid = await request(port, "POST", "/api/tasks/run", {
      prompt: "invalid provider should fail fast",
      thread_slug: DEFAULT_THREAD,
      role_config: invalidRoleConfig,
    });
    assert.strictEqual(invalid.status, 400, `expected 400, got ${invalid.status}`);
    assert.strictEqual(invalid.body.code, "provider_unsupported");
    assert(Array.isArray(invalid.body.details), "details should be an array");
    assert(invalid.body.details.length >= 1, "details should include at least one invalid stage");

    const accepted = await request(port, "POST", "/api/tasks/run", {
      prompt: "async smoke test",
      thread_slug: DEFAULT_THREAD,
      project_id: DEFAULT_THREAD,
    });
    assert.strictEqual(accepted.status, 202, `expected 202, got ${accepted.status}`);
    assert.strictEqual(accepted.body.accepted, true, "accepted should be true");
    acceptedTaskId = String(accepted.body.task_id || "");
    assert(/^\d+-[a-f0-9]+$/.test(acceptedTaskId), `unexpected task id: ${acceptedTaskId}`);

    const cancel = await request(port, "POST", `/api/tasks/${acceptedTaskId}/cancel`);
    assert.strictEqual(cancel.status, 200, `expected 200, got ${cancel.status}`);
    assert.strictEqual(String(cancel.body.task_id || ""), acceptedTaskId);

    const list = await request(port, "GET", "/api/tasks");
    assert.strictEqual(list.status, 200, `expected 200, got ${list.status}`);

    process.stdout.write("task run async tests passed\n");
  } finally {
    if (acceptedTaskId) {
      try {
        await request(port, "DELETE", `/api/tasks/${acceptedTaskId}`);
      } catch {}
    }
    await stopServer(server);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

