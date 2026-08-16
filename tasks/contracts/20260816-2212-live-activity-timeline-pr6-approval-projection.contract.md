# Task Contract: live-activity-timeline-pr6-approval-projection

> **Status**: Active
> **Plan**: plans/plan-20260816-2212-live-activity-timeline-pr6-approval-projection.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-16 22:12
> **Review File**: `tasks/reviews/20260816-2212-live-activity-timeline-pr6-approval-projection.review.md`
> **Notes File**: `tasks/notes/20260816-2212-live-activity-timeline-pr6-approval-projection.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

PR5 established a bounded tenant-scoped approval observation authority, but consumers still lack a deterministic read model. If PR6 is skipped, hosts must hand-roll correlation and will drift on missing IDs, out-of-order observations, and conflict behavior. If it ships wrong, the UI could silently pair unrelated approvals, leak unredacted summaries, or imply an ordering/tool relationship that the wire does not provide.

## Goal

Deliver a pure approval projection in `@byok-sdk/ui-runtime` and integrate it into the read-only live-activity host reference so authorized callers receive separate activity and approval snapshots. Correlation must use only native `approvalId`; missing identity stays explicitly unpaired; conflicting native authority fails closed; protocol, persistence, `needs_approval`, and mutation surfaces remain unchanged.

## Scope

- In scope:
  - approval projection types, validation, incremental fold/replay, public exports, and focused tests;
  - paired/unpaired lifecycle, resolution-before-request convergence, exact-duplicate idempotency, and conflict rejection;
  - host approval read, tenant/task binding, authority-preserving redaction, separate snapshot presentation, and dual-stream ETag;
  - product-spec and workflow evidence updates.
- Out of scope:
  - protocol changes, persistence changes, action endpoints/buttons, `needs_approval` reinterpretation, `toolCallId` association, React/runtime dependencies, or durable audit claims.
- Taste constraints: one zero-dependency pure fold; keep approval and activity authorities visibly separate; fail closed instead of adding semantic fallbacks.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

The direction is wrong if `ApprovalTimelineTail` lacks stable native identity/revision semantics, if the accepted product boundary requires approval mutation in this slice, or if the host already exposes an authoritative shared order across activity and approval. The cheapest proof is the pre-edit trace of `packages/cloud/src/approval-timeline.ts`, `packages/ui-runtime/src/timeline.ts`, and `examples/live-activity-host/src/index.ts`; current source falsifies none of these assumptions.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260816-2212-live-activity-timeline-pr6-approval-projection.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260816-2212-live-activity-timeline-pr6-approval-projection.review.md`
- Notes file: `tasks/notes/20260816-2212-live-activity-timeline-pr6-approval-projection.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - packages/ui-runtime/src/
  - examples/live-activity-host/src/
  - plans/
  - plans/archive/
  - tasks/todos.md
  - tasks/current.md
  - tasks/archive/
  - tasks/contracts/20260816-2212-live-activity-timeline-pr6-approval-projection.contract.md
  - tasks/reviews/20260816-2212-live-activity-timeline-pr6-approval-projection.review.md
  - tasks/notes/20260816-2212-live-activity-timeline-pr6-approval-projection.notes.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
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
      - codex-exec
      - main-thread
    fallback: main-thread
    brief_is_authoritative: true
```

## Exit Criteria (Machine Verifiable)

```yaml
exit_criteria:
  files_exist:
    - docs/spec.md
    - packages/ui-runtime/src/approval-timeline.ts
    - examples/live-activity-host/src/index.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260816-2212-live-activity-timeline-pr6-approval-projection.notes.md
  tests_pass:
    - path: packages/ui-runtime/src/__tests__/approval-timeline.test.ts
    - path: examples/live-activity-host/src/__tests__/host.test.ts
  commands_succeed:
    - bun run --filter @byok-sdk/ui-runtime test
    - bun run --filter @byok-sdk/live-activity-host test
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: replay and incremental folding are equal; host presents separate sanitized snapshots after one authorized binding.
- Edge cases: resolution-before-request, missing request ID, unmatched resolution, exact duplicate, conflicting summary/decision, dropped metadata, task/revision drift.
- Regression risks: changing the host option contract is a coordinated example API change; activity folding and `needs_approval` classification must remain byte-for-byte behaviorally unchanged.

## Rollback Point

- Commit / checkpoint: frozen implementation subject before acceptance receipt.
- Revert strategy: revert UI-runtime and example-host commits; PR5 persisted approval authority remains independently usable.
