# Task Contract: runtime-event-spill

> **Status**: Active
> **Plan**: plans/plan-20260906-0253-runtime-event-spill.md
> **Task Profile**: code-change
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-09-06 03:00
> **Review File**: `tasks/reviews/20260906-0253-runtime-event-spill.review.md`
> **Notes File**: `tasks/notes/20260906-0253-runtime-event-spill.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

`tool_use.input` and `tool_result.output` cross the daemon into `task.progress` with no per-event byte bound. A single large shell output or file write produces a multi-megabyte envelope that is either shipped whole or rejected late by a downstream record cap. Bounding at ingestion, with the full content preserved in the blob plane, keeps the event stream small without losing evidence.

## Goal

Oversized `tool_use` / `tool_result` events leave `TaskRunner.pump` at or under `DaemonConfig.maxInlineEventBytes` (default 64 KiB): the spilled field is replaced by a UTF-8-safe head/tail preview, the full JSON serialization is uploaded to the blob plane under an idempotent key, and the event carries an optional additive `spill` descriptor with either the `BlobRef` or a bounded `unstoredReason`. Under-cap events are byte-identical to today. Metadata-status egress strips `spill`. The protocol freeze golden is regenerated as an additive change.

## Scope

- In scope: `AgentEventSpillSchema` and the optional field on two variants, protocol tests and golden, `docs/protocol.md`; `packages/client/src/daemon/event-spill.ts` and tests; `TaskRunner` deps/pump hook; `DaemonConfig.maxInlineEventBytes` with validation; egress metadata-status strip; TaskRunner and egress tests; api-surface goldens for protocol and client; CHANGELOG; workflow artifacts.
- Out of scope: `progress.text` (final-answer authority), `ProgressBatcher.maxBatchBytes` defaults, cloud ingress body limits, consumer rendering (Salesko, ui-runtime timeline beyond typecheck), blob retention/cleanup, PROTOCOL_VERSION bump.
- Taste constraints: no truncation without a descriptor; no retry loop around the upload; the replacement must be proven ≤ cap by measurement, not assumed.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if the freeze guard classifies the new field as a retyping.

## Falsifier

A consumer in this repo that reads `tool_result.output` as authoritative content without checking `spill` (ui-runtime timeline, bin/format, audit-log) would show a preview as the full result; cheapest proof is grepping those consumers and confirming they either tolerate the preview or are listed as follow-ups.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260906-0253-runtime-event-spill.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260906-0253-runtime-event-spill.review.md`
- Notes file: `tasks/notes/20260906-0253-runtime-event-spill.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"protocol-and-client-required-checks","kind":"deterministic_test","paths":["*"]},{"id":"task-runner-fake-blob-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/plan-20260906-0253-runtime-event-spill.md
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260906-0253-runtime-event-spill.contract.md
  - tasks/reviews/20260906-0253-runtime-event-spill.review.md
  - tasks/notes/20260906-0253-runtime-event-spill.notes.md
  - packages/protocol/src/agent-event.ts
  - packages/protocol/src/index.ts
  - packages/protocol/src/__tests__/agent-event.test.ts
  - packages/protocol/src/__tests__/freeze-guard.test.ts
  - packages/protocol/src/__tests__/golden/
  - packages/client/src/daemon/event-spill.ts
  - packages/client/src/daemon/task-runner.ts
  - packages/client/src/daemon/create-daemon.ts
  - packages/client/src/daemon/agent-egress-policy.ts
  - packages/client/src/__tests__/event-spill.test.ts
  - packages/client/src/__tests__/task-runner-event-spill.test.ts
  - packages/client/src/__tests__/task-runner-resource-limits.test.ts
  - packages/client/src/__tests__/create-daemon-resource-limits.test.ts
  - packages/client/src/__tests__/agent-egress-policy.test.ts
  - packages/client/src/__tests__/fixtures/
  - packages/ui-runtime/src/timeline.ts
  - packages/client/src/bin/format.ts
  - packages/client/src/bin/audit-log.ts
  - api-surface/protocol.d.ts
  - api-surface/client.d.ts
  # Widened during execution (2026-09-06): `@byok-sdk/cloud` re-exports the
  # protocol AgentEvent schemas, so its api-surface golden drifts mechanically
  # from the additive `spill` field. No cloud source is edited; the golden is
  # regenerated by `check-api-surface.mjs --update --package cloud`, and
  # `bun run check:api-surface` cannot pass without it.
  - api-surface/cloud.d.ts
  - docs/protocol.md
  - CHANGELOG.md
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
    - packages/client/src/daemon/event-spill.ts
    - packages/client/src/__tests__/event-spill.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260906-0253-runtime-event-spill.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/event-spill.test.ts
    - path: packages/client/src/__tests__/task-runner-event-spill.test.ts
    - path: packages/protocol/src/__tests__/agent-event.test.ts
    - path: packages/protocol/src/__tests__/freeze-guard.test.ts
  commands_succeed:
    - bun run --filter @byok-sdk/protocol typecheck
    - bun run --filter @byok-sdk/protocol test
    - bun run --filter @byok-sdk/client typecheck
    - bun run --filter @byok-sdk/client build
    - bun run --filter @byok-sdk/client test
    - bun run typecheck
    - bun run check:api-surface
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: an over-cap `tool_result` leaves the pump ≤ cap with `output = { preview: { head, tail } }` and `spill.blob` whose `contentHash` equals sha256 of the original serialized `output`; upload failure yields `spill.unstoredReason` and the task continues; under-cap events unchanged; `tool_use.input` symmetric.
- Edge cases: multi-byte code points at the head/tail cut; a cap so small the descriptor alone exceeds it (startup config error, ≥ 4096 enforced); a `BlobRef` with a long `blobId`; metadata-status egress never carries `spill`.
- Regression risks: Salesko may render `output.preview` as content until it reads `spill`; whole-task byte accounting now counts post-spill bytes.

## Rollback Point

- Commit / checkpoint: `5af5c5c` (branch tip before this task's uncommitted work).
- Revert strategy: revert the single PR; uploaded spill blobs become orphans.
