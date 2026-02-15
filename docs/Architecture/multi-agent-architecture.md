

# Multi-Agent Architecture Guideline

This document captures the **design** (not the implementation) for a local “multi-agent” coding workflow inspired by cat-cafe tutorials. It is meant to be kept stable and updated as the system evolves.

## Goals

- Run multiple AI roles locally via CLI (starting with `claude`) to collaborate on coding tasks.
- Make the workflow **repeatable**: prompts, logs, and decisions are recorded.
- Improve reliability with **review + test + iteration loops**, not one-shot generation.
- Keep the core minimal: Node.js + `child_process.spawn()` + NDJSON parsing.

## Non-goals

- Not a full chat app UI.
- Not a fully autonomous agent swarm.
- Not aiming for perfect “human-like teamwork”; we optimize for **predictable automation**.

## Core Pattern

The minimal loop:

1. **Coordinator** receives a user task.
2. **Coder** produces an initial solution (code + notes).
3. **Reviewer** critiques and requests changes (quality, bugs, safety, style).
4. **Coder** revises.
5. Optional: **Tester** generates/updates tests, runs them, reports failures.
6. Loop stops when exit criteria are met.

### Diagram

User → Coordinator → Coder → Reviewer → Coder → (Tester) → Coordinator → Output

## Roles and Responsibilities

### Coordinator (Orchestrator)

**Responsibilities**
- Own the “task state”: what we’re building, current artifacts, and iteration count.
- Enforce policies: max iterations, formatting rules, required checks.
- Route tasks to roles and collect outputs.
- Decide when to stop (success/fail/needs human).

**Inputs**
- User request
- Current repo state (paths, files, diffs)
- Prior agent outputs

**Outputs**
- Final artifacts (patches/PR-ready changes)
- A run summary (what changed, why, what remains)

### Coder (Builder)

**Responsibilities**
- Create or modify code to satisfy the task.
- Provide short reasoning notes and assumptions.
- Produce patches in a deterministic format (diff/patch blocks when requested).

**Expected Output Format (recommended)**
- Summary (1–3 bullets)
- Patch (diff format or file-by-file changes)
- Notes (assumptions, TODOs)

### Reviewer (Critic)

**Responsibilities**
- Review coder output for:
  - Correctness, edge cases
  - API misuse, missing error handling
  - Style consistency and readability
  - Security/privacy concerns
  - Test coverage gaps
- Prefer actionable feedback: “Change X to Y because Z”.

**Expected Output Format (recommended)**
- ✅ What looks good
- ❗ Issues (must-fix)
- ⚠️ Suggestions (nice-to-have)
- 🧪 Tests to add/adjust

### Tester (Verifier)

**Responsibilities**
- Propose and/or implement unit tests and smoke tests.
- Provide commands to run.
- Interpret failures and point to likely causes.

**Expected Output Format (recommended)**
- Tests added/changed
- How to run
- Results interpretation

### Optional Roles

- **Architect**: high-level design and interfaces before coding begins.
- **Doc Writer**: README updates, usage docs, changelogs.
- **Security Reviewer**: threat modeling, dependency checks, secrets hygiene.

## Interfaces Between Roles

To avoid “free-form chaos”, define these stable interface contracts:

- **Task Spec**: short, explicit requirements + constraints.
- **Artifact Spec**: where outputs must land (files/paths), and expected format (diff).
- **Iteration Record**: a small JSON/Markdown record of each round:
  - prompt → output → review → decision

Recommended: keep agent prompts in `prompts/` and log runs under `logs/`.

## Stop Conditions

Coordinator should stop when **any** of these are true:

- All required checks pass (tests/lint/build if applicable).
- Reviewer reports “no must-fix issues”.
- Max iterations reached (e.g., 3–5) → return best effort + remaining issues.
- Safety policy violation risk detected → halt and ask for human decision.

## Quality Gates

Even in a minimal setup, enforce gates:

- “No obvious runtime errors” (basic import paths, syntax).
- “No secrets in output” (keys/tokens never printed).
- “Reviewer must run” before final output (except trivial tasks).

## Logging and Reproducibility

Minimum recommended logs:

- The exact CLI command invoked (model/tool/flags).
- NDJSON raw stream (optional, can be large).
- Extracted assistant text.
- Final patch/diff.

Suggested structure:
- `logs/YYYY-MM-DD/run-<id>/`
  - `request.md`
  - `coder.md`
  - `reviewer.md`
  - `result.md`
  - `diff.patch`

## Security and Safety Notes

- Treat the repo as sensitive: avoid uploading secrets or personal data.
- Prefer `NO_PROXY` for local ranges and avoid proxying local services unintentionally.
- If using third-party base URLs or gateways, document it explicitly and understand the trust boundary.

## Roadmap (Suggested Milestones)

1. **MVP (done/near-done)**
   - Spawn `claude` with stream-json and parse assistant text.
2. **Engine Layer**
   - Wrap CLI invocation in `runClaude(prompt, options)`.
   - Add timeouts, signal handling, stderr activity tracking.
3. **Two-role Loop**
   - Coder → Reviewer → Coder revise (1–3 rounds).
4. **Tests**
   - Tester role + basic test runner integration.
5. **Multi-model**
   - Add additional providers/models (optional).
6. **Tooling**
   - Structured patch application, CI checks, report generation.

## File Placement Convention

- This guideline: `docs/Architecture/multi-agent-architecture.md`
- ADRs (design decisions): `docs/Architecture/adr-YYYYMMDD-<title>.md`
- Prompts: `prompts/`
- Logs: `logs/`

---
Last updated: 2026-02-15