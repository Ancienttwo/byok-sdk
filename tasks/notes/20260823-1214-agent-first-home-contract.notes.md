# Implementation Notes: agent-first-home-contract

> **Status**: Review
> **Plan**: plans/plan-20260823-1214-agent-first-home-contract.md
> **Contract**: tasks/contracts/20260823-1214-agent-first-home-contract.contract.md
> **Review**: tasks/reviews/20260823-1214-agent-first-home-contract.review.md
> **Last Updated**: 2026-08-23 15:34
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
  downstream projection hook runs. Terminal evidence is normally fsynced
  before the corresponding Agent terminal envelope becomes externally
  visible. After three bounded failures the daemon emits an explicit host
  audit signal, still publishes the exact AgentRef terminal, retries during
  cleanup, and releases the lease so neither cloud state nor the Agent home is
  stranded. Claimed failures before active-session registration use a
  separate task-addressed JSONL receipt and the same bounded-degradation rule.
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
- The first external Claude acceptance review found three P1 gaps in the
  frozen candidate: long-poll never projected `agent-home-contract`, the
  in-process lease claim started after an async preflight, and permanent local
  terminal-evidence failure could leave a claimed/running cloud task and lease
  indefinitely active. The remediation uses one shared WS/long-poll hello
  constructor and authenticated HTTP admission, synchronously reserves the
  canonical home before the first await, and applies bounded observable
  terminal-evidence degradation. No legacy workspace fallback was added.
- The later RAFT local/cloud projection probe corrected a topology
  overgeneralization: recovered RAFT is cloud-orchestrated/local-executed, but
  ordinary activity is contentful and immediately projected rather than a
  uniform durable-local/redact/upload pipeline. The current Agent-home slice
  therefore claims only local home/session authority. The generic typed egress,
  reliable-vs-latest delivery, quota, sanitizer, and explicit content-read
  contract is recorded in
  `docs/researches/agent-local-cloud-projection-contract.md` as a separate
  unimplemented work-package, not as behavior delivered by this contract.
- A second full-diff Claude acceptance pass found three further P1 gaps:
  deterministic Agent mismatch declines were incorrectly retryable, a daemon
  could advertise Agent capability before proving its root usable, and hosted
  cloud omitted `task.decline` from exact AgentRef enforcement. Remediation
  makes only a live same-home writer conflict retryable, write-probes the
  canonical root before hello, and gates decline identity exactly. Closely
  related advisories were also closed: hosted hello now requires the frozen
  protocol version, SQL rejects a single backslash, Agent/Git workspace
  authorities are mutually exclusive, mailbox append failure closes its
  reserved Agent attempt, offer type is the strict-Agent authority, and lease
  release failure no longer strands `activeTaskCount`.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Optional AgentRef on legacy offer | Rejected | An old daemon could strip it and run under task workspace authority. |
| Downstream path resolver | Rejected | It would duplicate canonical path authority and permit product-specific joins. |
| Agent-home root vs `workspace/` child cwd | Agent-home root | One durable authority exposes memory, notes, and opaque files without a second workspace owner. |
| Literal `artifacts/` directory | Rejected | Artifact is an ownership category; names and content remain downstream/Agent semantics. |

## Open Questions

- None inside the Agent-home contract. Typed local/cloud egress remains a
  separate work-package in `tasks/todos.md`, not an unfinished Agent-home path.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Targeted remediation suites passed: protocol 3, server 5, hosted cloud 6,
  client 31, and disposable-Postgres Agent readback 1. The client selection
  includes real reference-server and hosted-cloud long-poll Agent dispatch,
  same-process lease overlap, terminal-evidence outage, and adapter cwd paths.
- Postgres runtime oracle:
  `packages/cloud-dataplane/src/__tests__/agent-home-contract.test.ts` passed
  against the disposable migrated compose substrate. It writes durable device
  capabilities plus task AgentRef/owner/terminal cause, then reads the exact
  rows through a fresh pool/store composition and rejects cross-tenant reads.
- Exact required dataplane command first refused to run because the shell had
  no substrate URLs. After the repository disposable Postgres/MinIO compose
  became healthy, the same command with both fixed test endpoints passed its
  Agent-home runtime readback (1 file / 1 test); the disposable containers and
  network were then removed. This is runtime evidence, separate from
  migration/static SQL checks.
- The first acceptance preparation found the harness treats `deploy` as a
  subject-wide irreversible-risk category. The declared runtime oracle was
  widened from two implementation directories to the normalized final subject;
  its executable command remains the mandatory disposable-Postgres readback,
  not a documentation or static-SQL assertion.
- The first full-suite remediation run found three stale behavior assertions:
  two shutdown-drain counts and one chunking count assumed long-poll queued no
  opening hello. The tests now wait for the hello when isolating one stalled
  terminal, and count task ids separately while proving the hello shares the
  capped outbox. Their focused rerun passed 2 files / 4 tests.
- Fresh full `bun run test`: client 1347, cloud 194, cloud-dataplane 74 (84
  substrate-dependent tests skipped in ordinary mode), conformance 141, core
  251, protocol 293, server 248, and all remaining package suites passed.
- `bun run build`, `bun run typecheck`, `git diff --check`, strict workflow,
  and strict contract verification passed; contract verification reported
  `total=19 failed=0 status=Fulfilled`.
- Post-review remediation focused gates passed: client 6 files / 34 tests,
  cloud 1 / 8, server 2 / 22, protocol 3 / 70, plus monorepo typecheck.
- The disposable-Postgres oracle passed again after migration 0012 changed;
  it now also proves a single-backslash Agent id is rejected by the actual
  `task_agent_ref_bounded` constraint and leaves no task row.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- The durable authority correction is recorded in
  `docs/researches/agent-identity-placement-decision.md` and the canonical host
  integration contract is `docs/host-local-storage-layout.md`.
