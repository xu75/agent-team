# FSM Transition Table | FSM 状态迁移表

Last updated | 最近更新: 2026-02-28
Source of truth | 事实来源: coordinator runtime (`src/coordinator.js`)

## 1. State Set | 状态集合

- `intake`
- `plan`
- `build`
- `review`
- `test`
- `iterate`
- `finalize`

## 2. Transition Table | 迁移表

| From | Event / Condition | Guard | Action | To |
|---|---|---|---|---|
| `null` | `task_received` | new task | init run context, emit event | `intake` |
| `finalize` | `task_followup_received` | append mode | append follow-up message | `intake` |
| `intake` | `draft_proposal` | executionMode=`proposal` | run coder in proposal mode | `plan` |
| `plan` | `roundtable_reviewer` | proposal | run reviewer in discussion mode | `review` |
| `review` | `roundtable_tester` | proposal | run tester in discussion mode | `test` |
| `test` | `await_operator_confirm` | proposal complete | persist round summary | `finalize` |
| `intake` | `implementation_confirmed` | operator confirm or implementation mode | start implementation loop | `plan` |
| `plan` | `start_coder` | implementation loop | run coder impl | `build` |
| `build` | `start_reviewer` | coder completed | run reviewer strict JSON | `review` |
| `review` | `review_schema_invalid` | reviewer parse/schema fail | set outcome, stop run | `finalize` |
| `review` | `review_changes_requested` | reviewer decision=changes_requested | set must-fix list | `iterate` |
| `review` | `review_approved` | reviewer decision=approve | run tester strict JSON | `test` |
| `test` | `tester_schema_invalid` | tester parse/schema fail | set must-fix list | `iterate` |
| `test` | `tester_command_blocked` | all failures are blocked commands | set must-fix, stop run (no iteration) | `finalize` |
| `test` | `tests_failed` | command result has real failures | set must-fix list with failed command + stderr | `iterate` |
| `test` | `repeated_test_failure` | same command failed as previous round | set must-fix, stop run (no iteration) | `finalize` |
| `test` | `tests_passed` | all commands pass | clear must-fix, finalize approved | `finalize` |
| `iterate` | `start_coder` | iterations remaining | next round build | `build` |
| `*` | `aborted_by_operator` | abort signal raised | stop and persist canceled | `finalize` |
| `*` | `max_iterations_reached` | implementation loop exhausted | finalize best effort | `finalize` |

## 3. Outcome Mapping (Current) | 当前 Outcome 映射

- `await_operator_confirm`: EN proposal roundtable done, waiting operator confirmation | CN 方案讨论完成，等待操作员确认
- `proposal_changes_requested`: EN legacy proposal outcome for old tasks | CN 历史任务的旧 proposal 结果
- `approved`: EN implementation pass + tests pass | CN 实施通过且测试通过
- `review_schema_invalid`: EN reviewer strict-schema parse failure | CN reviewer 严格 schema 解析失败
- `tester_schema_invalid`: EN tester strict-schema parse failure | CN tester 严格 schema 解析失败
- `test_failed`: EN tester commands executed but failed | CN tester 给出的命令执行失败
- `tester_command_blocked`: EN all test failures due to blocked (non-allowlisted) commands | CN 所有测试失败均因命令被白名单拦截
- `repeated_test_failure`: EN same test command failed in consecutive rounds | CN 连续两轮相同测试命令失败
- `max_iterations_reached`: EN iteration budget exhausted | CN 迭代预算耗尽
- `canceled`: EN operator aborted run | CN 操作员主动终止

## 4. Recommended Near-term Additions | 近期建议补充

1. EN Add explicit `discussion_complete` for proposal mode.
   CN 为 proposal 模式增加显式 `discussion_complete`。
2. EN Add explicit `provider_network_error` / `provider_timeout` / `provider_auth_error`.
   CN 增加显式 `provider_network_error` / `provider_timeout` / `provider_auth_error`。
3. EN Add retry metadata (`retry_count`, `retry_reason`) to state events.
   CN 在状态事件中补充重试元数据（`retry_count`、`retry_reason`）。
4. EN Add `provider_not_found` outcome when CLI binary is missing (ENOENT).
   CN 当 CLI 二进制文件缺失（ENOENT）时增加 `provider_not_found` outcome。
5. EN Add `provider_permission_denied` outcome for repeated Claude permission denial loops.
   CN 当 Claude 反复出现权限拒绝循环时增加 `provider_permission_denied` outcome。

## 5. Notes | 备注

- EN: Chat mode (`@猫猫` free-form conversation) does NOT use the FSM. It has its own lightweight thread model in `src/engine/chat-session.js`.
  CN: 聊天模式（`@猫猫` 自由对话）不走 FSM，有独立的轻量 thread 模型，见 `src/engine/chat-session.js`。
- EN: The `tester_command_blocked` and `repeated_test_failure` outcomes are terminal — they go directly to `finalize` without further iteration, because the root cause is not in the coder's code.
  CN: `tester_command_blocked` 和 `repeated_test_failure` 是终态 outcome，直接进入 `finalize` 不再迭代，因为根因不在 coder 的代码中。
