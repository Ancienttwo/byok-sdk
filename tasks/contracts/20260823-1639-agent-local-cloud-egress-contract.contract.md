# Task Contract: agent-local-cloud-egress-contract

> **Status**: Fulfilled
> **Plan**: plans/plan-20260823-1639-agent-local-cloud-egress-contract.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-23 16:42
> **Review File**: `tasks/reviews/20260823-1639-agent-local-cloud-egress-contract.review.md`
> **Notes File**: `tasks/notes/20260823-1639-agent-local-cloud-egress-contract.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The accepted Agent-home contract keeps execution and session authority local,
but the current outbound activity path remains contentful by default and uses
an in-memory transport outbox. It has no consumed egress policy, generic
envelope sanitizer, restart-safe outbound cursor/ack spool, per-Agent/tenant
quota receipt, or explicit capability-gated workspace/transcript/artifact read
contract. Shipping downstream assumptions without these primitives would leak
content, mislabel lossy activity as durable history, and create a second cloud
transcript authority.

## Goal

Deliver one generic Agent-local/cloud egress contract: metadata/status is the
default projection; contentful trajectory is explicit opt-in; reliable and
latest-value lanes have distinct types/stores; reliable records survive restart
and retire only after exact authenticated ack; quotas/backpressure/coalescing
and typed drop reasons are observable; every envelope passes one fail-closed
sanitizer; and workspace/transcript/artifact reads use separate additive
capabilities, exact Agent/session identity, canonical read policy and durable
content-free audit receipts.

## Scope

- In scope:
  - Typed `AgentEgressPolicy`, policy revision, lane/reliability/drop/denial
    types, additive egress and per-content-surface capabilities, frozen codec
    envelopes and public host configuration.
  - Metadata-default and explicit contentful trajectory projection before
    envelope creation, one SDK-owned sanitizer boundary, bounded coalescing and
    no-original-bytes-on-failure behavior for WS and long-poll.
  - Distinct Agent-local reliable spool and latest-value state, stable ids,
    cursor/ack/retry, restart recovery, per-Agent and authenticated-tenant
    byte/event quotas, backpressure and status/drop receipts.
  - Workspace/transcript/artifact request handlers with canonical Agent-home or
    runtime-root containment, existing-ancestor realpath checks, symlink and
    sensitive-name refusal, positive size limits, explicit MIME allowlists and
    durable content-free audit receipts.
  - Reference server and hosted cloud/dataplane capability admission, exact
    identity enforcement, durable cursor/ack/receipt facts and restart readback.
  - BYOK and Salesko/downstream configuration, authority, migration and
    retention guidance.
- Out of scope:
  - Salesko Profile schema, tenant UI, shared-message product semantics, cloud
    retention implementation, provider/tool-loop authority, credential bytes,
    migration execution, publication, deployment, or recursive Agent-home sync.
  - Reclassifying historical `task.progress`, existing local transcripts or
    task journal rows as sanitized, reliable or complete.
  - Calling narrow regex/token replacement DLP, parsing opaque business files,
    or creating a second provider/session authority.
- Taste constraints: no no-op config, silent reliable-to-lossy fallback,
  contentful default, dual queue semantics, generic browse endpoint, ambient
  roots, lexical-only path guards, best-effort sanitizer, or workspaceHint
  reuse.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop before any merge, push, publish, deploy, production migration, secret
  mutation or Agent-home deletion; none is authorized.
- Preserve the completed Agent-home contract and its exact cwd/session behavior.

## Falsifier

The direction is invalid if a default daemon emits trajectory/tool/prompt bytes,
if sanitizer failure still sends the original payload, if a reliable record can
retire before exact ack or vanish after restart, or if a content-read request
can escape its canonical policy. The cheapest proof is one protocol/client
wire test that injects trajectory text under the default policy and asserts the
encoded WS and long-poll envelopes contain metadata/status only.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260823-1639-agent-local-cloud-egress-contract.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260823-1639-agent-local-cloud-egress-contract.review.md`
- Notes file: `tasks/notes/20260823-1639-agent-local-cloud-egress-contract.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"agent-egress-wire-tests","kind":"deterministic_test","paths":["*"]},{"id":"agent-egress-restart-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/protocol.md
  - docs/host-local-storage-layout.md
  - docs/architecture/sdk-architecture.md
  - docs/researches/
  - README.md
  - packages/client/README.md
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260823-1639-agent-local-cloud-egress-contract.contract.md
  - tasks/reviews/20260823-1639-agent-local-cloud-egress-contract.review.md
  - tasks/notes/20260823-1639-agent-local-cloud-egress-contract.notes.md
  - .ai/harness/checks/latest.json
  - .ai/harness/runs/
  - deploy/sql/
  - tests/sql/control_plane_invariants.sql
  - packages/protocol/src/
  - packages/core/src/
  - packages/server/src/
  - packages/cloud/src/
  - packages/cloud-dataplane/src/
  - packages/conformance/src/
  - packages/testkit/src/
  - packages/client/src/
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
    - docs/spec.md
    - docs/protocol.md
    - docs/host-local-storage-layout.md
    - packages/protocol/src/__tests__/agent-egress-contract.test.ts
    - packages/server/src/__tests__/agent-egress-contract.test.ts
    - packages/cloud/src/__tests__/agent-egress-contract.test.ts
    - packages/cloud-dataplane/src/__tests__/agent-egress-contract.test.ts
    - packages/client/src/__tests__/agent-egress-policy.test.ts
    - packages/client/src/__tests__/agent-egress-spool.test.ts
    - packages/client/src/__tests__/agent-content-read.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260823-1639-agent-local-cloud-egress-contract.notes.md
  tests_pass:
    - path: packages/protocol/src/__tests__/agent-egress-contract.test.ts
    - path: packages/server/src/__tests__/agent-egress-contract.test.ts
    - path: packages/cloud/src/__tests__/agent-egress-contract.test.ts
    - path: packages/cloud-dataplane/src/__tests__/agent-egress-contract.test.ts
    - path: packages/client/src/__tests__/agent-egress-policy.test.ts
    - path: packages/client/src/__tests__/agent-egress-spool.test.ts
    - path: packages/client/src/__tests__/agent-content-read.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - BYOK_REQUIRE_DATAPLANE=1 bun run --cwd packages/cloud-dataplane test -- src/__tests__/agent-egress-contract.test.ts
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: default outbound Agent activity contains metadata/status
  only; explicit content, reliable delivery and each read surface require the
  exact consumed policy/capability and preserve Agent/session identity.
- Edge cases: sanitizer throw, restart before/after send and ack, duplicate/out
  of order ack, quota overlap and tenant isolation, disconnect/backpressure,
  traversal/absolute/symlink/sensitive-name/disallowed MIME/oversize reads,
  AgentRef/profileRevision/session/runtime/cwd mismatch and old daemon omission.
- Regression risks: legacy task execution accidentally gains contentful Agent
  authority, cloud activity becomes shared transcript, inbound journal becomes
  outbound authority, or accepted Agent-home cwd/session semantics change.

## Rollback Point

- Commit / checkpoint: accepted Agent-home parent `3c47b03` on
  `codex/agent-first-home-contract`; this follow-on plan is stacked locally
  until the parent is explicitly integrated.
- Revert strategy: revert only this follow-on work-package before downstream
  policy enablement. Never remove Agent homes, session evidence or credentials.
