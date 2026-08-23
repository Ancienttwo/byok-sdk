# Implementation Notes: agent-first-home-contract

> **Status**: Review
> **Plan**: plans/plan-20260823-1214-agent-first-home-contract.md
> **Contract**: tasks/contracts/20260823-1214-agent-first-home-contract.contract.md
> **Review**: tasks/reviews/20260823-1214-agent-first-home-contract.review.md
> **Last Updated**: 2026-08-23 13:32
> **Lifecycle**: notes

## Design Decisions

- The public local input is one absolute `hostStorageRoot`. SDK code alone
  composes `<hostStorageRoot>/agents/<validated-agentId>`; the earlier host
  resolver design was removed before completion.
- `task.offer_for_agent` is distinct from legacy offers and is admitted only
  after durable/live (composition-appropriate) `agent-home-contract`
  capability evidence. `workspaceHint` remains reserved and ignored.
- Agent home is the runtime cwd. The SDK creates missing `MEMORY.md` and
  `notes/` without overwriting existing bytes and reserves only `.byok` for
  lease/session evidence. Every other Agent file is opaque; `artifacts` is not
  a required directory or content schema.
- Resume checks exact AgentRef/profileRevision/session/runtime/cwd before the
  downstream projection hook runs. Terminal evidence is fsynced before the
  corresponding Agent terminal envelope becomes externally visible. Claimed
  failures before active-session registration use a separate task-addressed
  JSONL receipt and still echo the exact AgentRef.
- One canonical home has one writer. Restart reclaims a crash marker only for
  the exact stable daemon store/product owner and canonical Agent identity;
  another owner or corrupt marker fails closed.

## Deviations From Plan Or Spec

- User correction replaced the initial downstream resolver with SDK-owned
  path composition. Plan, contract, code, tests, and responsibility docs were
  amended together; no compatibility resolver remains.
- Strict workflow required adding migration 0012 to
  `tests/sql/control_plane_invariants.sql`; the contract allowed path was
  widened to that exact invariant file before editing it.
- The first semantic gate found two fail-closed gaps: an in-root Agent symlink
  could alias another Agent after daemon restart, and pre-registration adapter
  start/handoff failures omitted AgentRef and local terminal evidence. The
  layout now materializes the exact lexical Agent segment before realpath, and
  both failure boundaries fsync task-addressed evidence before `task.fail`.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Optional AgentRef on legacy offer | Rejected | An old daemon could strip it and run under task workspace authority. |
| Downstream path resolver | Rejected | It would duplicate canonical path authority and permit product-specific joins. |
| Agent-home root vs `workspace/` child cwd | Agent-home root | One durable authority exposes memory, notes, and opaque files without a second workspace owner. |
| Literal `artifacts/` directory | Rejected | Artifact is an ownership category; names and content remain downstream/Agent semantics. |

## Open Questions

- Hosted Agent enqueue reserves exact task identity before mailbox append to
  serialize concurrent retries. A mailbox failure can leave an un-delivered
  offered attempt; retry with the same explicit taskId converges, while an
  auto-generated taskId can leave bounded orphan state for ordinary retention.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Targeted Agent suites: 29 Agent-contract tests passed across
  protocol/server/cloud/cloud-dataplane/client; the client suite has 15 tests
  including three real adapter cwd receipts.
- Postgres runtime oracle:
  `packages/cloud-dataplane/src/__tests__/agent-home-contract.test.ts` passed
  against the disposable migrated compose substrate. It writes durable device
  capabilities plus task AgentRef/owner/terminal cause, then reads the exact
  rows through a fresh pool/store composition and rejects cross-tenant reads.
- Full required dataplane mode with `BYOK_REQUIRE_DATAPLANE=1`: 24 files and
  289 tests passed; 5 explicitly non-applicable tests skipped. This is runtime
  Postgres/MinIO evidence, separate from migration/static SQL checks.
- The first acceptance preparation found the harness treats `deploy` as a
  subject-wide irreversible-risk category. The declared runtime oracle was
  widened from two implementation directories to the normalized final subject;
  its executable command remains the mandatory disposable-Postgres readback,
  not a documentation or static-SQL assertion.
- Full `bun run test`: client 1339, cloud 192, cloud-dataplane 74 (83 live
  tests skipped), conformance 141, core 251, protocol 293, server 247, and all
  remaining package suites passed.
- `bun run build`, `bun run typecheck`, `git diff --check`, strict workflow,
  and strict contract verification passed; contract verification reported
  `total=19 failed=0 status=Fulfilled`.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- The durable authority correction is recorded in
  `docs/researches/agent-identity-placement-decision.md` and the canonical host
  integration contract is `docs/host-local-storage-layout.md`.
