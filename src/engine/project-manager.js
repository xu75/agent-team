"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Thread Manager — 管理 Thread → Session 分层结构
 *
 * 对外术语：Thread = 项目容器, Session = Thread 内的对话/任务
 * 内部模块名保留 project-manager.js
 *
 * 存储结构:
 *   logs/threads/{slug}/thread.json          — Thread 元数据
 *   logs/threads/{slug}/sessions/            — Session 目录
 *   logs/threads/{slug}/sessions/{id}/       — 单个 Session（chat 或 task）
 *   logs/threads/_index.json                 — Thread→Sessions 索引缓存
 */

/* ---------- helpers ---------- */

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

/* ---------- path helpers ---------- */

function threadsRoot(logsRoot) {
  return path.join(logsRoot, "threads");
}

function threadDirPath(logsRoot, slug) {
  return path.join(threadsRoot(logsRoot), slug);
}

function threadFilePath(logsRoot, slug) {
  return path.join(threadDirPath(logsRoot, slug), "thread.json");
}

function indexFilePath(logsRoot) {
  return path.join(threadsRoot(logsRoot), "_index.json");
}

function indexLockPath(logsRoot) {
  return path.join(threadsRoot(logsRoot), "._index.lock");
}

function deletionAuditFilePath(logsRoot) {
  return path.join(threadsRoot(logsRoot), "_deletion_audit.jsonl");
}

function sessionsDirPath(logsRoot, slug) {
  return path.join(threadDirPath(logsRoot, slug), "sessions");
}

function sessionDirPath(logsRoot, slug, sessionId) {
  return path.join(sessionsDirPath(logsRoot, slug), sessionId);
}

function isSessionDirEntry(baseDir, entry) {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return fs.statSync(path.join(baseDir, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/* ---------- slug normalization ---------- */

function normalizeSlug(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\u4e00-\u9fff\-_]/g, "")
    || "default";
}

/* ---------- Index management ---------- */

function readIndex(logsRoot) {
  return safeReadJson(indexFilePath(logsRoot)) || { threads: {}, rebuilt_at: null };
}

function writeIndex(logsRoot, index) {
  ensureDir(threadsRoot(logsRoot));
  const target = indexFilePath(logsRoot);
  const tmp = target + ".tmp." + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2), "utf8");
  fs.renameSync(tmp, target);
}

function acquireLock(lockFile) {
  ensureDir(path.dirname(lockFile));
  try {
    const fd = fs.openSync(lockFile, "wx");
    fs.writeFileSync(fd, String(process.pid), "utf8");
    return fd;
  } catch (err) {
    if (err && err.code === "EEXIST") return null;
    throw err;
  }
}

function releaseLock(lockFile, fd) {
  try {
    if (Number.isInteger(fd)) fs.closeSync(fd);
  } catch {}
  try {
    fs.rmSync(lockFile, { force: true });
  } catch {}
}

function sleepMs(ms) {
  const waitMs = Math.max(1, Number(ms) || 0);
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    // busy wait for short lock retries
  }
}

function withIndexLock(logsRoot, fn, opts = {}) {
  const lockFile = indexLockPath(logsRoot);
  const timeoutMs = Math.max(1, Number(opts.timeout_ms) || 2000);
  const retryMs = Math.max(1, Number(opts.retry_ms) || 10);
  const staleMs = Math.max(1000, Number(opts.stale_ms) || 30000);
  const start = Date.now();

  while (true) {
    const lockFd = acquireLock(lockFile);
    if (lockFd !== null) {
      try {
        return fn();
      } finally {
        releaseLock(lockFile, lockFd);
      }
    }

    // Best-effort stale lock cleanup
    try {
      const stat = fs.statSync(lockFile);
      if (Date.now() - stat.mtimeMs > staleMs) {
        fs.rmSync(lockFile, { force: true });
      }
    } catch {}

    if (Date.now() - start >= timeoutMs) {
      const err = new Error(`index lock timeout: ${lockFile}`);
      err.code = "INDEX_LOCK_TIMEOUT";
      throw err;
    }
    sleepMs(retryMs);
  }
}

function updateIndexEntry(logsRoot, slug, patch) {
  withIndexLock(logsRoot, () => {
    const index = readIndex(logsRoot);
    if (!index.threads[slug]) {
      index.threads[slug] = {};
    }
    Object.assign(index.threads[slug], patch);
    writeIndex(logsRoot, index);
  });
}

function removeIndexEntry(logsRoot, slug) {
  withIndexLock(logsRoot, () => {
    const index = readIndex(logsRoot);
    delete index.threads[slug];
    writeIndex(logsRoot, index);
  });
}

/**
 * 完全重建索引。删除 _index.json 后重启时自动调用。
 */
