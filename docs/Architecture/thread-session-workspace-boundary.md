# Thread / Session / Workspace 边界规范（开发态）

Last updated: 2026-03-02  
Status: Draft for implementation gate（文档先行，代码后续落地）  
Scope: 只定义目标结构与运行时约束；不包含迁移/回滚方案

## 1. 背景与问题

当前系统已经实现了 `Thread -> Session` 的数据归属，但还没有把执行目录和写入边界绑定到 Thread。结果是：

- 新建 Thread 仍可能在仓库根目录执行并修改 Cat-Cafe 代码。
- Thread 的“归属隔离”与“执行隔离”未对齐。

本规范用于统一后续实现和测试基线，避免接口漂移。

## 2. 当前行为快照（代码事实）

截至 2026-03-02：

- `thread.json` 仅包含 `thread_id/name/description/...`，没有 `workspace_root`、`allowed_write_roots`、`schema_version`。
- 聊天与工作流执行链路默认使用 `process.cwd()`（例如 `src/coordinator.js`、`src/engine/chat-session.js`、`src/engine/test-runner.js`）。
- `src/providers/codex-cli.js` 当前仅传 `--sandbox`，没有 `--add-dir` 注入逻辑。
- `/api/chat` 在未指定 thread 时仍可 fallback 到默认 thread（受 `THREAD_FALLBACK_ENABLED` 与 `THREAD_FALLBACK_DISABLE_ON` 控制）。

结论：当前 Thread 主要是“会话归属容器”，不是“执行工作区边界”。

## 3. 目标模型

- `Thread`：项目容器 + workspace 绑定 + 写入白名单策略。
- `Session`：Thread 内一次对话或一次任务运行。

### 3.1 Thread 元数据字段（目标）

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `thread_id` | string | 是 | Thread 主键 |
| `schema_version` | string | 否 | 缺失视为 `v0`；`v1` 表示启用 workspace 绑定语义 |
| `workspace_root` | string \| null | `v1` 必填 | 该 Thread 的执行根目录（绝对路径） |
| `allowed_write_roots` | string[] | 否 | 允许写入的绝对路径白名单 |

### 3.2 `allowed_write_roots` 语义

- 字段缺失：默认继承为 `[workspace_root]`（闭合默认）。
- 显式空数组 `[]`：拒绝所有写入（可读不可写）。
- 非空数组：仅允许写入数组中的路径前缀（经过 `realpath` 归一化后匹配）。

## 4. `v0/v1` 共存运行时行为（必须项）

### 4.1 版本判定

- 无 `schema_version`：按 `v0` 处理。
- `schema_version = "v1"`：按 workspace 绑定策略处理。

### 4.2 `v0`（向后兼容策略）

- 读取到 `v0` 时，`workspace_root` 视为 `null`。
- 写入拦截策略：**放行到服务启动仓库根目录（`server_repo_root`）范围内**，不放行到仓库外路径。
- 响应附加警告头：`X-Thread-Fallback: v0_no_workspace_bound`。
- 日志追加 `thread_fallback_reason=v0_no_workspace_bound`，便于后续观测。

说明：本策略保持当前开发态兼容，不引入“全盘写入”。

### 4.3 `v1`（目标严格策略）

- `workspace_root` 必须存在且有效，否则拒绝写入请求。
- 所有写入路径必须命中 `allowed_write_roots`（含默认继承规则）。

## 5. 错误码（本阶段固化）

| 错误码 | HTTP | 触发条件 |
|---|---|---|
| `THREAD_REQUIRED` | 422 | 请求缺少有效 thread 绑定，且不可 fallback |
| `WORKSPACE_NOT_BOUND` | 409 | `v1` thread 未绑定有效 `workspace_root` |
| `PATH_TRAVERSAL` | 400 | 目标路径归一化后越过允许根（含 `..`、非法前缀、symlink 逃逸） |
| `WORKSPACE_WRITE_FORBIDDEN` | 403 | `allowed_write_roots=[]`，明确禁止写入 |

`FALLBACK_EXPIRED`：**本阶段移除，不纳入实现与测试列表**。  
如果 fallback 到期，仅返回 `THREAD_REQUIRED(422)`，并在响应体 `fallback.reason=expired` 给出原因。

### 5.1 错误体示例

```json
{
  "error": "WORKSPACE_NOT_BOUND",
  "message": "Thread 'new-proj' 没有绑定 workspace_root",
  "thread_id": "new-proj"
}
```

