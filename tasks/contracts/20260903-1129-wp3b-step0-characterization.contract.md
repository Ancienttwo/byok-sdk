# Task Contract: wp3b-step0-characterization

> **Status**: Fulfilled
> **Plan**: plans/plan-20260903-1129-wp3b-step0-characterization.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-03 12:32
> **Review File**: `tasks/reviews/20260903-1129-wp3b-step0-characterization.review.md`
> **Notes File**: `tasks/notes/20260903-1129-wp3b-step0-characterization.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

WP3B Steps 1–2 reimplement `@byok-sdk/server` over the `@byok-sdk/cloud` kernel and delete `hub.ts`. Without behaviour pins on the public surface, the fold would be measured against the implementation being deleted; any drift in first-terminal-wins, cancel precedence, approval targeting, steer gating, cursor replay, dedup/ownership, capability admission, or rate-limit episodes would ship silently to every embedder.

## Goal

Add `connectFakeDaemonLongPoll()` to `packages/server/src/__tests__/test-support.ts` and one new file `packages/server/src/__tests__/coordination-characterization.test.ts` holding the ten cases from `docs/researches/2026-09-03_wp3b-coordination-kernel-design-packet.md` §5, each asserting only on public outputs (`createByokServer` → HTTP status/body, `TaskHandle`, `tasks.get/list`, `stats()`), green against today's `hub.ts`, with zero production diff.

## Scope

- In scope: the fixture helper; the new test file; implementation notes; plan/contract/review projection.
- Out of scope: any change under `packages/server/src` outside `__tests__/`; rewriting or deleting existing tests (Step 2d); the lease reaper (§8 R2, decided separately); protocol docs; release, merge, push, PR, publish.
- Taste constraints: no `setTimeout`/fixed sleep as a completion signal; explicit cursors; no assertions on `hub.ts` internals or `longPollHoldMs` timing.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if a case cannot be expressed on the public surface without a production change: record it in the notes as a Step 1 gap and skip that case; do not change production.

## Falsifier

If any of the ten cases cannot pass against current `hub.ts` without a production edit, the packet's §5 description of today's semantics is wrong and must be corrected before Step 1; the cheapest proof point is running the new file alone with `bun test packages/server/src/__tests__/coordination-characterization.test.ts`.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260903-1129-wp3b-step0-characterization.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260903-1129-wp3b-step0-characterization.review.md`
- Notes file: `tasks/notes/20260903-1129-wp3b-step0-characterization.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"coordination-characterization","kind":"deterministic_test","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260903-1129-wp3b-step0-characterization.md
  - tasks/contracts/20260903-1129-wp3b-step0-characterization.contract.md
  - tasks/reviews/20260903-1129-wp3b-step0-characterization.review.md
  - tasks/notes/20260903-1129-wp3b-step0-characterization.notes.md
  - tasks/todos.md
  - tasks/current.md
  - packages/server/src/__tests__/
  - docs/architecture/index.md
  - docs/architecture/requests/root.md
  - packages/AGENTS.md
  - packages/CLAUDE.md
```

## Evidence Requirements

```yaml
evidence_requirements:
  # Set benchmark to required when this contract consumes the harness profile benchmark matrix.
  benchmark: not_applicable
```

## Delegation Contract

```yaml
delegation:
  budget:
    tokens: null
    runner_invocations: null
    wall_time_minutes: null
  permission_scope:
    mode: inherit_allowed_paths
    writable_paths: []
    network: inherited
  roles:
    parent:
      mode: narrate_and_gatekeep
      purpose: approval_checkpoint_owner
    explorer:
      mode: read_only
      purpose: codebase_research
    worker:
      mode: edit_within_allowed_paths
      purpose: implementation
    verifier:
      mode: read_only
      purpose: exit_criteria_review
  runner:
    preferred:
      - subagent
    fallback: null
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - packages/server/src/__tests__/coordination-characterization.test.ts
    - packages/server/src/__tests__/test-support.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260903-1129-wp3b-step0-characterization.notes.md
  tests_pass:
    - path: packages/server/src/__tests__/coordination-characterization.test.ts
  commands_succeed:
    - bun run --cwd packages/server test
    - bun run build
    - bun run typecheck
    - bun run check:api-surface
    - bun run check:version-authority
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: ten cases map 1:1 to packet §5 items; every assertion is on a public output.
- Edge cases: case 7 needs 501 dispatches to evict the ring; case 10 needs the rate limiter configured tight enough to trip deterministically.
- Regression risks: none in production; the new file duplicates some existing hub-* coverage until Step 2d prunes it.

## Rollback Point

- Commit / checkpoint: origin/main a0b183d
- Revert strategy: `git revert` the single squash commit (tests under `packages/server/src/__tests__/**`, workflow projection, and the four harness stamp files; no production code).
