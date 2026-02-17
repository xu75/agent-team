# Error Handling Matrix | 异常处理矩阵

Last updated | 最近更新: 2026-02-17  
Purpose | 目的: define consistent behavior for failures, retries, outcomes, and UI messaging | 统一失败、重试、结果状态与 UI 提示语义

## 1. Matrix | 矩阵

| Error Type | Typical Signal | Retry Policy | Final Outcome (current) | Recommended Outcome (target) | Operator UX |
|---|---|---|---|---|---|
| Provider network disconnect | `stream disconnected before completion` | retry with backoff, max 3-5 | `review_schema_invalid` (or generic runtime error) | `provider_network_error` | show "网络断流，可重试" |
| Provider timeout | process timeout / no completion | 1-2 retries for idempotent stage | stage-specific invalid/fail | `provider_timeout` | show timeout + retry option |
| Provider auth/config error | 401/403/invalid token | no auto retry | schema invalid / runtime error text | `provider_auth_error` | show "鉴权失败，检查 token" |
| Binary missing | ENOENT from provider CLI | no retry | runtime error | `provider_not_found` | show install/path guidance |
| Reviewer schema invalid | invalid JSON / missing fields | optional one-shot regenerate | `review_schema_invalid` | keep | show "评审输出格式错误" |
| Tester schema invalid | invalid JSON / missing fields | optional one-shot regenerate | `tester_schema_invalid` | keep | show "测试输出格式错误" |
| Test command failed | non-zero command exit | no agent retry, iterate to coder | `test_failed` | keep | show failing command + stderr |
| Permission denied loop (Claude tools) | repeated permission denial lines | stop early | runtime error | `provider_permission_denied` | show permission grant action |
| Operator cancellation | abort signal | no retry | `canceled` | keep | show canceled badge |

## 2. Stage-specific Handling | 分阶段处理策略

- Proposal discussion stage | 方案讨论阶段：
  - EN Do not fail whole thread on reviewer/tester schema; discussion is plain text.  
    CN 不应因 reviewer/tester schema 失败终止整条线程；讨论阶段是纯文本语义。
  - EN If provider errors, keep thread recoverable and show actionable retry hint.  
    CN 若 provider 出错，应保持线程可恢复，并给出可执行的重试提示。
- Implementation stage | 实施阶段：
  - EN Reviewer/tester strict schema remains a hard gate.  
    CN reviewer/tester 严格 schema 仍是硬门禁。
  - EN Network/provider errors should not be mislabeled as schema failures.  
    CN 网络/provider 错误不应误标为 schema 失败。

## 3. Retry Baseline (Recommended) | 重试基线（建议）

- EN Retryable: transient network disconnect, 5xx upstream, transport reset.  
  CN 可重试：瞬时断流、上游 5xx、传输重置。
- EN Non-retryable: auth, invalid binary path, deterministic schema failures.  
  CN 不可重试：鉴权失败、二进制路径错误、确定性 schema 失败。
- EN Backoff: `1s, 2s, 4s` + jitter, cap at 3 attempts.  
  CN 退避：`1s, 2s, 4s` + 抖动，默认最多 3 次。
- EN Persist retry metadata in round + task events.  
  CN 在 round 与 task 事件中落盘重试元数据。

## 4. UI Semantics (Recommended) | UI 语义建议

- EN Distinguish: `schema invalid`, `network error`, `auth error`, `canceled`.  
  CN 明确区分：`schema invalid`、`network error`、`auth error`、`canceled`。
- EN One-click actions: retry stage, switch provider + retry, continue discussion.  
  CN 提供一键动作：重试当前阶段、切换 provider 重试、继续讨论。

## 5. Logging Requirements | 日志留痕要求

For each failed stage, persist | 每个失败阶段都应落盘：

- raw provider output (`*_raw.md`)
- events (`*.events.jsonl`)
- normalized error class | 归一化错误分类
- retry count and next action | 重试次数与下一动作
- operator-facing message | 面向操作员的提示文案