function rebuildIndex(logsRoot) {
  const root = threadsRoot(logsRoot);
  return withIndexLock(logsRoot, () => {
    if (!fs.existsSync(root)) return { threads: {}, rebuilt_at: Date.now() };

    const index = { threads: {}, rebuilt_at: Date.now() };
    const entries = fs.readdirSync(root, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("_")) continue;

      const tf = path.join(root, entry.name, "thread.json");
      const meta = safeReadJson(tf);
      if (!meta) continue;

      const sessionCount = countSessions(logsRoot, entry.name);
      index.threads[entry.name] = {
        name: meta.name || entry.name,
        session_count: sessionCount,
        updated_at: meta.updated_at || meta.created_at || 0,
        archived: !!meta.archived,
      };
    }

    writeIndex(logsRoot, index);
    return index;
  });
}

/**
 * 启动时校验索引一致性。
 * 如果 _index.json 缺失或与磁盘不一致则自动重建。
 * 返回 { repaired: boolean, index }
 */
function validateAndRepairIndex(logsRoot) {
  const root = threadsRoot(logsRoot);
  if (!fs.existsSync(root)) return { repaired: false, index: { threads: {}, rebuilt_at: null } };

  const existing = safeReadJson(indexFilePath(logsRoot));
  if (!existing || !existing.threads) {
    const rebuilt = rebuildIndex(logsRoot);
    return { repaired: true, index: rebuilt };
  }

  // Scan disk for actual thread dirs
  const diskSlugs = new Set();
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
      if (fs.existsSync(path.join(root, entry.name, "thread.json"))) {
        diskSlugs.add(entry.name);
      }
    }
  } catch { /* ignore */ }

  const indexSlugs = new Set(Object.keys(existing.threads || {}));

  // Check for mismatches: missing in index or extra in index
  let mismatch = false;
  for (const slug of diskSlugs) {
    if (!indexSlugs.has(slug)) { mismatch = true; break; }
  }
  if (!mismatch) {
    for (const slug of indexSlugs) {
      if (!diskSlugs.has(slug)) { mismatch = true; break; }
    }
  }

  if (mismatch) {
    const rebuilt = rebuildIndex(logsRoot);
    return { repaired: true, index: rebuilt };
  }

  return { repaired: false, index: existing };
}

/* ---------- Thread CRUD ---------- */

function createThread(logsRoot, { slug, name, description }) {
  const id = normalizeSlug(slug);
  const file = threadFilePath(logsRoot, id);
  const dir = threadDirPath(logsRoot, id);
  ensureDir(threadsRoot(logsRoot));
  try {
    fs.mkdirSync(dir, { recursive: false });
  } catch (err) {
    if (err && err.code === "EEXIST") {
      return { ok: false, code: "THREAD_EXISTS", error: `Thread "${id}" 已存在` };
    }
    throw err;
  }
  ensureDir(sessionsDirPath(logsRoot, id));

  const now = Date.now();
  const meta = {
    thread_id: id,
    name: String(name || id).trim(),
    description: String(description || "").trim(),
    created_at: now,
    updated_at: now,
    archived: false,
  };

  try {
    fs.writeFileSync(file, JSON.stringify(meta, null, 2), "utf8");
  } catch (err) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    throw err;
  }

  updateIndexEntry(logsRoot, id, {
    name: meta.name,
    session_count: 0,
    updated_at: now,
    archived: false,
  });

  return { ok: true, thread: meta };
}

function readThread(logsRoot, slug) {
  return safeReadJson(threadFilePath(logsRoot, slug));
}

function updateThread(logsRoot, slug, patch) {
  const meta = readThread(logsRoot, slug);
  if (!meta) return { ok: false, error: `Thread "${slug}" 不存在` };

  const allowed = ["name", "description", "archived"];
  for (const key of allowed) {
    if (patch[key] !== undefined) meta[key] = patch[key];
  }
  meta.updated_at = Date.now();

  fs.writeFileSync(threadFilePath(logsRoot, slug), JSON.stringify(meta, null, 2), "utf8");

  updateIndexEntry(logsRoot, slug, {
    name: meta.name,
    updated_at: meta.updated_at,
    archived: !!meta.archived,
  });

  return { ok: true, thread: meta };
}

/**
 * 更新 Thread 的 updated_at 时间戳。Session 变更时调用。
 */
function touchThread(logsRoot, slug) {
  const meta = readThread(logsRoot, slug);
  if (!meta) return;
  meta.updated_at = Date.now();
  fs.writeFileSync(threadFilePath(logsRoot, slug), JSON.stringify(meta, null, 2), "utf8");
  updateIndexEntry(logsRoot, slug, { updated_at: meta.updated_at });
}

function readAuditInput(audit) {
  const operator = String(audit?.operator || "").trim();
  const reason = String(audit?.reason || "").trim();
  return { operator, reason };
}

