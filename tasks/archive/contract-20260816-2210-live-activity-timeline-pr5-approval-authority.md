> **Archived**: 2026-08-16 22:10
> **Related Plan**: plans/archive/plan-20260816-2138-live-activity-timeline-pr5-approval-authority.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260816-2210

# Task Contract: live-activity-timeline-pr5-approval-authority

> **Status**: Fulfilled
> **Plan**: plans/plan-20260816-2138-live-activity-timeline-pr5-approval-authority.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-16 21:38
> **Review File**: `tasks/reviews/20260816-2138-live-activity-timeline-pr5-approval-authority.review.md`
> **Notes File**: `tasks/notes/20260816-2138-live-activity-timeline-pr5-approval-authority.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The daemon and wire already carry an out-of-band approval lifecycle, but cloud
currently accepts and deduplicates those envelopes without preserving a typed
read authority. A UI projection built first would therefore invent state from
transient traffic or reinterpret `AgentEvent.needs_approval`. Shipping the
storage boundary incorrectly could also fabricate ordering between approval and
activity streams or leak one tenant's approval summaries to another.

## Goal

Add a bounded, tenant-scoped approval timeline authority with typed requested
and resolved observations, store-assigned monotonic per-task revisions,
in-memory/Postgres conformance, real inbound persistence, and a host-only
`readApprovalTimeline` control-plane method. Validate persisted approval
identifiers as trim-aware nonblank values while leaving frozen wire v1
unchanged. Do not project UI state or claim a cross-stream total order.

## Scope

- In scope: frozen-protocol verification; cloud approval-ID validation;
  approval DTO and store port;
  tenant-bound facade; in-memory and Postgres stores; additive SQL table;
  authenticated/deduplicated inbound append; host-only read API; conformance,
  concurrency, TTL, capacity, tenant-isolation and freeze tests; spec and
  workflow artifacts.
- Out of scope:
  - `AgentEvent.needs_approval`, UI fold/presentation, approval mutation/control, and any guessed relation between approvalId and toolCallId.
- Taste constraints: approval revision is its own arrival-order authority;
  preserve native values exactly; reject malformed authority; no heuristic
  pairing, compatibility parser, dual write, or semantic fallback.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop before deleting data, running a production migration, publishing a
  package, force-pushing/resetting, or removing a worktree. This contract only
  authorizes an additive migration file and local test-database application.

## Falsifier

The direction is wrong if current wire/runtime evidence provides one
authoritative monotonic cursor shared by progress and approval envelopes, or if
approval messages bypass the existing accepted-envelope dedup authority. The
cheapest proof is the protocol codec plus one real daemon→cloud inbound trace;
either observation stops implementation until the authority boundary is
revised.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260816-2138-live-activity-timeline-pr5-approval-authority.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260816-2138-live-activity-timeline-pr5-approval-authority.review.md`
- Notes file: `tasks/notes/20260816-2138-live-activity-timeline-pr5-approval-authority.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"approval-authority-required-checks","kind":"deterministic_test","paths":["*"]},{"id":"approval-postgres-runtime-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - deploy/sql/0007_approval_timeline.sql
  - packages/protocol/src/__tests__/
  - packages/cloud/src/
  - packages/cloud-dataplane/src/
  - packages/conformance/src/
  - tests/sql/control_plane_invariants.sql
  - plans/
  - plans/archive/
  - tasks/todos.md
  - tasks/current.md
  - tasks/archive/
  - tasks/contracts/20260816-2138-live-activity-timeline-pr5-approval-authority.contract.md
  - tasks/reviews/20260816-2138-live-activity-timeline-pr5-approval-authority.review.md
  - tasks/notes/20260816-2138-live-activity-timeline-pr5-approval-authority.notes.md
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
    - deploy/sql/0007_approval_timeline.sql
    - packages/cloud/src/approval-timeline.ts
    - packages/cloud/src/__tests__/approval-timeline-store-conformance.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260816-2138-live-activity-timeline-pr5-approval-authority.notes.md
  tests_pass:
    - path: packages/protocol/src/__tests__/freeze-guard.test.ts
    - path: packages/cloud/src/__tests__/approval-timeline-store-conformance.test.ts
    - path: packages/cloud/src/__tests__/inbound-gate.test.ts
  commands_succeed:
    - bun run --filter @byok-sdk/protocol test
    - bun run --filter @byok-sdk/cloud test
    - bun run --filter @byok-sdk/cloud-dataplane test
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: accepted approval envelopes are appended exactly once to
  the correct tenant/task bounded tail and are available through the host-only
  read surface with exact native lifecycle values.
- Edge cases: missing request ID, blank ID rejection, resolved-before-request,
  duplicate delivery, concurrent append, capacity eviction, TTL expiry, tenant
  isolation, and absent tails.
- Regression risks: accidentally merging approval and activity ordering,
  interpreting cloud observations as UI state, weakening inbound dedup, or
  applying a migration outside the local test database.

## Rollback Point

- Commit / checkpoint: freeze the PR5 subject after targeted tests and before
  final acceptance evidence.
- Revert strategy: revert application/API changes before deployment; the
  additive table can remain unused. Dropping stored rows/table is destructive
  and requires separate operator authorization.
