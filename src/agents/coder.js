"use strict";

const { executeProviderText } = require("../providers/execute-provider");

function buildCoderPrompt({ taskPrompt, mustFix = [] }) {
  const lines = [];
  lines.push("You are the CoreDev agent in a multi-agent coding workflow.");
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
  taskPrompt,
  mustFix,
  timeoutMs,
  eventMeta,
}) {
  const prompt = buildCoderPrompt({ taskPrompt, mustFix });
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
