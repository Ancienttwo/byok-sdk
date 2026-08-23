# Task Contract: agent-home-profile-projection

> **Status**: Partial
> **Plan**: plans/plan-20260824-0239-agent-home-profile-projection.md
> **Task Profile**: code-change
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-24 04:35
> **Review File**: `tasks/reviews/20260824-0239-agent-home-profile-projection.review.md`
> **Notes File**: `tasks/notes/20260824-0239-agent-home-profile-projection.notes.md`

## Why

Salesko's frozen consumer proves BYOK has no durable task-free exact-device
operation for projecting an Agent profile into an offline local Agent home.
Using a task would create a second workspace/session authority; treating enqueue
as synced would lose exact completion and retry evidence.

## Goal

Deliver a generic task-free projection control with exact capability admission,
durable desired state/status, SDK-owned canonical-home lifecycle and ordering,
and an exact completion receipt that alone permits cursor/mailbox retirement.

## Scope

- In scope: protocol/client/cloud/server primitive and dataplane conformance
  over the existing receipt store (no new source migration),
  docs, tests, full verification, independent acceptance, packed unpublished RC,
  and exact Salesko RC consumer acceptance.
- Out of scope: Salesko schemas/paths/UI/delete semantics, provider slug/endpoint,
  standing instructions, credentials, task/runtime/session creation, merge, push,
  npm publish, deploy, production migration, secrets, or formal downstream pin.
- Taste constraints: one authority per datum; no compatibility fallback, reroute,
  inferred tenant, downstream path join, fake task, or enqueue-equals-synced claim.

## Stop Conditions

- Stop if an edit falls outside Allowed Paths; amend this contract first.
- Stop if a semantic change would invalidate the frozen Salesko composite
  manifest without first receiving a new downstream hash.
- Stop before any merge, push, registry publish, deploy, production migration,
  secret mutation, local Agent-home deletion, or production wiring.

## Falsifier

Direction is wrong if an existing public API already provides a task-free,
durable, exact-device projection with exact completion readback. The frozen
Salesko falsifier proves the current API lacks `enqueueAgentHomeProjection`:
`bun test ./apps/byok-control/src/private-agent-profile-projection.falsifier.ts`
exits 1 against the installed beta and passes only when the upstream method is
present. Semantics are frozen at Salesko commit
`41d908fd53822212c4c5d69e2334fe23dac041d8`, composite
`sha256:6da37b5181495afa8faedf52335a9348bffd129fa66730a8328c8646859446c3`.

## Workflow Inventory

- Source plan: `plans/plan-20260824-0239-agent-home-profile-projection.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260824-0239-agent-home-profile-projection.review.md`
- Notes file: `tasks/notes/20260824-0239-agent-home-profile-projection.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only `allowed_paths`; update this contract before widening.
- Completion gate: prepare acceptance, record one typed AcceptanceReceipt for the
  frozen source subject, then verify sprint; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"agent-home-projection-contract-suite","kind":"deterministic_test","paths":["*"]},{"id":"projection-restart-dataplane-readback","kind":"runtime_readback","paths":["packages/client/src/__tests__/agent-home-projection.test.ts","packages/cloud-dataplane/src/__tests__/agent-home-projection.test.ts"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Codex","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/spec.md
  - docs/protocol.md
  - docs/host-local-storage-layout.md
  - docs/architecture/sdk-architecture.md
  - .ai/context/capabilities.json
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260824-0239-agent-home-profile-projection.contract.md
  - tasks/reviews/20260824-0239-agent-home-profile-projection.review.md
  - tasks/notes/20260824-0239-agent-home-profile-projection.notes.md
  - package.json
  - bun.lock
  - packages/protocol/package.json
  - packages/protocol/src/
  - packages/client/package.json
  - packages/client/src/
  - packages/cloud/package.json
  - packages/cloud/src/
  - packages/server/package.json
  - packages/server/src/
  - packages/cloud-dataplane/package.json
  - packages/cloud-dataplane/src/
  - packages/testkit/package.json
  - packages/ui-runtime/package.json
  - packages/sdk/package.json
  - packages/core/package.json
  - packages/keys/package.json
```

## Evidence Requirements

```yaml
evidence_requirements:
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
    - packages/client/src/__tests__/agent-home-projection.test.ts
    - packages/cloud/src/__tests__/agent-home-projection.test.ts
    - packages/server/src/__tests__/agent-home-projection.test.ts
    - packages/cloud-dataplane/src/__tests__/agent-home-projection.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260824-0239-agent-home-profile-projection.notes.md
  tests_pass:
    - path: packages/protocol/src/__tests__/agent-home-projection.test.ts
    - path: packages/client/src/__tests__/agent-home-projection.test.ts
    - path: packages/cloud/src/__tests__/agent-home-projection.test.ts
    - path: packages/server/src/__tests__/agent-home-projection.test.ts
    - path: packages/cloud-dataplane/src/__tests__/agent-home-projection.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - bun run check:release-graph
    - bun run check:release-pack
    - repo-harness run check-task-workflow --strict
    - git diff --check
```

## Acceptance Notes (Human Review)

- Functional behavior: exact-device durable pending, task-free canonical-home
  apply, exact completion status/readback, and restart redelivery.
- Edge cases: old capability, malformed/oversize payload, absence of any
  credential-specific protocol field,
  traversal/absolute/symlink/cross-Agent, stale/conflict/idempotent revision,
  busy overlap, hook/fsync/receipt failure, and wrong receipt identity.
- Regression risks: accidental TaskRunner side effects, cursor advancement before
  durable completion, a second path authority, or changed Agent task behavior.

## Rollback Point

- Commit / checkpoint: isolated branch `codex/agent-home-profile-projection` from
  `4316bb2f926169112c6feb51b51b447cc69f8999`.
- Revert strategy: delete/revert only this isolated branch and packed RC files;
  no published or deployed state is in scope.
