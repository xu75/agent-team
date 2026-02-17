"use strict";

const { executeProviderText } = require("../providers/execute-provider");

function buildTesterPrompt({ taskPrompt, coderOutput, roleProfile = {}, peerProfiles = {} }) {
  const meName = roleProfile.display_name || "Tester";
  const meTitle = roleProfile.role_title || "Tester";
  const coder = peerProfiles.coder || {};
  const reviewer = peerProfiles.reviewer || {};
  const coderNick = coder.nickname || coder.display_name || "Coder";
  const reviewerNick = reviewer.nickname || reviewer.display_name || "Reviewer";

  return [
    `You are ${meName}, the ${meTitle} agent in a multi-agent coding workflow.`,
    `Teammates: coder is ${coder.display_name || "Coder"} (${coder.role_title || "CoreDev"}), reviewer is ${reviewer.display_name || "Reviewer"} (${reviewer.role_title || "Reviewer"}).`,
    `Nickname rules: call coder as "${coderNick}", reviewer as "${reviewerNick}".`,
    "Create a minimal, practical test plan for the coder output.",
    "Return STRICT JSON only, no markdown fences.",
    "",
    "Required JSON schema:",
    "{",
    '  "test_plan": "string",',
    '  "commands": ["string"],',
    '  "expected_results": ["string"]',
    "}",
    "",
    "Rules:",
    "- Keep commands minimal and deterministic.",
    "- Prefer existing project test commands (npm test / node --test / pnpm test / yarn test).",
    "- If no runnable tests exist, return commands as an empty array and explain in test_plan.",
    "",
    "Task:",
    taskPrompt,
    "",
    "Coder output:",
    coderOutput,
  ].join("\n");
}

function extractJsonObject(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]);
    } catch {}
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  return null;
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function validateTesterSchema(obj) {
  if (!obj || typeof obj !== "object") {
    return { ok: false, error: "tester output must be a JSON object" };
  }
  if (typeof obj.test_plan !== "string" || !obj.test_plan.trim()) {
    return { ok: false, error: "test_plan must be a non-empty string" };
  }
  if (!isStringArray(obj.commands)) {
    return { ok: false, error: "commands must be string[]" };
  }
  if (!isStringArray(obj.expected_results)) {
    return { ok: false, error: "expected_results must be string[]" };
  }
  return { ok: true };
}

async function runTester({
  provider,
  model,
  roleProfile,
  peerProfiles,
  taskPrompt,
  coderOutput,
  timeoutMs,
  eventMeta,
  abortSignal,
}) {
  const prompt = buildTesterPrompt({ taskPrompt, coderOutput, roleProfile, peerProfiles });
  const result = await executeProviderText({
    provider,
    model,
    prompt,
    timeoutMs,
    streamOutput: false,
    eventMeta,
    abortSignal,
  });

  const parsed = extractJsonObject(result.text);
  const schema = validateTesterSchema(parsed);

  if (!schema.ok) {
    return {
      ...result,
      ok: false,
      parse_error: schema.error,
      test_spec: {
        test_plan: "Tester output schema invalid",
        commands: [],
        expected_results: [],
      },
    };
  }

  return {
    ...result,
    ok: true,
    parse_error: null,
    test_spec: parsed,
  };
}

module.exports = {
  runTester,
};
