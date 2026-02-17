# FSM Transition Table

Last updated: 2026-02-17
Source of truth: coordinator runtime (`src/coordinator.js`)

## 1. State Set

- `intake`
- `plan`
- `build`
- `review`
- `test`
- `iterate`
- `finalize`

## 2. Transition Table

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
| `test` | `tests_failed` | command result has failures | set must-fix list with failed command | `iterate` |
| `test` | `tests_passed` | all commands pass | clear must-fix, finalize approved | `finalize` |
| `iterate` | `start_coder` | iterations remaining | next round build | `build` |
| `*` | `aborted_by_operator` | abort signal raised | stop and persist canceled | `finalize` |
| `*` | `max_iterations_reached` | implementation loop exhausted | finalize best effort | `finalize` |

## 3. Outcome Mapping (Current)

- `await_operator_confirm`: proposal roundtable done, waiting operator confirmation.
- `proposal_changes_requested`: legacy proposal outcome (kept for backward compatibility in historical tasks).
- `approved`: implementation pass + tests pass.
- `review_schema_invalid`: reviewer strict-schema parse failure or empty/invalid response.
- `tester_schema_invalid`: tester strict-schema parse failure.
- `test_failed`: tester-generated commands executed but failed.
- `max_iterations_reached`: iteration budget exhausted.
- `canceled`: operator aborted run.

## 4. Recommended Near-term Additions

1. Add explicit `discussion_complete` outcome for proposal mode (replace overloaded approval semantics).
2. Add explicit `provider_network_error` / `provider_timeout` / `provider_auth_error` outcomes.
3. Add retry transition metadata (`retry_count`, `retry_reason`) for better replay clarity.