```json
{
  "error": "PATH_TRAVERSAL",
  "message": "目标路径 '../../etc/passwd' 超出允许范围",
  "resolved_path": "/etc/passwd",
  "workspace_root": "/Users/xujinsong/VSCode/Projects/valid",
  "thread_id": "new-proj"
}
```

## 6. 安全规则

- 所有候选根路径与目标路径必须先做 `realpath` 归一化，再做白名单前缀匹配。
- 拒绝把 `/`、`/Users/<name>`（home 根级）配置为允许写入根。
- 拒绝未经校验的相对路径白名单（必须落为绝对路径后再判定）。
- symlink 策略：
  - 允许“合法 symlink”（解析后仍在允许根内）。
  - 拒绝“逃逸 symlink”（解析后越界）。
  - **检查频率：每一次写入操作都重新 `lstat + realpath`，不跨请求缓存结果**，降低中途替换 symlink 的攻击面。

## 7. `cwd` / `--add-dir` 参数来源链路（必须项）

### 7.1 目标链路

1. UI/调用方创建 Thread 时提交：`thread_id + workspace_root + allowed_write_roots + schema_version=v1`。
2. API 层校验并持久化到 `thread.json`。
3. Coordinator 在启动 Coder/Tester 前按 `thread_id` 读取 thread 元数据并解析 workspace 策略。
4. Runner/Provider 启动参数注入：
   - `cwd = workspace_root`
   - `--add-dir <path>` 来自 `allowed_write_roots`（排除与 `cwd` 重复项）
5. 测试命令执行器（test runner）使用同一 `cwd` 与同一写入策略，避免执行边界不一致。
6. 审计事件记录最终生效的 `cwd` 与 `allowed_write_roots_resolved`。

### 7.2 当前实现缺口（待代码阶段补齐）

- Thread 创建链路尚未写入 `workspace_root/allowed_write_roots/schema_version`。
- Coordinator 尚未从 Thread 元数据驱动 `cwd`。
- `codex-cli` 适配器尚未实现 `--add-dir` 参数拼装。

## 8. 可观测性（测试与审计需要）

在 `run.started` 事件和审计日志中至少记录：

- `thread_id`
- `schema_version`
- `workspace_root`
- `allowed_write_roots_resolved`
- `cwd`
- `thread_fallback_reason`（仅 v0）
- `path_check`（allow/deny + reason）

## 9. 验收用例矩阵

| 用例输入 | 预期行为 | 错误码/信号 |
|---|---|---|
| `v0` thread（无 `schema_version`）写入 `src/a.js`（仓库根内） | 允许写入，并回传 fallback 警告头 | `X-Thread-Fallback: v0_no_workspace_bound` |
| `v0` thread 写入 `/tmp/outside.txt`（仓库根外） | 拒绝写入 | `400 PATH_TRAVERSAL` |
| `v1` thread 且 `workspace_root` 缺失/无效 | 拒绝写入 | `409 WORKSPACE_NOT_BOUND` |
| `v1` thread，`allowed_write_roots` 缺失，写入 `workspace_root/src/a.js` | 允许写入（继承默认） | 成功 |
| `v1` thread，`allowed_write_roots` 缺失，写入 `workspace_root/../other/x.js` | 拒绝写入 | `400 PATH_TRAVERSAL` |
| `v1` thread，`allowed_write_roots=[]`，任意写入 | 拒绝写入 | `403 WORKSPACE_WRITE_FORBIDDEN` |
| 目标路径 `../../etc/passwd` | 拒绝写入 | `400 PATH_TRAVERSAL` |
| 目标路径 `/tmp/../../etc/passwd` | 拒绝写入 | `400 PATH_TRAVERSAL` |
| `workspace_root` 内 symlink -> 允许根内目标 | 允许写入 | 成功 |
| `workspace_root` 内 symlink -> `/etc/passwd` | 拒绝写入 | `400 PATH_TRAVERSAL` |
| 创建 thread 时 `workspace_root=/` 或 home 根级目录 | 创建即拒绝 | `400 PATH_TRAVERSAL` |
| 写入请求缺少 `thread_id` 且 fallback 不可用/已到期 | 拒绝请求 | `422 THREAD_REQUIRED` |
| 依赖相对路径的既有测试命令（收紧 `cwd` 后） | 必须补充回归用例并确认行为不回退 | 回归测试通过 |

## 10. 本阶段非目标

- 不定义 `thread-migration-and-fallback-plan`。
- 不展开历史数据迁移/回滚流程。
- 不引入额外兼容错误码（如 `FALLBACK_EXPIRED`）。

