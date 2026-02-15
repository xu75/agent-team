"use strict";

/**
 * Placeholder reviewer agent.
 * Later you'll implement: take code/text -> ask reviewer model -> return critique.
 */
async function reviewText(text) {
  // Minimal stub for now
  return [
    "✅ Reviewer stub: later implement reviewer agent.",
    `Received text length: ${text.length}`,
  ].join("\n");
}

module.exports = { reviewText };
