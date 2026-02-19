"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const ROOT = path.resolve(__dirname, "..");
const LOGS_ROOT = path.join(ROOT, "logs");

function request(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port: 4173,
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

function createMockTask(taskId) {
  // taskId 格式: {timestamp}-{hash}，如 1771382424778-1568fc9e
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

async function runTests() {
  console.log("Running delete task API tests...\n");

  // Test 1: Delete success - 使用真实的 taskId 格式
  console.log("Test 1: Delete existing task - should return 200");
  const testTaskId1 = "2099123456789-abcd1234";
  const { taskDir: taskDir1, date: date1 } = createMockTask(testTaskId1);
  assert(fs.existsSync(taskDir1), "Mock task should exist before delete");

  const res1 = await request("DELETE", `/api/tasks/${testTaskId1}`);
  assert.strictEqual(res1.status, 200, `Expected 200, got ${res1.status}`);
  assert.strictEqual(res1.body.ok, true);
  assert.strictEqual(res1.body.task_id, testTaskId1);
  assert(!fs.existsSync(taskDir1), "Task directory should be deleted");
  console.log("  PASS\n");

  // Test 2: Task not found (404) - 使用合法格式但不存在的 taskId
  console.log("Test 2: Delete non-existent task - should return 404");
  const res2 = await request("DELETE", "/api/tasks/9999999999999-deadbeef");
  assert.strictEqual(res2.status, 404, `Expected 404, got ${res2.status}`);
  assert(res2.body.error, "Should have error message");
  console.log("  PASS\n");

  // Test 3: Invalid task ID format (400) - 不符合 {timestamp}-{hash} 格式
  console.log("Test 3: Delete with invalid task ID format - should return 400");
  const res3 = await request("DELETE", "/api/tasks/invalid-id");
  assert.strictEqual(res3.status, 400, `Expected 400, got ${res3.status}`);
  assert(res3.body.error, "Should have error message");
  console.log("  PASS\n");

  // Test 4: Path traversal attempt (400)
  console.log("Test 4: Path traversal attempt - should return 400");
  const res4 = await request("DELETE", "/api/tasks/..%2F..%2Fetc");
  assert.strictEqual(res4.status, 400, `Expected 400, got ${res4.status}`);
  console.log("  PASS\n");

  // Test 5: Path with slashes (400)
  console.log("Test 5: Task ID with slashes - should return 400");
  const res5 = await request("DELETE", "/api/tasks/2099-01-01/task");
  assert(res5.status === 400 || res5.status === 404, `Expected 400 or 404, got ${res5.status}`);
  console.log("  PASS\n");

  // Cleanup test date directory if empty
  const testDateDir = path.join(LOGS_ROOT, date1);
  if (fs.existsSync(testDateDir)) {
    try {
      fs.rmdirSync(testDateDir);
    } catch {}
  }

  console.log("All tests passed!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
