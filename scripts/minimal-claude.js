#!/usr/bin/env node
"use strict";

const { runClaude } = require("../src/engine/claude");

const prompt = process.argv.slice(2).join(" ").trim();
if (!prompt) {
  console.error('Usage: node scripts/minimal-claude.js "你的问题"');
  process.exit(2);
}

runClaude(prompt, { output: "inherit" })
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message || String(err));
    process.exit(1);
  });
