# Task Contract: live-activity-timeline-pr3-ui-runtime

> **Status**: Active
> **Plan**: plans/plan-20260816-2045-live-activity-timeline-pr3-ui-runtime.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-16 20:45
> **Review File**: `tasks/reviews/20260816-2045-live-activity-timeline-pr3-ui-runtime.review.md`
> **Notes File**: `tasks/notes/20260816-2045-live-activity-timeline-pr3-ui-runtime.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

PR2 now preserves typed event identity, stable order and loss metadata, but there
is no SDK-owned consumer that turns that authority into a deterministic UI view
model. If this slice is skipped, each host must independently reinvent tool
pairing, gap detection, unknown handling and output-state semantics, creating
multiple incompatible authorities at the browser boundary.

## Goal

Add the public, React-free `@byok-sdk/ui-runtime` package. It must expose replay
and incremental pure-fold APIs that consume the typed `ActivityTail`/
`TimelineEvent` authority, produce a BYOK-owned task timeline snapshot, pair
tools only by native `toolCallId`, preserve text fragments and event position,
and surface gaps, drops, capacity, cursor and expiry without network,
persistence, presentation or semantic fallbacks. Wire the package into the
release train, umbrella SDK and isolated package smoke gates.

## Scope

- In scope: immutable state/view-model DTOs; replay and incremental folding;
  schema-authority validation; identity/order dedup and collision rejection;
  tool correlation/outcome states; text/artifact/usage/error/boundary/unknown
  projection; gap/loss/TTL metadata; public package/release graph/pack wiring;
  reducer and package-boundary tests; spec implementation-status update.
- Out of scope: host BFF transport, browser auth/redaction, React/presentation,
  `ThreadMessageLike`, transcript or durable-log semantics, approval states,
  persistence, pagination/SSE, package publication and legacy detail parsing.
- Taste constraints: BYOK workspace dependencies only; no third-party runtime,
  React or Node built-ins; do not copy protocol discriminant or cloud DTO
  authority; no synthetic IDs, adjacency/name heuristics, opaque-output
  inference, mutation-visible state or compatibility paths.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

If the package cannot consume the existing typed activity authority while
remaining platform-neutral and free of third-party direct runtime dependencies,
the new package boundary is wrong. The cheapest proof is its manifest/compiled
bundle constraint test plus an isolated tarball import before implementing any
host integration.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260816-2045-live-activity-timeline-pr3-ui-runtime.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260816-2045-live-activity-timeline-pr3-ui-runtime.review.md`
- Notes file: `tasks/notes/20260816-2045-live-activity-timeline-pr3-ui-runtime.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"ui-runtime-required-checks","kind":"deterministic_test","paths":["*"]},{"id":"ui-runtime-isolated-package-smoke","kind":"runtime_readback","paths":["packages/ui-runtime/package.json","packages/ui-runtime/src/index.ts","packages/sdk/package.json","packages/sdk/src/index.ts","scripts/release/check-package-graph.mjs","scripts/release/pack-and-smoke.mjs","scripts/release/registry-readback.mjs","bun.lock"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - README.md
  - plans/
  - plans/archive/
  - tasks/todos.md
  - tasks/current.md
  - tasks/archive/
  - tasks/contracts/20260816-2045-live-activity-timeline-pr3-ui-runtime.contract.md
  - tasks/reviews/20260816-2045-live-activity-timeline-pr3-ui-runtime.review.md
  - tasks/notes/20260816-2045-live-activity-timeline-pr3-ui-runtime.notes.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
  - packages/ui-runtime/
  - packages/sdk/package.json
  - packages/sdk/src/index.ts
  - packages/sdk/src/index.test.ts
  - scripts/release/check-package-graph.mjs
  - scripts/release/pack-and-smoke.mjs
  - scripts/release/registry-readback.mjs
  - bun.lock
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
    - packages/ui-runtime/package.json
    - packages/ui-runtime/src/index.ts
    - packages/ui-runtime/src/__tests__/timeline.test.ts
    - packages/ui-runtime/src/__tests__/constraints.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260816-2045-live-activity-timeline-pr3-ui-runtime.notes.md
  tests_pass:
    - path: packages/ui-runtime/src/__tests__/timeline.test.ts
    - path: packages/ui-runtime/src/__tests__/constraints.test.ts
  commands_succeed:
    - bun run --filter @byok-sdk/ui-runtime test
    - bun run --filter @byok-sdk/ui-runtime typecheck
    - bun run check:release-graph
    - bun run check:release-pack
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: replay and incremental folding converge to the same
  stable task snapshot; every source event is represented or explicitly
  classified without transcript semantics.
- Edge cases: replay overlap, out-of-order delivery, result-before-use,
  same-name concurrent calls, missing IDs, all `isError` states, fragment
  boundaries, unknown/unsupported events, gaps, drops, malformed known events,
  task/identity/order/tool collisions.
- Regression risks: release graph omits the package; umbrella/lockfile/tarball
  drift; reducer copies protocol authority; a browser-neutral package pulls in
  React/Node or pairs calls heuristically.

## Rollback Point

- Commit / checkpoint: PR3 merge commit after exact-target acceptance.
- Revert strategy: remove the additive package, umbrella namespace, lockfile
  workspace record and release-gate entries; no persisted data is changed.
