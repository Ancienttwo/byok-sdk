# Task Contract: agent-memory-phase2

> **Status**: Partial
> **Plan**: plans/plan-20260826-1725-agent-memory-phase2.md
> **Task Profile**: bugfix
> <!-- legal values: code-change | docs-only | ledger-closeout | migration | eval-only | delegated-run | bugfix (omit for legacy passthrough); see docs/reference-configs/sprint-contracts.md -->
> **Owner**: kito
> **Capability ID**: root
> **Last Updated**: 2026-08-27 02:57
> **Review File**: `tasks/reviews/20260826-1725-agent-memory-phase2.review.md`
> **Notes File**: `tasks/notes/20260826-1725-agent-memory-phase2.notes.md`
> **Exemplar**: `docs/reference-configs/contract-brief-example.md`

## Why

Phase 1 made per-Agent local memory discoverable but did not provide a bounded,
observable write contract or an opt-in hosted projection.  Shipping Phase 2
without one authoring authority, exact Agent/session authorization, redaction,
idempotency, metering, and erase semantics would either leak Agent-home content
or create a second conflicting memory authority for downstream Agents.

## Goal

Deliver a task-scoped local `memory.recall`/`memory.save` MCP over the existing
Agent home and an optional fail-closed local-to-hosted redacted snapshot
projection.  The local files remain the sole authoring authority; hosted state
is bounded, single-writer, idempotent, metered on accepted redacted bytes, and
erasable without an online device.

## Scope

- In scope: SDK-owned memory MCP, exact task/session/AgentRef authorization,
  bounded path/CAS/atomic local writes, metadata-only audit, required redaction,
  redacted-only outbox, hosted capability and authorization ports, single-writer
  projection store, Postgres persistence, metering receipts, and server erase.
- Out of scope: hosted-to-local restore/import, semantic search/RAG, history UI,
  multi-device merge, product-fact storage, consent UI, pricing, legal retention
  policy, compaction hooks, and changing the hosted content-read deny for
  `MEMORY.md`.
- Taste constraints: <!-- advisory only, no run gate; default style/taste lives in AGENTS.md and the minimal-change policy, use this to record a per-task override -->

## Stop Conditions

- Stop and hand back to the parent if the change would require editing a path outside Allowed Paths.
- Stop if an Exit Criteria command cannot be run in this environment.
- Stop if Goal, Scope, or Exit Criteria are internally contradictory.

## Falsifier

The direction is wrong if the existing Agent task lifecycle cannot bind the MCP
to an exact active task/session/runtime/AgentRef without accepting model-supplied
identity, or if hosted projection cannot remain strictly redacted and one-way.
The cheapest proof is a focused client test showing zero MCP/network surface for
an ordinary task and for a hosted contract missing grant or redactor.

## Root Cause Evidence

Required when Task Profile is `bugfix`.

- root_cause: `packages/client/src/daemon/agent-memory.ts:352-399,454-467` has three writers for the same bounded audit CAS file, but only save enters the per-home queue. Concurrent recall/recall, recall/save, or recall/snapshot audit reads can overlap; recall also propagates metadata-only audit persistence failure after its source read already succeeded, unlike save's explicit warning disposition.
- repro: `bun run --cwd packages/client test -- src/__tests__/agent-memory-audit-concurrency-p1-regression.test.ts`
- regression_guard: packages/client/src/__tests__/agent-memory-audit-concurrency-p1-regression.test.ts
- pre_fix_failure_artifact: .ai/harness/runs/agent-memory-audit-concurrency-p1-pre-fix.log

## Workflow Inventory

- Source plan: `plans/plan-20260826-1725-agent-memory-phase2.md`
- Deferred-goal ledger: `tasks/todos.md`
- Review file: `tasks/reviews/20260826-1725-agent-memory-phase2.review.md`
- Notes file: `tasks/notes/20260826-1725-agent-memory-phase2.notes.md`
- Checks file: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope gate: edit only paths listed under `allowed_paths`; update this contract before widening scope.
- Completion gate: run `verify-sprint --prepare-acceptance`, record one typed AcceptanceReceipt under the frozen policy below, then run `verify-sprint`; review Markdown is projection only.

## Change Assessment

```json
{"protocol":1,"oracles":[{"id":"agent-memory-contract-suite","kind":"deterministic_test","paths":["*"]},{"id":"agent-memory-native-and-dataplane-readback","kind":"runtime_readback","paths":["*"]}]}
```

