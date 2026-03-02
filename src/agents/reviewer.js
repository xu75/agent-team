"use strict";

const { executeProviderText } = require("../providers/execute-provider");

function renderDiscussionContractLines(discussionContract) {
  if (!discussionContract || typeof discussionContract !== "object") return [];
  const lines = [];
  lines.push("Confirmed roundtable contract (inherit this context):");
  if (discussionContract.source_round !== null && discussionContract.source_round !== undefined) {
    lines.push(`- Source round: ${discussionContract.source_round}`);
  }
  if (discussionContract.hash) lines.push(`- Contract hash: ${discussionContract.hash}`);
  if (discussionContract.goal) lines.push(`- Goal: ${discussionContract.goal}`);
  if (discussionContract.core_plan) lines.push(`- Core plan: ${discussionContract.core_plan}`);
  if (Array.isArray(discussionContract.must_fix) && discussionContract.must_fix.length) {
    lines.push("- Existing must-fix baseline:");
    discussionContract.must_fix.forEach((item, idx) => lines.push(`  ${idx + 1}. ${item}`));
  }
  if (Array.isArray(discussionContract.acceptance_criteria) && discussionContract.acceptance_criteria.length) {
    lines.push("- Acceptance criteria:");
    discussionContract.acceptance_criteria.forEach((item, idx) => lines.push(`  ${idx + 1}. ${item}`));
  }
  return lines;
}

function buildReviewerPrompt({
  taskPrompt,
  coderOutput,
  discussionContract = null,
  roleProfile = {},
  peerProfiles = {},
}) {
  const meName = roleProfile.display_name || "Reviewer";
  const meTitle = roleProfile.role_title || "Reviewer";
  const coder = peerProfiles.coder || {};
  const tester = peerProfiles.tester || {};
  const coderNick = coder.nickname || coder.display_name || "Coder";
  const testerNick = tester.nickname || tester.display_name || "Tester";

  const lines = [
    `You are ${meName}, the ${meTitle} agent in a multi-agent coding workflow.`,
    `Teammates: coder is ${coder.display_name || "Coder"} (${coder.role_title || "CoreDev"}), tester is ${tester.display_name || "Tester"} (${tester.role_title || "Tester"}).`,
    `Nickname rules: call coder as "${coderNick}", tester as "${testerNick}".`,
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
  ];
  const contractLines = renderDiscussionContractLines(discussionContract);
  if (contractLines.length) {
    lines.push(...contractLines, "");
  }
  lines.push(
    "Task:",
    taskPrompt,
    "",
    "Coder output:",
    coderOutput
  );
  return lines.join("\n");
}

function buildReviewerDiscussionPrompt({
  taskPrompt,
  coderOutput,
  discussionContract = null,
  roleProfile = {},
  peerProfiles = {},
}) {
  const meName = roleProfile.display_name || "Reviewer";
  const meTitle = roleProfile.role_title || "Reviewer";
  const coder = peerProfiles.coder || {};
  const tester = peerProfiles.tester || {};
  const coderNick = coder.nickname || coder.display_name || "Coder";
  const testerNick = tester.nickname || tester.display_name || "Tester";

  const lines = [
    `You are ${meName}, the ${meTitle} agent in a multi-agent coding roundtable.`,
    `Teammates: coder is ${coder.display_name || "Coder"} (${coder.role_title || "CoreDev"}), tester is ${tester.display_name || "Tester"} (${tester.role_title || "Tester"}).`,
    `Nickname rules: call coder as "${coderNick}", tester as "${testerNick}".`,
    "This is an open discussion stage before implementation is confirmed by operator.",
    "Return concise plain text only (no JSON required).",
    "",
    "Focus:",
    "- Critique the plan feasibility and tradeoffs.",
    "- Point out top risks and assumptions.",
    "- Suggest concrete refinements and acceptance criteria.",
    "",
  ];
  const contractLines = renderDiscussionContractLines(discussionContract);
  if (contractLines.length) {
    lines.push(...contractLines, "");
  }
  lines.push(
    "Task:",
    taskPrompt,
    "",
    "Coder proposal / latest implementation notes:",
    coderOutput
  );
  return lines.join("\n");
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {}
  return null;
}

function repairUnescapedQuotes(candidate) {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < candidate.length; i += 1) {
    const ch = candidate[i];
    if (!inString) {
      if (ch === "\"") inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === "\"") {
      let j = i + 1;
      while (j < candidate.length && /\s/.test(candidate[j])) j += 1;
      const next = candidate[j] || "";
      const closesString = next === ":" || next === "," || next === "}" || next === "]";
      if (closesString) {
        inString = false;
        out += ch;
      } else {
        out += "\\\"";
      }
      continue;
    }
    out += ch;
  }

  return out;
}

function tryParseWithRepair(candidate) {
  const parsed = tryParseJson(candidate);
  if (parsed) return parsed;
  const repaired = repairUnescapedQuotes(candidate);
  if (repaired !== candidate) return tryParseJson(repaired);
  return null;
}

function extractJsonObject(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const direct = tryParseWithRepair(trimmed);
  if (direct) return direct;

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    const fenced = tryParseWithRepair(fenceMatch[1]);
    if (fenced) return fenced;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    const extracted = tryParseWithRepair(candidate);
    if (extracted) return extracted;
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
  settingsFile,
  roleProfile,
  peerProfiles,
  taskPrompt,
  coderOutput,
  discussionContract,
  mode = "strict_json",
  timeoutMs,
  eventMeta,
  abortSignal,
  onLiveEvent,
}) {
  const prompt =
    mode === "discussion"
      ? buildReviewerDiscussionPrompt({
        taskPrompt,
        coderOutput,
        discussionContract,
        roleProfile,
        peerProfiles,
      })
      : buildReviewerPrompt({
        taskPrompt,
        coderOutput,
        discussionContract,
        roleProfile,
        peerProfiles,
      });
  const result = await executeProviderText({
    provider,
    model,
    settingsFile,
    prompt,
    timeoutMs,
    streamOutput: true,
    eventMeta,
    abortSignal,
    onLiveEvent,
  });

  if (mode === "discussion") {
    const exitCode = Number(result?.exit?.code);
    return {
      ...result,
      ok: !Number.isFinite(exitCode) || exitCode === 0,
      parse_error: null,
      review: {
        decision: "approve",
        must_fix: [],
        nice_to_have: [],
        tests: [],
        security: [],
      },
    };
  }

  if (result.error_class) {
    return {
      ...result,
      ok: false,
      parse_error: `provider_error:${result.error_class}`,
      review: {
        decision: "changes_requested",
        must_fix: [`Reviewer provider error: ${result.error_class}`],
        nice_to_have: [],
        tests: [],
        security: [],
      },
    };
  }

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