function appendDeletionAudit(logsRoot, payload) {
  ensureDir(threadsRoot(logsRoot));
  fs.appendFileSync(
    deletionAuditFilePath(logsRoot),
    JSON.stringify(payload) + "\n",
    "utf8"
  );
}

function archiveThread(logsRoot, slug, audit = {}) {
  const meta = readThread(logsRoot, slug);
  if (!meta) return { ok: false, code: "THREAD_NOT_FOUND", error: `Thread "${slug}" 不存在` };
  const { operator, reason } = readAuditInput(audit);
  if (!operator || !reason) {
    return {
      ok: false,
      code: "MISSING_AUDIT",
      error: "archive 需要 operator 与 reason",
    };
  }
  const now = Date.now();
  meta.archived = true;
  meta.archived_at = now;
  meta.operator = operator;
  meta.reason = reason;
  meta.archived_by = operator;
  meta.archive_reason = reason;
  meta.updated_at = now;
  fs.writeFileSync(threadFilePath(logsRoot, slug), JSON.stringify(meta, null, 2), "utf8");
  updateIndexEntry(logsRoot, slug, {
    name: meta.name,
    updated_at: meta.updated_at,
    archived: true,
  });
  return { ok: true, thread: meta };
}

/**
 * 两段式删除：必须先归档再删除。
 */
function deleteThread(logsRoot, slug, audit = {}) {
  const meta = readThread(logsRoot, slug);
  if (!meta) return { ok: false, code: "THREAD_NOT_FOUND", error: `Thread "${slug}" 不存在` };
  if (!meta.archived) {
    return { ok: false, code: "THREAD_NOT_ARCHIVED", error: `Thread "${slug}" 必须先归档才能删除` };
  }
  const { operator, reason } = readAuditInput(audit);
  if (!operator || !reason) {
    return {
      ok: false,
      code: "MISSING_AUDIT",
      error: "hard delete 需要 operator 与 reason",
    };
  }
  const archivedAt = Number(meta.archived_at || 0);
  if (!Number.isFinite(archivedAt) || archivedAt <= 0) {
    return {
      ok: false,
      code: "MISSING_AUDIT",
      error: "hard delete 需要 archived_at；请先通过归档接口写入审计字段",
    };
  }
  const archivedOperator = String(meta.operator || meta.archived_by || "").trim();
  const archivedReason = String(meta.reason || meta.archive_reason || "").trim();
  if (!archivedOperator || !archivedReason) {
    return {
      ok: false,
      code: "MISSING_AUDIT",
      error: "hard delete 需要归档阶段的 operator 与 reason 审计字段",
    };
  }

  const deletedAt = Date.now();
  appendDeletionAudit(logsRoot, {
    thread_id: slug,
    name: meta.name || slug,
    archived_at: archivedAt,
    archived_operator: archivedOperator,
    archived_reason: archivedReason,
    deleted_at: deletedAt,
    operator,
    reason,
  });

  const dir = threadDirPath(logsRoot, slug);
  fs.rmSync(dir, { recursive: true, force: true });

  removeIndexEntry(logsRoot, slug);

  return { ok: true };
}

function listThreads(logsRoot) {
  const root = threadsRoot(logsRoot);
  if (!fs.existsSync(root)) return [];

  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => {
      const meta = safeReadJson(path.join(root, d.name, "thread.json"));
      if (!meta) return null;
      const sessionCount = countSessions(logsRoot, d.name);
      return { ...meta, session_count: sessionCount };
    })
    .filter(Boolean)
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

/* ---------- Session helpers ---------- */

/**
 * 计算 Thread 下的 Session 数量。
 */
function countSessions(logsRoot, slug) {
  const dir = sessionsDirPath(logsRoot, slug);
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => isSessionDirEntry(dir, d))
      .length;
  } catch {
    return 0;
  }
}

/**
 * 列出 Thread 下所有 Session ID。
 */
function listSessionIds(logsRoot, slug) {
  const dir = sessionsDirPath(logsRoot, slug);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => isSessionDirEntry(dir, d))
    .map((d) => d.name);
}

/**
 * 列出 Thread 下所有 Session 元数据。
 * 支持 chat（meta.json）和 task（summary.json）两种类型。
 */