## Acceptance Policy

```json
{"protocol":1,"reviewer":"Claude","user_waiver":"allowed"}
```

## Allowed Paths

```yaml
allowed_paths:
  - docs/researches/2026-08-26_long-term-agent-memory-decision-packet.md
  - plans/plan-20260826-1542-context-fold-compaction-poc.md
  - plans/plan-20260826-1645-long-term-agent-memory.md
  - plans/plan-20260826-1725-agent-memory-phase2.md
  - plans/plan-20260826-2240-agent-memory-cross-platform-secure-fs.md
  - tasks/todos.md
  - tasks/contracts/20260826-1725-agent-memory-phase2.contract.md
  - tasks/contracts/20260826-2240-agent-memory-cross-platform-secure-fs.contract.md
  - tasks/reviews/20260826-1725-agent-memory-phase2.review.md
  - tasks/reviews/20260826-2240-agent-memory-cross-platform-secure-fs.review.md
  - tasks/notes/20260826-1725-agent-memory-phase2.notes.md
  - tasks/notes/20260826-2240-agent-memory-cross-platform-secure-fs.notes.md
  - tasks/current.md
  - .ai/harness/
  - .github/workflows/ci.yml
  - docs/architecture/sdk-architecture.md
  - docs/architecture/index.md
  - docs/architecture/requests/root.md
  - packages/client/
  - packages/protocol/
  - packages/cloud/
  - packages/cloud-dataplane/
  - packages/conformance/
  - deploy/sql/
  - tests/sql/control_plane_invariants.sql
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
    - plans/plan-20260826-1725-agent-memory-phase2.md
    - tasks/contracts/20260826-1725-agent-memory-phase2.contract.md
    - packages/client/native/agent-memory-fs/round2_p1_regression_test.go
    - packages/client/native/agent-memory-fs/identity_darwin_test.go
  artifacts_exist:
    - tasks/notes/20260826-1725-agent-memory-phase2.notes.md
  tests_pass:
    - path: packages/client/src/__tests__/agent-memory-audit-concurrency-p1-regression.test.ts
    - path: packages/client/src/__tests__/agent-memory-projection-timeout-p1-regression.test.ts
    - path: packages/client/src/__tests__/agent-memory-helper-ci-p1-regression.test.ts
    - path: packages/cloud/src/__tests__/agent-memory-projection-body-limit-p1-regression.test.ts
    - path: packages/client/src/__tests__/agent-memory-helper-p1-regressions.test.ts
    - path: packages/client/src/__tests__/agent-memory-replay-outcome-p1-regression.test.ts
    - path: packages/cloud/src/__tests__/agent-memory-cross-task-replay-p1-regression.test.ts
    - path: packages/client/src/__tests__/agent-memory-outbox-p1-regression.test.ts
    - path: packages/client/src/__tests__/agent-memory-log-p1-regression.test.ts
    - path: packages/cloud/src/__tests__/agent-memory-erase-epoch-p1-regression.test.ts
    - path: packages/client/src/__tests__/agent-memory-mcp.test.ts
    - path: packages/client/src/__tests__/agent-memory-guidance.test.ts
    - path: packages/protocol/src/__tests__/agent-memory-projection.test.ts
    - path: packages/cloud/src/__tests__/agent-memory-projection.test.ts
    - path: packages/cloud-dataplane/src/__tests__/agent-memory-projection.test.ts
  commands_succeed:
    - cd packages/client/native/agent-memory-fs && GOTOOLCHAIN=go1.26.5 go test ./...
    - bun run check:deploy-sql
    - bun run build
    - bun run typecheck
    - bun run test
    - repo-harness run check-task-workflow --strict
```

## Acceptance Notes (Human Review)

- Functional behavior: local MCP and optional hosted projection preserve local
  Agent-home files as the sole authoring authority.
- Edge cases: identity mismatch, path escape, symlink, stale revision/epoch,
  sequence gap, duplicate mutation, offline replay, and erase all fail closed.
- Regression risks: ordinary tasks, Git workspaces, generic toolsets, truth
  records, and hosted content-read must retain their current behavior.

## Rollback Point

- Commit / checkpoint: `185cf91` before Phase 2 edits.
- Revert strategy: revert the reviewed Phase 2 diff; no dual-read/write
  compatibility path is retained.
