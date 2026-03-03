"use strict";

const fs = require("node:fs");
const path = require("node:path");

/* ---------- Error codes ---------- */

const ERRORS = Object.freeze({
  THREAD_REQUIRED: "THREAD_REQUIRED",
  WORKSPACE_NOT_BOUND: "WORKSPACE_NOT_BOUND",
  PATH_TRAVERSAL: "PATH_TRAVERSAL",
  WORKSPACE_WRITE_FORBIDDEN: "WORKSPACE_WRITE_FORBIDDEN",
});

/* ---------- Internal helpers ---------- */

/**
 * 安全 realpath：如果目标不存在则回退到 path.resolve 归一化。
 */
function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * 判断 target 是否在 roots 数组的某个前缀下。
 * 使用 realpath 归一化后进行前缀匹配，含 symlink 逃逸检测。
 */
function isPathUnder(target, roots) {
  if (!target || !Array.isArray(roots) || roots.length === 0) return false;
  const resolved = safeRealpath(target);
  for (const root of roots) {
    const resolvedRoot = safeRealpath(root);
    if (resolved === resolvedRoot) return true;
    if (resolved.startsWith(resolvedRoot + path.sep)) return true;
  }
  return false;
}

/**
 * 检测 target 是否为 symlink，且 symlink 解析后是否越界。
 * 返回 { isSymlink, escaped, resolvedTarget }。
 */
function checkSymlinkEscape(target, roots) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return { isSymlink: false, escaped: false, resolvedTarget: target };
  }
  if (!stat.isSymbolicLink()) {
    return { isSymlink: false, escaped: false, resolvedTarget: target };
  }
  let resolvedTarget;
  try {
    resolvedTarget = fs.realpathSync(target);
  } catch {
    // symlink 指向不存在的目标 → 视为越界
    return { isSymlink: true, escaped: true, resolvedTarget: target };
  }
  const escaped = !isPathUnder(resolvedTarget, roots);
  return { isSymlink: true, escaped, resolvedTarget };
}

/* ---------- Public API ---------- */

/**
 * 校验写入路径是否在 workspace policy 允许范围内。
 *
 * @param {string} targetPath — 要写入的路径
 * @param {object} policy — resolveThreadWorkspacePolicy() 返回值
 * @param {object} [opts] — { serverRepoRoot }
 * @returns {{ ok: boolean, code?: string, message?: string, resolved_path?: string }}
 */
function validateWritePath(targetPath, policy, opts = {}) {
  if (!targetPath) {
    return { ok: false, code: ERRORS.PATH_TRAVERSAL, message: "empty target path" };
  }

  const resolved = safeRealpath(targetPath);

  if (policy.version === "v0") {
    // v0 策略：放行到 serverRepoRoot 范围内
    const serverRoot = opts.serverRepoRoot || process.cwd();
    const resolvedServerRoot = safeRealpath(serverRoot);
    if (!isPathUnder(resolved, [resolvedServerRoot])) {
      return {
        ok: false,
        code: ERRORS.PATH_TRAVERSAL,
        message: `v0 thread: path '${targetPath}' is outside server repo root`,
        resolved_path: resolved,
      };
    }
    return { ok: true, v0_fallback: true };
  }

  // v1 策略
  if (!policy.workspaceRoot) {
    return {
      ok: false,
      code: ERRORS.WORKSPACE_NOT_BOUND,
      message: "v1 thread has no valid workspace_root",
    };
  }

  const allowedRoots = policy.allowedWriteRoots;
  if (Array.isArray(allowedRoots) && allowedRoots.length === 0) {
    return {
      ok: false,
      code: ERRORS.WORKSPACE_WRITE_FORBIDDEN,
      message: "allowed_write_roots is explicitly empty — all writes forbidden",
    };
  }

  const effectiveRoots = Array.isArray(allowedRoots) && allowedRoots.length > 0
    ? allowedRoots
    : [policy.workspaceRoot];

  if (!isPathUnder(resolved, effectiveRoots)) {
    return {
      ok: false,
      code: ERRORS.PATH_TRAVERSAL,
      message: `target path '${targetPath}' is outside allowed write roots`,
      resolved_path: resolved,
      workspace_root: policy.workspaceRoot,
    };
  }

  // symlink 逃逸检测
  const symlinkCheck = checkSymlinkEscape(targetPath, effectiveRoots);
  if (symlinkCheck.isSymlink && symlinkCheck.escaped) {
    return {
      ok: false,
      code: ERRORS.PATH_TRAVERSAL,
      message: `symlink escape: '${targetPath}' resolves to '${symlinkCheck.resolvedTarget}' outside allowed roots`,
      resolved_path: symlinkCheck.resolvedTarget,
      workspace_root: policy.workspaceRoot,
    };
  }

  return { ok: true };
}

/**
 * 断言 v1 thread 的 workspace 绑定有效。
 *
 * @param {object} threadMeta — thread.json 内容
 * @param {object} policy — resolveThreadWorkspacePolicy() 返回值
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
function assertWorkspaceBound(threadMeta, policy) {
  if (!threadMeta) {
    return { ok: false, code: ERRORS.THREAD_REQUIRED, message: "thread metadata is required" };
  }
  if (policy.version !== "v1") {
    return { ok: true }; // v0 不强制
  }
  if (!policy.workspaceRoot) {
    return {
      ok: false,
      code: ERRORS.WORKSPACE_NOT_BOUND,
      message: `Thread '${threadMeta.thread_id}' 没有绑定 workspace_root`,
      thread_id: threadMeta.thread_id,
    };
  }
  // 校验目录实际存在
  try {
    const stat = fs.statSync(policy.workspaceRoot);
    if (!stat.isDirectory()) {
      return {
        ok: false,
        code: ERRORS.WORKSPACE_NOT_BOUND,
        message: `workspace_root '${policy.workspaceRoot}' is not a directory`,
        thread_id: threadMeta.thread_id,
      };
    }
  } catch {
    return {
      ok: false,
      code: ERRORS.WORKSPACE_NOT_BOUND,
      message: `workspace_root '${policy.workspaceRoot}' does not exist`,
      thread_id: threadMeta.thread_id,
    };
  }
  return { ok: true };
}

module.exports = {
  ERRORS,
  validateWritePath,
  assertWorkspaceBound,
  isPathUnder,
  safeRealpath,
  checkSymlinkEscape,
};
