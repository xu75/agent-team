"use strict";

const { executeProviderText } = require("../providers/execute-provider");

function buildCoderPrompt({ taskPrompt, mustFix = [], roleProfile = {}, peerProfiles = {} }) {
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
  lines.push("Produce a concise implementation answer for the task.");
  lines.push("If reviewer must-fix items exist, fix them first.");
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
  roleProfile,
  peerProfiles,
  taskPrompt,
  mustFix,
  timeoutMs,
  eventMeta,
}) {
  const prompt = buildCoderPrompt({ taskPrompt, mustFix, roleProfile, peerProfiles });
  return executeProviderText({
    provider,
    model,
    prompt,
    timeoutMs,
    streamOutput: true,
    eventMeta,
  });
}

module.exports = {
  runCoder,
};
