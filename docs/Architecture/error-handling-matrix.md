# Error Handling Matrix

Last updated: 2026-02-17
Purpose: define consistent runtime behavior for failures, retries, outcomes, and UI messaging.

## 1. Matrix

| Error Type | Typical Signal | Retry Policy | Final Outcome (current) | Recommended Outcome (target) | Operator UX |
|---|---|---|---|---|---|
| Provider network disconnect | `stream disconnected before completion` | retry with backoff, max 3-5 | `review_schema_invalid` (or tester/coder generic runtime error) | `provider_network_error` | show "网络断流，可重试" |
| Provider timeout | process timeout / no completion | 1-2 retries for idempotent stage | stage-specific invalid/fail | `provider_timeout` | show timeout + retry option |
| Provider auth/config error | 401/403/invalid token | no auto retry | schema invalid / runtime error text | `provider_auth_error` | show "鉴权失败，检查 token" |
| Binary missing | ENOENT from provider CLI | no retry | runtime error | `provider_not_found` | show install/path guidance |
| Reviewer schema invalid | invalid JSON / missing fields | optional one-shot regenerate | `review_schema_invalid` | keep | show "评审输出格式错误" |
| Tester schema invalid | invalid JSON / missing fields | optional one-shot regenerate | `tester_schema_invalid` | keep | show "测试输出格式错误" |
| Test command failed | non-zero command exit | no agent retry, iterate to coder | `test_failed` | keep | show failing command + stderr |
| Permission denied loop (Claude tools) | repeated permission denial lines | stop early | runtime error | `provider_permission_denied` | show permission grant action |
| Operator cancellation | abort signal | no retry | `canceled` | keep | show canceled badge |

## 2. Stage-specific Handling

- Proposal discussion stage:
  - Do not fail whole thread on reviewer/tester schema because discussion mode is plain text.
  - If provider errors, mark discussion message as failed but still keep thread recoverable.
- Implementation stage:
  - Reviewer/tester strict schema remains hard gate.
  - Network/provider failures should not be mislabeled as schema failures.

## 3. Retry Baseline (Recommended)

- Retryable classes: transient network disconnect, 5xx upstream, transport reset.
- Non-retryable classes: auth, invalid binary path, deterministic schema validation failures.
- Backoff: `1s, 2s, 4s` with jitter, cap at 3 attempts by default.
- Record retry attempts in round metadata and task events.

## 4. UI Semantics (Recommended)

- Distinguish these in status pills and right panel:
  - `schema invalid`
  - `network error`
  - `auth error`
  - `canceled`
- Provide one-click actions:
  - `重试当前阶段`
  - `切换 Provider 重试`
  - `继续讨论` (for proposal roundtable)

## 5. Logging Requirements

For each failed stage, persist:

- raw provider output (`*_raw.md`)
- events (`*.events.jsonl`)
- normalized error class
- retry count and next action
- operator-facing message

