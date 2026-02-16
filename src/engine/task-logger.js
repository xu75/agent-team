"use strict";

const fs = require("node:fs");
const path = require("node:path");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function datePart(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function makeTaskId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function createTaskLogDir(root = "logs", taskId = makeTaskId()) {
  const dir = path.join(root, datePart(), `task-${taskId}`);
  ensureDir(path.join(dir, "rounds"));
  return { taskId, dir };
}

function roundDir(taskDir, round) {
  const name = String(round).padStart(2, "0");
  const dir = path.join(taskDir, "rounds", name);
  ensureDir(dir);
  return dir;
}

function writeText(filePath, text) {
  fs.writeFileSync(filePath, text, "utf8");
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

module.exports = {
  createTaskLogDir,
  roundDir,
  writeText,
  writeJson,
};
