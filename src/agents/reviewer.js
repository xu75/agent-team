"use strict";

const { executeProviderText } = require("../providers/execute-provider");

function buildReviewerPrompt({ taskPrompt, coderOutput }) {
  return [
    "You are the Reviewer agent in a multi-agent coding workflow.",
    "Review the coder output against the task and return STRICT JSON only.",
    "Do not output markdown fences.",
    "",
    "Required JSON schema:",
    '{',
    '  "decision": "approve" | "changes_requested",',
    '  "must_fix": ["string"],',
    '  "nice_to_have": ["string"],',
    '  "tests": ["string"],',
    '  "security": ["string"]',
    '}',
    "",
    "Rules:",
    "- If any must-fix item exists, decision must be changes_requested.",
    "- If no must-fix item exists, decision must be approve.",
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

function validateReviewSchema(obj) {
  if (!obj || typeof obj !== "object") {
    return { ok: false, error: "review must be a JSON object" };
  }

  const decision = obj.decision;
  const mustFix = obj.must_fix;
  const nice = obj.nice_to_have;
  const tests = obj.tests;
  const security = obj.security;

  if (decision !== "approve" && decision !== "changes_requested") {
    return { ok: false, error: 'decision must be "approve" or "changes_requested"' };
  }
  if (!isStringArray(mustFix)) {
    return { ok: false, error: "must_fix must be string[]" };
  }
  if (!isStringArray(nice)) {
    return { ok: false, error: "nice_to_have must be string[]" };
  }
  if (!isStringArray(tests)) {
    return { ok: false, error: "tests must be string[]" };
  }
  if (!isStringArray(security)) {
    return { ok: false, error: "security must be string[]" };
  }

  if (mustFix.length > 0 && decision !== "changes_requested") {
    return { ok: false, error: "decision must be changes_requested when must_fix is non-empty" };
  }
  if (mustFix.length === 0 && decision !== "approve") {
    return { ok: false, error: "decision must be approve when must_fix is empty" };
  }

  return { ok: true };
}

async function runReviewer({
  provider,
  model,
  taskPrompt,
  coderOutput,
  timeoutMs,
  eventMeta,
}) {
  const prompt = buildReviewerPrompt({ taskPrompt, coderOutput });
  const result = await executeProviderText({
    provider,
    model,
    prompt,
    timeoutMs,
    streamOutput: false,
    eventMeta,
  });

  const parsed = extractJsonObject(result.text);
  const schema = validateReviewSchema(parsed);

  if (!schema.ok) {
    return {
      ...result,
      ok: false,
      parse_error: schema.error,
      review: {
        decision: "changes_requested",
        must_fix: ["Reviewer output schema invalid"],
        nice_to_have: [],
        tests: [],
        security: [],
      },
    };
  }

  return {
    ...result,
    ok: true,
    parse_error: null,
    review: parsed,
  };
}

module.exports = {
  runReviewer,
};
