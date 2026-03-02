#!/usr/bin/env node
"use strict";

/**
 * migrate-threads.js — 一次性迁移脚本
 *
 * 将历史数据归属到 Thread 结构中：
 * 1. 确保默认 Thread（cat-cafe）存在
 * 2. 将旧的 chat sessions (logs/threads/{timestamp}/) 移动到 logs/threads/cat-cafe/sessions/
 * 3. 将旧的 task dirs (logs/{date}/task-{id}/) 复制到 logs/threads/cat-cafe/sessions/
 * 4. 输出迁移报告到 logs/_migration_report.json
 *
 * 用法:
 *   node scripts/migrate-threads.js              # 执行迁移
 *   node scripts/migrate-threads.js --dry-run    # 仅预览，不实际移动
 *
 * 特性:
 *   - 幂等：重复执行不会重复迁移已处理的数据
 *   - --dry-run 模式：仅打印将要执行的操作
 *   - 输出失败样本路径
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const LOGS_ROOT = path.join(ROOT, "logs");
const DEFAULT_THREAD = "cat-cafe";
const DEFAULT_THREAD_NAME = "Cat Cafe";

const isDryRun = process.argv.includes("--dry-run");

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg) {
  process.stdout.write(`${isDryRun ? "[DRY-RUN] " : ""}${msg}\n`);
}

// Step 1: Ensure default thread exists
function ensureDefaultThread() {
  const threadDir = path.join(LOGS_ROOT, "threads", DEFAULT_THREAD);
  const threadFile = path.join(threadDir, "thread.json");
  const sessionsDir = path.join(threadDir, "sessions");

  if (fs.existsSync(threadFile)) {
    log(`默认 Thread "${DEFAULT_THREAD}" 已存在`);
    return;
  }

  if (isDryRun) {
    log(`将创建默认 Thread: ${threadDir}`);
    return;
  }

  ensureDir(threadDir);
  ensureDir(sessionsDir);

  const meta = {
    thread_id: DEFAULT_THREAD,
    name: DEFAULT_THREAD_NAME,
    description: "默认项目 Thread（迁移自历史数据）",
    created_at: Date.now(),
    updated_at: Date.now(),
    archived: false,
  };
  fs.writeFileSync(threadFile, JSON.stringify(meta, null, 2), "utf8");
  log(`已创建默认 Thread: ${threadDir}`);
}

// Step 2: Migrate legacy chat sessions
function migrateLegacyChatSessions() {
  const threadsDir = path.join(LOGS_ROOT, "threads");
  if (!fs.existsSync(threadsDir)) return { migrated: 0, skipped: 0, failed: [] };

  const entries = fs.readdirSync(threadsDir, { withFileTypes: true });
  let migrated = 0;
  let skipped = 0;
  const failed = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip thread containers (have thread.json) and internal dirs
    if (entry.name.startsWith("_")) continue;
    if (fs.existsSync(path.join(threadsDir, entry.name, "thread.json"))) continue;

    // This is a legacy chat session (has meta.json)
    const metaFile = path.join(threadsDir, entry.name, "meta.json");
    if (!fs.existsSync(metaFile)) continue;

    const destDir = path.join(threadsDir, DEFAULT_THREAD, "sessions", entry.name);
    if (fs.existsSync(destDir)) {
      skipped++;
      continue;
    }

    if (isDryRun) {
      log(`将移动: ${entry.name} → ${DEFAULT_THREAD}/sessions/${entry.name}`);
      migrated++;
      continue;
    }

    try {
      // Update meta to include parent_thread before moving
      const meta = safeReadJson(metaFile);
      if (meta && !meta.parent_thread) {
        meta.parent_thread = DEFAULT_THREAD;
        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + "\n", "utf8");
      }

      const srcDir = path.join(threadsDir, entry.name);
      ensureDir(path.join(threadsDir, DEFAULT_THREAD, "sessions"));
      fs.renameSync(srcDir, destDir);
      migrated++;
      log(`已移动: ${entry.name} → ${DEFAULT_THREAD}/sessions/${entry.name}`);
    } catch (err) {
      failed.push({ id: entry.name, error: err.message });
      log(`失败: ${entry.name} — ${err.message}`);
    }
  }

  return { migrated, skipped, failed };
}

// Step 3: Copy task sessions to thread
function migrateTaskSessions() {
  const dates = [];
  if (fs.existsSync(LOGS_ROOT)) {
    for (const entry of fs.readdirSync(LOGS_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
        dates.push(entry.name);
      }
    }
  }

  let migrated = 0;
  let skipped = 0;
  const failed = [];

  for (const date of dates.sort()) {
    const dateDir = path.join(LOGS_ROOT, date);
    const entries = fs.readdirSync(dateDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!entry.name.startsWith("task-") && !entry.name.startsWith("run-")) continue;

      const taskId = entry.name.startsWith("task-") ? entry.name.slice(5) : entry.name.slice(4);
      const srcDir = path.join(dateDir, entry.name);
      const summaryFile = path.join(srcDir, "summary.json");
      if (!fs.existsSync(summaryFile)) continue;

      const destSessionDir = path.join(LOGS_ROOT, "threads", DEFAULT_THREAD, "sessions", entry.name);
      if (fs.existsSync(destSessionDir)) {
        skipped++;
        continue;
      }

      if (isDryRun) {
        log(`将复制: ${date}/${entry.name} → ${DEFAULT_THREAD}/sessions/${entry.name}`);
        migrated++;
        continue;
      }

      try {
        // Update summary to include thread_id
        const summary = safeReadJson(summaryFile);
        if (summary && !summary.thread_id) {
          summary.thread_id = DEFAULT_THREAD;
          fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf8");
        }

        // Copy task session into thread container (避免符号链接枚举差异)
        ensureDir(path.join(LOGS_ROOT, "threads", DEFAULT_THREAD, "sessions"));
        fs.cpSync(srcDir, destSessionDir, { recursive: true, force: false, errorOnExist: true });
        migrated++;
        log(`已复制: ${date}/${entry.name} → ${DEFAULT_THREAD}/sessions/${entry.name}`);
      } catch (err) {
        failed.push({ id: `${date}/${entry.name}`, error: err.message });
        log(`失败: ${date}/${entry.name} — ${err.message}`);
      }
    }
  }

  return { migrated, skipped, failed };
}

// Step 4: Migrate old project data
function migrateOldProjects() {
  const projectsDir = path.join(LOGS_ROOT, "projects");
  if (!fs.existsSync(projectsDir)) return { migrated: 0, skipped: 0 };

  let migrated = 0;
  let skipped = 0;

  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectFile = path.join(projectsDir, entry.name, "project.json");
    if (!fs.existsSync(projectFile)) continue;

    // Check if corresponding thread already exists
    const threadFile = path.join(LOGS_ROOT, "threads", entry.name, "thread.json");
    if (fs.existsSync(threadFile)) {
      skipped++;
      continue;
    }

    const project = safeReadJson(projectFile);
    if (!project) continue;

    if (isDryRun) {
      log(`将迁移项目: ${entry.name} → Thread ${entry.name}`);
      migrated++;
      continue;
    }

    // Create thread from project
    const threadDir = path.join(LOGS_ROOT, "threads", entry.name);
    ensureDir(threadDir);
    ensureDir(path.join(threadDir, "sessions"));

    const thread = {
      thread_id: project.project_id || entry.name,
      name: project.project_name || entry.name,
      description: project.description || "",
      created_at: project.created_at || Date.now(),
      updated_at: project.updated_at || Date.now(),
      archived: !!project.archived,
    };
    fs.writeFileSync(threadFile, JSON.stringify(thread, null, 2), "utf8");
    migrated++;
    log(`已迁移项目: ${entry.name} → Thread ${entry.name}`);
  }

  return { migrated, skipped };
}

// Run migration
function main() {
  log("=== Thread 迁移脚本 ===");
  log(`日志目录: ${LOGS_ROOT}`);
  log(`默认 Thread: ${DEFAULT_THREAD}`);
  log("");

  ensureDefaultThread();

  log("\n--- 迁移旧项目 ---");
  const projectResult = migrateOldProjects();
  log(`项目: 迁移 ${projectResult.migrated}, 跳过 ${projectResult.skipped}`);

  log("\n--- 迁移聊天会话 ---");
  const chatResult = migrateLegacyChatSessions();
  log(`聊天会话: 迁移 ${chatResult.migrated}, 跳过 ${chatResult.skipped}, 失败 ${chatResult.failed.length}`);

  log("\n--- 复制任务数据 ---");
  const taskResult = migrateTaskSessions();
  log(`任务: 复制 ${taskResult.migrated}, 跳过 ${taskResult.skipped}, 失败 ${taskResult.failed.length}`);

  // Write migration report
  const report = {
    migrated_at: new Date().toISOString(),
    dry_run: isDryRun,
    default_thread: DEFAULT_THREAD,
    projects: projectResult,
    chat_sessions: chatResult,
    task_sessions: taskResult,
    total_migrated: projectResult.migrated + chatResult.migrated + taskResult.migrated,
    total_skipped: projectResult.skipped + chatResult.skipped + taskResult.skipped,
    total_failed: chatResult.failed.length + taskResult.failed.length,
    failed_samples: [...chatResult.failed, ...taskResult.failed].slice(0, 20),
  };
  report.total = report.total_migrated + report.total_skipped + report.total_failed;
  report.success = report.total_migrated;
  report.skipped = report.total_skipped;
  report.failed = report.total_failed;

  if (!isDryRun) {
    const reportFile = path.join(LOGS_ROOT, "_migration_report.json");
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), "utf8");
    log(`\n迁移报告已保存: ${reportFile}`);
  }

  log("\n=== 迁移完成 ===");
  log(`总计: 迁移 ${report.total_migrated}, 跳过 ${report.total_skipped}, 失败 ${report.total_failed}`);

  if (report.total_failed > 0) {
    log("\n失败样本:");
    for (const f of report.failed_samples) {
      log(`  ${f.id}: ${f.error}`);
    }
  }
}

main();
