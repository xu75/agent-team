"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  DEFAULT_ALLOWED_PREFIXES,
  normalizeAllowedPrefixes,
  classifyCommandAgainstAllowlist,
  runTestCommands,
} = require("../src/engine/test-runner");
const {
  summarizeTestRun,
  shouldRetryBlockedCommands,
  shouldFinalizeAsTesterCommandBlocked,
  normalizeTesterBlockedPolicy,
  buildTesterBlockedRetryFeedback,
} = require("../src/coordinator");

async function testStopOnFailureSkipsBlockedCommand() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cat-cafe-policy-"));
  const testFile = path.join(tempDir, "sample.test.js");
  fs.writeFileSync(
    testFile,
    [
      "const test = require('node:test');",
      "const assert = require('node:assert');",
      "test('smoke', () => assert.strictEqual(1, 1));",
      "",
    ].join("\n"),
    "utf8"
  );

  try {
    const testRun = await runTestCommands(
      [
        "echo blocked-first",
        `node --test ${JSON.stringify(testFile)}`,
      ],
      {
        allowedPrefixes: DEFAULT_ALLOWED_PREFIXES,
        stopOnFailure: true,
        streamOutput: false,
      }
    );

    assert.strictEqual(testRun.results.length, 2, "blocked command should not stop runnable command");
    assert.strictEqual(testRun.results[0].blocked, true);
    assert.strictEqual(testRun.results[1].runnable, true);
    assert.strictEqual(testRun.results[1].ok, true);
    assert.strictEqual(testRun.allPassed, true);

    const summary = summarizeTestRun(testRun);
    assert.strictEqual(summary.blocked_commands, 1);
    assert.strictEqual(summary.runnable_commands, 1);
    assert.strictEqual(summary.first_blocked_command, "echo blocked-first");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function testAllowlistValidation() {
  const fallback = normalizeAllowedPrefixes([]);
  assert.strictEqual(fallback.used_fallback, true);
  assert.deepStrictEqual(fallback.prefixes, DEFAULT_ALLOWED_PREFIXES);

  const sanitized = normalizeAllowedPrefixes([
    "npm test",
    "npm test",
    "node --test",
    "bash -lc test",
    "npm test && echo hacked",
  ]);
  assert.strictEqual(sanitized.used_fallback, false);
  assert.deepStrictEqual(sanitized.prefixes, ["npm test", "node --test"]);
  assert(sanitized.rejected.length >= 2);
}

function testCommandClassification() {
  const ok = classifyCommandAgainstAllowlist("npm test -- --grep smoke");
  assert.strictEqual(ok.allowed, true);

  const mismatch = classifyCommandAgainstAllowlist("npm run lint");
  assert.strictEqual(mismatch.allowed, false);
  assert.strictEqual(mismatch.blocked_reason, "allowlist_mismatch");
  assert.strictEqual(mismatch.retryable, true);

  const malicious = classifyCommandAgainstAllowlist("node -e \"require('child_process').exec('ls')\"");
  assert.strictEqual(malicious.allowed, false);
  assert.strictEqual(malicious.blocked_reason, "malicious_command");
  assert.strictEqual(malicious.retryable, false);

  const injection = classifyCommandAgainstAllowlist("npm test && echo hi");
  assert.strictEqual(injection.allowed, false);
  assert.strictEqual(injection.blocked_reason, "command_injection_characters");
}

function testRetryPolicyAndTerminalRule() {
  const summary = {
    blocked_commands: 2,
    runnable_commands: 0,
    retryable_blocked_commands: 2,
    malicious_blocked_commands: 0,
  };
  assert.strictEqual(shouldRetryBlockedCommands({ policy: "resilient", summary, retryCount: 0 }), true);
  assert.strictEqual(shouldRetryBlockedCommands({ policy: "resilient", summary, retryCount: 1 }), false);
  assert.strictEqual(shouldRetryBlockedCommands({ policy: "strict", summary, retryCount: 0 }), false);
  assert.strictEqual(shouldFinalizeAsTesterCommandBlocked(summary), true);

  const mixedSummary = {
    blocked_commands: 1,
    runnable_commands: 1,
    retryable_blocked_commands: 1,
    malicious_blocked_commands: 0,
  };
  assert.strictEqual(shouldFinalizeAsTesterCommandBlocked(mixedSummary), false);

  const maliciousSummary = {
    blocked_commands: 1,
    runnable_commands: 0,
    retryable_blocked_commands: 0,
    malicious_blocked_commands: 1,
  };
  assert.strictEqual(shouldRetryBlockedCommands({ policy: "resilient", summary: maliciousSummary, retryCount: 0 }), false);

  assert.strictEqual(normalizeTesterBlockedPolicy("resilient"), "resilient");
  assert.strictEqual(normalizeTesterBlockedPolicy("STRICT"), "strict");
  assert.strictEqual(normalizeTesterBlockedPolicy("unknown"), "strict");
}

function testRetryFeedbackTemplate() {
  const feedback = buildTesterBlockedRetryFeedback({
    blockedCommands: ["node -e \"...\"", "npm run lint"],
    allowedPrefixes: DEFAULT_ALLOWED_PREFIXES,
  });
  assert(feedback.includes("Blocked commands:"));
  assert(feedback.includes("Allowed command prefixes:"));
  assert(feedback.includes("node --test tests/**/*.test.js"));
  assert(feedback.includes("npm test -- --grep \"keyword\""));
}

async function run() {
  await testStopOnFailureSkipsBlockedCommand();
  testAllowlistValidation();
  testCommandClassification();
  testRetryPolicyAndTerminalRule();
  testRetryFeedbackTemplate();
  process.stdout.write("tester command policy tests passed\n");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
