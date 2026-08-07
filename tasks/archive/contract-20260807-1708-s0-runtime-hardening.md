> **Archived**: 2026-08-07 17:08
> **Related Plan**: plans/archive/plan-20260807-1508-s0-runtime-hardening.md
> **Outcome**: Completed
> **Lifecycle**: contract
> **Parent Run ID**: run-20260807-1708

# Task Contract: s0-runtime-hardening

> **Status**: Fulfilled
> **Plan**: plans/plan-20260807-1508-s0-runtime-hardening.md
> **Task Profile**: code-change
> **Owner**: ancienttwo
> **Capability ID**: root
> **Last Updated**: 2026-08-07 15:11
> **Review File**: `tasks/reviews/20260807-1508-s0-runtime-hardening.review.md`
> **Notes File**: `tasks/notes/20260807-1508-s0-runtime-hardening.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Sprint S0 of `plans/sprints/20260807-byok-platform-raft-aligned.sprint.md` closes the two Pri-0 runtime honesty gaps before any platform-line work starts. GAP-001: the wire advertises `approvalInteractive: false` for every runtime (`packages/client/src/daemon/create-daemon.ts:337` hardcodes it) while Claude's confirm path is real and wired — consumers cannot trust capability data. GAP-002: `steerTask()` (`packages/server/src/hub.ts:1493-1503`) sends `task.steer` to any Running task regardless of runtime; Claude/Codex adapters throw (`claude-adapter.ts:457-461`, `codex-adapter.ts:621-625`), the client cursor freezes at that seq (`connection-manager.ts:605-630` `stalledAtSeq`), and redelivery loops forever. If S0 ships wrong, every later sprint builds on dishonest capability data and an unsafe control surface; if skipped, the platform line inherits both gaps into hosted mode.

## Goal

Deliver Sprint S0 exactly as scoped in the sprint file: (1) `RuntimeAdapter.capabilities` becomes the only runtime-capability truth and wire `RuntimeInfo` is generated from adapter instances — the hardcoded `approvalInteractive: false` table is gone and Claude honestly reports interactive approval; (2) the server records a claim-time capability snapshot on the task record and `steerTask()` fail-closes with stable typed errors for runtimes that cannot steer, before any envelope is sent; (3) the client treats an inbound unsupported steer as a recorded protocol/authority error that acks and never freezes the cursor; (4) `workspaceHint` is documented as reserved and GAP-001/002/003 are closed in the architecture ledger. Protocol wire v1 stays frozen in the sense that matters: `v1.envelopes.ndjson` (the real v1 byte corpus) is byte-identical to base, machine-checked; `v1.frozen.json` (the schema fingerprint) is regenerated exactly once for the D-4 additive optional `task.claim.capabilities` field, with the diff limited to `task.claim` keys and reviewed line-by-line (sprint D-4; §2.4 additive-field allowance; `PROTOCOL_VERSION` stays 1).

## Scope

- In scope:
  - `packages/client/src/types.ts` — add `approvalInteractive` to the client `RuntimeCapabilities` interface (`:23-28`)
  - `packages/client/src/adapters/pi/pi-adapter.ts:77-79`, `claude/claude-adapter.ts:170-175`, `codex/codex-adapter.ts:126-128` — accurate per-adapter capability declarations
  - `packages/client/src/daemon/create-daemon.ts:333-360` — generate `RuntimeInfo.capabilities` from adapter truth; delete the hardcoded value
  - `packages/server/src/hub.ts` — claim-time capability snapshot (source per D-4: `task.claim.capabilities`, the claiming adapter's own self-report; connection-level `runtimes[]` stays discovery-only and `runtimeCapabilitySnapshot` is deleted) + `steerTask()` task-level gate with typed errors; unknown/missing capability fails closed
  - `packages/protocol/src/messages.ts` — bounded per D-4: `TaskClaimPayloadSchema` gains `capabilities: RuntimeCapabilitiesSchema.optional()`; nothing else
  - `packages/protocol/src/__tests__/golden/v1.frozen.json` — bounded per D-4: one additive regeneration, diff reviewed line-by-line
  - `packages/client/src/daemon/task-runner.ts` claim path — claim payload carries `capabilities` from the picked adapter (shared mapper extracted to avoid a create-daemon import cycle)
  - `packages/server/src/types.ts`, `task-store.ts`, `sqlite-task-store.ts` — additive task-record snapshot field persistence
  - `packages/client/src/daemon/task-runner.ts` (`handleSteer` `:1657-1661`) — classify unsupported-steer as non-retryable: record, ack, cursor advances; transient errors keep existing stall semantics
  - Tests: new `packages/server/src/__tests__/steer-runtime-capability-gate.test.ts`; update `packages/client/src/__tests__/daemon-conn-hello-capabilities.test.ts` and `real-server-longpoll-redelivery.test.ts`; adapter capability unit tests
  - Docs: `docs/protocol.md` (workspaceHint reserved note), `docs/architecture/sdk-architecture.md` (GAP-001/002/003 closure, §3.3/§4.4 updated)
- Out of scope:
  - `packages/protocol/**` beyond the two D-4-bounded items above — `v1.envelopes.ndjson` must stay byte-identical to base; any further protocol need is a new contract amendment, not a quiet widening
  - `packages/keys/**` — owned by the executing K-line plan
  - `docs/security.md` — shared with the K-line contract; S0 makes no credential-isolation change
  - New protocol message types, connection-level capability semantics changes, workspaceHint implementation
- Taste constraints: match existing module idiom; typed error objects over string matching; no defensive fallback that silently keeps sending steer.

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.
- Stop if any protocol need arises beyond the D-4 bounded authorization (`TaskClaimPayloadSchema` additive optional `capabilities` + one `v1.frozen.json` regeneration).

## Falsifier

**Original falsifier FIRED on 2026-08-07**: the original cheapest proof point claimed `conn.hello.runtimes[].capabilities` reaches the server for every device; on long-poll-only daemons `conn.hello` never exists (sole sender: `ws-transport.ts:192`), so the connection-sourced snapshot was structurally undefined for an entire transport and the fail-closed gate regressed working long-poll steer (5 pre-existing E2E tests red). Resolution: sprint D-4 — capability travels on `task.claim` itself.

Current falsifier: direction is wrong if the capability gating a steer does not travel on the same message that establishes the task↔runtime binding. Cheapest proof point: a pure long-poll daemon claiming a steer-capable runtime must steer successfully (H-010 E2E), while a hello-advertised but claim-silent capability must NOT open the gate (structural regression guard).

## Root Cause Evidence

Required when Task Profile is `bugfix`; leave as-is otherwise.

- root_cause: one sentence naming file:line/condition (testable, not "a state issue").
- repro: the command or UI path that reproduces the symptom.
- regression_guard: path to a test that fails on the unfixed code and passes after the fix (must also appear under exit_criteria.tests_pass).
- pre_fix_failure_artifact: path to a captured run of regression_guard on the UNFIXED code. Capture with `bun test <regression_guard> > <artifact> 2>&1; echo "PRE_FIX_EXIT=$?" >> <artifact>` (no pipes — pipes swallow the exit status). The gate requires a non-zero `PRE_FIX_EXIT=` line plus the regression_guard path string in the artifact (see the Root Cause Evidence Gate section in docs/reference-configs/sprint-contracts.md).

## Workflow Inventory

- Source plan: `plans/plan-20260807-1508-s0-runtime-hardening.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260807-1508-s0-runtime-hardening.review.md`
- Notes file: `tasks/notes/20260807-1508-s0-runtime-hardening.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - plans/
  - tasks/todos.md
  - tasks/current.md
  - tasks/contracts/20260807-1508-s0-runtime-hardening.contract.md
  - tasks/reviews/20260807-1508-s0-runtime-hardening.review.md
  - tasks/notes/20260807-1508-s0-runtime-hardening.notes.md
  - .ai/context/capabilities.json
  - docs/researches/
  - docs/architecture/
  - docs/protocol.md
  - packages/client/src/
  - packages/server/src/
  - packages/protocol/src/
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
    - packages/server/src/__tests__/steer-runtime-capability-gate.test.ts
    - packages/client/src/__tests__/daemon-conn-hello-capabilities.test.ts
    - docs/protocol.md
  files_contain:
    # H-005: stable typed steer rejection lives in the hub, named by its code.
    - path: packages/server/src/hub.ts
      pattern: "steer_unsupported_runtime"
    # H-002/H-003: the client capability interface carries the honest field.
    - path: packages/client/src/types.ts
      pattern: "approvalInteractive"
    # H-007: workspaceHint is documented as reserved.
    - path: docs/protocol.md
      pattern: "workspaceHint"
    # H-001: the architecture doc names the typed error in its updated steer section.
    - path: docs/architecture/sdk-architecture.md
      pattern: "steer_unsupported_runtime"
  files_not_contain:
    # GAP-001 root: the hardcoded wire value must be gone from the daemon assembly.
    - path: packages/client/src/daemon/create-daemon.ts
      pattern: "approvalInteractive: false"
  artifacts_exist:
    - .ai/harness/checks/latest.json
    - tasks/notes/20260807-1508-s0-runtime-hardening.notes.md
  commands_succeed:
    - pnpm -r run typecheck
    - pnpm -r run test
    - pnpm -r run build
    - git diff --exit-code packages/protocol/src/__tests__/golden/
    - git diff --exit-code main -- packages/protocol/src/__tests__/golden/v1.envelopes.ndjson
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: Pi running task steers successfully; Claude/Codex running task steer is rejected server-side with a typed error and zero envelopes sent; Claude runtime info reports interactive approval consistent with the real confirm path; forged/legacy inbound steer never stalls the client cursor; redelivered envelopes cause no second side effect.
- Edge cases: task with no capability snapshot (pre-S0 record) fails closed on steer; terminal-vs-steer race resolves terminal-first; device reconnect with a different adapter set does not retroactively change a running task's steerability.
- Regression risks: cursor stall semantics for genuinely transient handler errors must stay (existing `real-server-longpoll-redelivery` coverage); connection-level `steer` flag remains discovery-only; no credential-isolation change anywhere in the diff.

## Rollback Point

- Commit / checkpoint: branch `codex/s0-runtime-hardening` off `main@2038b82`; capability generation, server gate, client handling, docs, and the D-4 group (protocol additive → client claim capabilities → server source swap → test redirect) land as separately revertible commits.
- Revert strategy: revert the PR (or individual commits; the D-4 group reverts as one unit — the protocol commit alone reverting would break client compile); wire is additive-only (`v1.envelopes.ndjson` byte-identical) and the task-record snapshot field is additive/inert without the gate, so no persisted-state or compatibility residue.
