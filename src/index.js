"use strict";

const { runOnce } = require("./coordinator");

const prompt = process.argv.slice(2).join(" ").trim() || "用一句话介绍你自己";
runOnce(prompt)
  .then(({ review }) => {
    console.error("\n--- reviewer ---\n" + review);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err.stack || err.message || String(err));
    process.exit(1);
  });
