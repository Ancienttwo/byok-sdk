# Task Contract: agent-first-home-contract

> **Status**: Fulfilled
> **Plan**: plans/plan-20260823-1214-agent-first-home-contract.md
> **Task Profile**: code-change
> **Workflow Profile**: strict
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-23 12:39
> **Review File**: `tasks/reviews/20260823-1214-agent-first-home-contract.review.md`
> **Notes File**: `tasks/notes/20260823-1214-agent-first-home-contract.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

The current SDK gives a fresh task authority over `workspaceRoot/<taskId>` and
does not consume the reserved `workspaceHint`. That model cannot represent a
long-lived Agent whose memory, notes, artifacts, profile projection, and runtime
sessions must remain in one stable host-owned home. Adding an optional field to
the legacy offer would be unsafe because an old daemon could strip it and run in
the task workspace. This contract therefore introduces a distinct fail-closed
Agent execution path and carries one exact Agent identity through every
transport, persistence, manifest, cwd, session, concurrency, and terminal
boundary.

## Goal

Ship a generic Agent-first contract in which an Agent-bound dispatch carries a
bounded `AgentRef { agentId, profileRevision }`, targets a daemon that durably
declared `agent-home-contract`, uses the SDK-owned rule
`<hostStorageRoot>/agents/<agentId>` to resolve one Agent home,
uses that canonical home as the sealed runtime cwd, admits one mutable writer per
Agent, and persists exact Agent/session/terminal evidence across daemon, server,
and hosted-cloud restart. Product-specific Agent/profile semantics remain owned
by the embedding host.

## Scope

- In scope:
  - Strict Agent offer, typed AgentRef, additive capability, claim/terminal echo,
    codec/golden/freeze updates, and public dispatch input.
  - Reference-server and hosted-cloud pre-creation admission, durable device
    capability authority, mailbox/task persistence, exact-match validation, and
    terminal readback.
  - Absolute hostStorageRoot/projection interface, SDK-owned Agent-home path
    composition and create-if-missing initialization, path-segment validation,
    realpath/existing-ancestor symlink containment, canonical Agent isolation,
    same-Agent single-writer lease, and fail-closed session handoff persistence.
  - Frozen manifest Agent identity/cwd binding and Pi/Codex/Claude adapter cwd
    plus terminal-cause evidence.
  - Behavior-level positive, negative, concurrency, and restart tests, together
    with upstream/downstream responsibility and Salesko integration guidance.
- Out of scope:
  - Modifying the fulfilled connector-readonly contract or adding compatibility code to it.
  - Salesko Profile schema/content, branded hostStorageRoot selection beyond
    supplying one absolute root, credential storage, Agent CRUD,
    placement/scheduling policy, UI, deployment, or migration execution.
  - Copying RAFT private token/app-storage/inbox/machine/reminder/service layouts.
  - Parsing, indexing, naming, classifying, or assigning business semantics to
    opaque Agent artifacts such as projects, PDF files, or images. The SDK only
    constrains their owning canonical Agent home and cross-Agent lifecycle.
  - Claiming RAFT marker inventory or recovered-source probes as BYOK acceptance.
- Taste constraints: no `workspaceHint` reuse, optional AgentRef on legacy
  offers, silent downgrade, dual workspace authority, profile parsing, branded
  root derivation, downstream `agents/<agentId>` joining, lossy-presence
  admission, or fail-open session recovery.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Safe path: preserve the existing dirty README/storage-guide WIP, edit only the
  new Agent-first contract scope, and keep the fulfilled connector contract
  immutable as historical evidence.
- Destructive boundary: no publish, deploy, production migration execution,
  secret mutation, force push/reset, worktree removal, Agent-home deletion, or
  user-data deletion is authorized. SQL is forward-only and additive.

## Falsifier

The direction is invalid if an Agent offer can be decoded or executed by a
daemon that did not declare the additive capability, if two mutable tasks can
share one canonical Agent home, or if any resume/terminal boundary cannot prove
exact AgentRef and profile revision identity. The cheapest proof is the protocol
old-daemon omission test plus a client same-Agent overlap test; either failure
stops implementation before downstream migration guidance is treated as usable.

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260823-1214-agent-first-home-contract.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260823-1214-agent-first-home-contract.review.md`
- Notes file: `tasks/notes/20260823-1214-agent-first-home-contract.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"agent-home-contract-tests","kind":"deterministic_test","paths":["*"]},{"id":"agent-home-durable-readback","kind":"runtime_readback","paths":["packages/cloud-dataplane/src/","deploy/sql/"]}]}
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
  - docs/researches/
  - README.md
  - packages/client/README.md
  - plans/
  - tasks/todos.md
  - tasks/contracts/20260823-1214-agent-first-home-contract.contract.md
  - tasks/reviews/20260823-1214-agent-first-home-contract.review.md
  - tasks/notes/20260823-1214-agent-first-home-contract.notes.md
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
    - packages/protocol/src/__tests__/agent-home-contract.test.ts
    - packages/server/src/__tests__/agent-home-contract.test.ts
    - packages/cloud/src/__tests__/agent-home-contract.test.ts
    - packages/cloud-dataplane/src/__tests__/agent-home-contract.test.ts
    - packages/client/src/__tests__/agent-home-contract.test.ts
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260823-1214-agent-first-home-contract.notes.md
  tests_pass:
    - path: packages/protocol/src/__tests__/agent-home-contract.test.ts
    - path: packages/server/src/__tests__/agent-home-contract.test.ts
    - path: packages/cloud/src/__tests__/agent-home-contract.test.ts
    - path: packages/cloud-dataplane/src/__tests__/agent-home-contract.test.ts
    - path: packages/client/src/__tests__/agent-home-contract.test.ts
  commands_succeed:
    - bun run build
    - bun run typecheck
    - bun run test
    - BYOK_REQUIRE_DATAPLANE=1 bun run --cwd packages/cloud-dataplane test -- src/__tests__/agent-home-contract.test.ts
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: strict Agent offers require durable target capability;
  exact AgentRef/profileRevision survives protocol, server/cloud persistence,
  daemon restart, manifest sealing, runtime cwd, session handoff, and terminal
  readback; host initialization preserves existing Agent memory/notes.
- Responsibility boundary: Salesko supplies an absolute branded
  hostStorageRoot, stable AgentRef, and redacted projection content. BYOK SDK
  alone composes `agents/<agentId>`, initializes/preserves MEMORY.md and notes/,
  and binds cwd/session evidence. Opaque Agent files are not required to live
  in a literal `artifacts/` directory and are never parsed or indexed by SDK.
- Edge cases: old daemon omission, malformed/oversize AgentRef, traversal and
  absolute forms, relative hostStorageRoot, symlink escape through existing
  ancestors, cross-Agent collision, revision/session/runtime/cwd mismatch,
  same-Agent overlap, different-Agent isolation, corrupt store, and terminal
  cause after restart.
- Regression risks: frozen protocol drift, legacy task behavior accidentally
  consuming Agent fields, presence becoming an execution authority, session
  receipt written after started, artifact content being treated as SDK config,
  or host product semantics leaking into SDK.

## Rollback Point

- Commit / checkpoint: pre-implementation `main@263df0234d709ef59090986f133a9640e5e290fd` plus preserved user-owned README/storage-guide WIP.
- Revert strategy: revert the single Agent-first work-package diff before any
  downstream Salesko cutover. Do not modify or reactivate the fulfilled
  connector contract; do not delete any host Agent home created by a downstream
  integration.
