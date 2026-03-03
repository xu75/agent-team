#!/usr/bin/env node
"use strict";

/**
 * 预删除校验：仅当 legacy project 元数据已完整存在于 thread 且无遗留会话文件时，才允许清理 logs/projects。
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LOGS_ROOT = path.join(ROOT, "logs");
const PROJECTS_ROOT = path.join(LOGS_ROOT, "projects");
const THREADS_ROOT = path.join(LOGS_ROOT, "threads");

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listFilesRecursive(baseDir) {
  const out = [];
  const walk = (dir, relBase) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relBase ? path.join(relBase, entry.name) : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  walk(baseDir, "");
  return out.sort();
}

function normalizeBool(v) {
  return v === true;
}

function run() {
  if (!fs.existsSync(PROJECTS_ROOT)) {
    process.stdout.write("[verify-project-legacy] logs/projects not found, nothing to verify\n");
    return;
  }

  const entries = fs
    .readdirSync(PROJECTS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const report = {
    checked_at: new Date().toISOString(),
    project_count: entries.length,
    ok: true,
    items: [],
  };

  for (const slug of entries) {
    const item = {
      project_slug: slug,
      ok: true,
      errors: [],
      warnings: [],
    };

    const projectDir = path.join(PROJECTS_ROOT, slug);
    const projectFile = path.join(projectDir, "project.json");
    const threadFile = path.join(THREADS_ROOT, slug, "thread.json");
    const project = readJson(projectFile);
    const thread = readJson(threadFile);

    if (!project) {
      item.ok = false;
      item.errors.push("missing or invalid project.json");
    }
    if (!thread) {
      item.ok = false;
      item.errors.push("missing or invalid corresponding thread.json");
    }

    if (project && thread) {
      const checks = [
        ["project_id", project.project_id, thread.thread_id],
        ["project_name", project.project_name, thread.name],
        ["description", project.description, thread.description],
        ["archived", normalizeBool(project.archived), normalizeBool(thread.archived)],
      ];
      for (const [field, left, right] of checks) {
        if (left !== right) {
          item.ok = false;
          item.errors.push(`field mismatch: ${field} project=${JSON.stringify(left)} thread=${JSON.stringify(right)}`);
        }
      }
      if (!Number.isFinite(Number(thread.created_at))) {
        item.ok = false;
        item.errors.push("thread.created_at missing");
      }
      if (!Number.isFinite(Number(thread.updated_at))) {
        item.ok = false;
        item.errors.push("thread.updated_at missing");
      }
    }

    const files = listFilesRecursive(projectDir);
    const unexpectedFiles = files.filter((rel) => rel !== "project.json");
    if (unexpectedFiles.length > 0) {
      item.ok = false;
      item.errors.push(`unexpected files under logs/projects/${slug}: ${unexpectedFiles.join(", ")}`);
    }

    if (!item.ok) report.ok = false;
    report.items.push(item);
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

run();
