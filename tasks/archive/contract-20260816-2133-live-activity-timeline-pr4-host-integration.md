> **Archived**: 2026-08-16 21:33
> **Related Plan**: plans/archive/plan-20260816-2112-live-activity-timeline-pr4-host-integration.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260816-2133

# Task Contract: live-activity-timeline-pr4-host-integration

> **Status**: Fulfilled
> **Plan**: plans/plan-20260816-2112-live-activity-timeline-pr4-host-integration.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-16 21:32
> **Review File**: `tasks/reviews/20260816-2112-live-activity-timeline-pr4-host-integration.review.md`
> **Notes File**: `tasks/notes/20260816-2112-live-activity-timeline-pr4-host-integration.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

PR1 through PR3 now preserve native tool correlation, expose one typed bounded
activity authority, and fold it into a deterministic view model. The V1 product
boundary is still incomplete until a consuming host proves that browser access
is authorized by the SaaS user/tenant authority and that sensitive content is
redacted before projection and presentation. Shipping a device-authenticated
GET or trusting a browser tenant value would cross the security boundary the
spec explicitly assigns to the host BFF.

## Goal

Add a private, runnable `examples/live-activity-host` reference BFF that exposes
one Fetch-compatible conditional-GET route for an authorized task timeline. It
must inject host-owned authenticate, authorize, read, redact and presentation
authorities; derive the tenant only from authorization; sanitize every event
before `replayTimeline`; preserve timeline/correlation authority through
redaction validation; and contain all internal failures behind generic browser
responses. It must use the bounded tail cursor through representation-aware
ETag polling without changing any public SDK contract.

## Scope

- In scope: a private example package; standard Fetch request handling; opaque
  host user/session type; user/task-to-tenant authorization; tenant-scoped
  `readActivity` port; mandatory event redaction; redaction invariant checks;
  ui-runtime replay; host presentation callback; private/no-cache JSON response;
  representation-revision-aware ETag polling; security and failure-path tests;
  runnable README and spec implementation-status update.
- Out of scope: public SDK auth abstractions, real identity-provider integration,
  browser-supplied tenant IDs, cloud/device HTTP routes, SSE, durable history,
  transcript or approval semantics, React, `ThreadMessageLike`, package
  publication, database changes, and compatibility/fallback parsing.
- Taste constraints: browser input can name only the task; denial and absence
  share a 404 body; raw events never reach presentation; internal errors and
  secrets never enter HTTP responses; no new third-party runtime dependency or
  semantic fallback.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop before any destructive action, data deletion, schema migration, package
  publication, deployment, or mutation outside this isolated contract
  worktree; none is authorized by this slice.

## Falsifier

If the existing `ByokCloud.readActivity(tenant, taskId)` plus
`replayTimeline(ActivityTail)` cannot be composed behind an injected host auth
boundary without changing a public SDK package, this reference-example boundary
is wrong. The cheapest proof is a typed in-memory handler test that authorizes a
route task to one tenant, reads the typed tail, redacts it, and serializes the
projected response before adding any framework or transport dependency.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260816-2112-live-activity-timeline-pr4-host-integration.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260816-2112-live-activity-timeline-pr4-host-integration.review.md`
- Notes file: `tasks/notes/20260816-2112-live-activity-timeline-pr4-host-integration.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"host-integration-required-checks","kind":"deterministic_test","paths":["*"]},{"id":"host-fetch-runtime-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - examples/live-activity-host/
  - bun.lock
  - plans/
  - plans/archive/
  - tasks/todos.md
  - tasks/current.md
  - tasks/archive/
  - tasks/contracts/20260816-2112-live-activity-timeline-pr4-host-integration.contract.md
  - tasks/reviews/20260816-2112-live-activity-timeline-pr4-host-integration.review.md
  - tasks/notes/20260816-2112-live-activity-timeline-pr4-host-integration.notes.md
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
    - examples/live-activity-host/package.json
    - examples/live-activity-host/src/index.ts
    - examples/live-activity-host/src/__tests__/host.test.ts
    - examples/live-activity-host/README.md
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260816-2112-live-activity-timeline-pr4-host-integration.notes.md
  tests_pass:
    - path: examples/live-activity-host/src/__tests__/host.test.ts
  commands_succeed:
    - bun run --filter @byok-sdk/example-live-activity-host test
    - bun run --filter @byok-sdk/example-live-activity-host typecheck
    - bun run --filter @byok-sdk/example-live-activity-host build
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: authenticated and authorized browser requests receive
  only the host-presented projection of a redacted tenant-scoped activity tail;
  matching ETags conditionally return no body after auth.
- Edge cases: malformed task paths, unauthorized and absent tasks, hostile
  tenant query/header values, stale/matching ETags, unknown events, gaps/loss,
  invalid redaction, correlation mutation, serializer failure, and read errors.
- Regression risks: leaking raw tool values or exception text; authorizing
  after read/304; accepting tenant authority from the browser; ETags staying
  stable across policy changes; accidentally publishing the private example.

## Rollback Point

- Commit / checkpoint: PR4 merge commit after exact-target acceptance.
- Revert strategy: remove the private example, its workspace lock entry and the
  implementation-status text; no public package or persisted data is changed.
