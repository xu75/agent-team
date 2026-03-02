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
  if (discussionContract.reviewer_notes) lines.push(`- Reviewer notes: ${discussionContract.reviewer_notes}`);
  if (discussionContract.tester_notes) lines.push(`- Tester notes: ${discussionContract.tester_notes}`);
  if (Array.isArray(discussionContract.constraints) && discussionContract.constraints.length) {
    lines.push("- Constraints:");
    discussionContract.constraints.forEach((item, idx) => lines.push(`  ${idx + 1}. ${item}`));
  }
  if (Array.isArray(discussionContract.acceptance_criteria) && discussionContract.acceptance_criteria.length) {
    lines.push("- Acceptance criteria:");
    discussionContract.acceptance_criteria.forEach((item, idx) => lines.push(`  ${idx + 1}. ${item}`));
  }
  return lines;
}

function buildCoderPrompt({
  taskPrompt,
  mustFix = [],
  discussionContract = null,
  roleProfile = {},
  peerProfiles = {},
  mode = "implementation",
}) {
  const meName = roleProfile.display_name || "Coder";
  const meTitle = roleProfile.role_title || "CoreDev";
  const reviewer = peerProfiles.reviewer || {};
  const tester = peerProfiles.tester || {};
  const reviewerNick = reviewer.nickname || reviewer.display_name || "Reviewer";
  const testerNick = tester.nickname || tester.display_name || "Tester";

  const lines = [];
  lines.push(`You are ${meName}, the ${meTitle} agent in a multi-agent coding workflow.`);
  lines.push(
    `Teammates: reviewer is ${reviewer.display_name || "Reviewer"} (${reviewer.role_title || "Reviewer"}), tester is ${tester.display_name || "Tester"} (${tester.role_title || "Tester"}).`
  );
  lines.push(
    `Nickname rules: call reviewer as "${reviewerNick}", tester as "${testerNick}".`
  );
  if (mode === "proposal") {
    lines.push("IMPORTANT: This is PROPOSAL PHASE ONLY. You MUST NOT modify any files or write any code.");
    lines.push("Produce a concise implementation proposal only.");
    lines.push("Do not claim files are edited. Do not use any file-editing tools. This step is planning before operator confirmation.");
    lines.push("Include: approach, touched files (planned), key risks, and rollout notes.");
    lines.push("Wait for operator to send /confirm before making any actual changes.");
  } else {
    lines.push("IMPORTANT: This is IMPLEMENTATION PHASE.");
    lines.push("Apply concrete file edits in the workspace for requested fixes.");
    lines.push("Do not only provide confirmation text, planning text, or analysis when code changes are required.");
    lines.push("Run minimal validation commands when possible and report key results.");
    lines.push("Produce a concise implementation answer with changed files and key commands.");
    lines.push("If reviewer must-fix items exist, fix them first.");
  }
  const contractLines = renderDiscussionContractLines(discussionContract);
  if (contractLines.length) {
    lines.push("");
    lines.push(...contractLines);
  }
  lines.push("");
  lines.push("Task:");
  lines.push(taskPrompt);
  lines.push("");
  if (mustFix.length) {
    lines.push("Reviewer must-fix items:");
    mustFix.forEach((item, idx) => {
      lines.push(`${idx + 1}. ${item}`);
    });
    lines.push("");
  }
  lines.push("Return plain text only.");
  return lines.join("\n");
}

async function runCoder({
  provider,
  model,
  settingsFile,
  roleProfile,
  peerProfiles,
  taskPrompt,
  mustFix,
  discussionContract,
  mode,
  timeoutMs,
  eventMeta,
  abortSignal,
  onLiveEvent,
}) {
  const prompt = buildCoderPrompt({
    taskPrompt,
    mustFix,
    discussionContract,
    roleProfile,
    peerProfiles,
    mode,
  });
  return executeProviderText({
    provider,
    model,
    settingsFile,
    prompt,
    timeoutMs,
    streamOutput: true,
    eventMeta,
    abortSignal,
    onLiveEvent,
    // In proposal mode, use plan permission to prevent file edits
    permissionMode: mode === "proposal" ? "plan" : undefined,
  });
}

module.exports = {
  runCoder,
};