function listSessions(logsRoot, slug) {
  const ids = listSessionIds(logsRoot, slug);
  const sessions = [];

  for (const id of ids) {
    const dir = sessionDirPath(logsRoot, slug, id);
    // Chat session: has meta.json
    const chatMeta = safeReadJson(path.join(dir, "meta.json"));
    if (chatMeta) {
      sessions.push({
        session_id: chatMeta.thread_id || id,
        thread_id: slug,
        type: "chat",
        title: chatMeta.title || "聊天对话",
        mode: chatMeta.mode || "free_chat",
        created_at: chatMeta.created_at || 0,
        updated_at: chatMeta.updated_at || chatMeta.created_at || 0,
        archived: !!chatMeta.archived,
      });
      continue;
    }

    // Task session: has summary.json
    const taskSummary = safeReadJson(path.join(dir, "summary.json"));
    if (taskSummary) {
      const taskMd = path.join(dir, "task.md");
      let title = "";
      if (fs.existsSync(taskMd)) {
        const firstLine = fs.readFileSync(taskMd, "utf8").split("\n").find((l) => l.trim());
        title = firstLine ? firstLine.trim().slice(0, 64) : "";
      }
      sessions.push({
        session_id: taskSummary.task_id || id,
        thread_id: slug,
        type: "task",
        title: title || "任务",
        final_outcome: taskSummary.final_outcome || null,
        final_status: taskSummary.final_status || null,
        rounds: Array.isArray(taskSummary.rounds) ? taskSummary.rounds.length : 0,
        created_at: taskSummary.state_events?.[0]?.ts || 0,
        updated_at: taskSummary.state_events?.[taskSummary.state_events.length - 1]?.ts || 0,
        archived: false,
      });
      continue;
    }
  }

  return sessions.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
}

/* ---------- Default Thread ---------- */

/**
 * 确保默认 Thread 存在。启动时调用一次。
 */
function ensureDefaultThread(logsRoot, defaultSlug, defaultName) {
  const slug = normalizeSlug(defaultSlug);
  const existing = readThread(logsRoot, slug);
  if (existing) return existing;
  const result = createThread(logsRoot, {
    slug,
    name: defaultName,
    description: "默认项目 Thread",
  });
  return result.ok ? result.thread : null;
}

/* ---------- Legacy compat: project API aliases ---------- */

// Backward compatibility exports for code that still uses "project" terminology
const normalizeProjectId = normalizeSlug;

function createProject(logsRoot, { projectId, projectName, description }) {
  const result = createThread(logsRoot, { slug: projectId, name: projectName, description });
  if (!result.ok) return result;
  return {
    ok: true,
    project: {
      project_id: result.thread.thread_id,
      project_name: result.thread.name,
      description: result.thread.description,
      created_at: result.thread.created_at,
      updated_at: result.thread.updated_at,
      archived: result.thread.archived,
    },
  };
}

function readProject(logsRoot, projectId) {
  const meta = readThread(logsRoot, projectId);
  if (!meta) return null;
  // Map thread fields to project fields for backward compat
  return {
    project_id: meta.thread_id,
    project_name: meta.name,
    description: meta.description,
    created_at: meta.created_at,
    updated_at: meta.updated_at,
    archived: meta.archived,
  };
}

function updateProject(logsRoot, projectId, patch) {
  const threadPatch = {};
  if (patch.project_name !== undefined) threadPatch.name = patch.project_name;
  if (patch.description !== undefined) threadPatch.description = patch.description;
  if (patch.archived !== undefined) threadPatch.archived = patch.archived;
  const result = updateThread(logsRoot, projectId, threadPatch);
  if (!result.ok) return result;
  return {
    ok: true,
    project: {
      project_id: result.thread.thread_id,
      project_name: result.thread.name,
      description: result.thread.description,
      created_at: result.thread.created_at,
      updated_at: result.thread.updated_at,
      archived: result.thread.archived,
    },
  };
}

function deleteProject(logsRoot, projectId, audit = {}) {
  return deleteThread(logsRoot, projectId, audit);
}

function listProjects(logsRoot) {
  return listThreads(logsRoot).map((t) => ({
    project_id: t.thread_id,
    project_name: t.name,
    description: t.description,
    created_at: t.created_at,
    updated_at: t.updated_at,
    archived: t.archived,
    session_count: t.session_count,
  }));
}

function ensureDefaultProject(logsRoot, defaultId, defaultName) {
  const thread = ensureDefaultThread(logsRoot, defaultId, defaultName);
  if (!thread) return null;
  return {
    project_id: thread.thread_id,
    project_name: thread.name,
    description: thread.description,
    created_at: thread.created_at,
    updated_at: thread.updated_at,
    archived: thread.archived,
  };
}

/* ---------- 导出 ---------- */

module.exports = {
  // Thread API (new)
  normalizeSlug,
  createThread,
  readThread,
  updateThread,
  touchThread,
  archiveThread,
  deleteThread,
  listThreads,
  listSessionIds,
  listSessions,
  sessionDirPath,
  sessionsDirPath,
  threadDirPath,
  ensureDefaultThread,
  readIndex,
  rebuildIndex,
  validateAndRepairIndex,

  // Project API (backward compat)
  normalizeProjectId,
  createProject,
  readProject,
  updateProject,
  deleteProject,
  listProjects,
  ensureDefaultProject,
};
