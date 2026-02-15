"use strict";

const { runClaude } = require("./engine/claude");
const { reviewText } = require("./agents/reviewer");

/**
 * Minimal coordinator example:
 * 1) Ask Claude something
 * 2) Run reviewer on the returned text
 */
async function runOnce(prompt) {
  const answer = await runClaude(prompt, { output: "inherit" });
  const review = await reviewText(answer);
  return { answer, review };
}

module.exports = { runOnce };
