"use strict";

const { executeProviderText } = require("../providers/execute-provider");

function buildCoderPrompt({
  taskPrompt,
  mustFix = [],
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
    lines.push("Produce a concise implementation proposal only.");
    lines.push("Do not claim files are edited. This step is planning before operator confirmation.");
    lines.push("Include: approach, touched files (planned), key risks, and rollout notes.");
  } else {
    lines.push("Produce a concise implementation answer for the task.");
    lines.push("If reviewer must-fix items exist, fix them first.");
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
  mode,
  timeoutMs,
  eventMeta,
  abortSignal,
}) {
  const prompt = buildCoderPrompt({ taskPrompt, mustFix, roleProfile, peerProfiles, mode });
  return executeProviderText({
    provider,
    model,
    settingsFile,
    prompt,
    timeoutMs,
    streamOutput: true,
    eventMeta,
    abortSignal,
  });
}

module.exports = {
  runCoder,
};
