# Implementation Notes: chat-history-storage-retention

> **Status**: Active
> **Plan**: plans/plan-20260925-0213-chat-history-storage-retention.md
> **Contract**: tasks/contracts/20260925-0213-chat-history-storage-retention.contract.md
> **Review**: tasks/reviews/20260925-0213-chat-history-storage-retention.review.md
> **Last Updated**: 2026-09-25 02:40
> **Lifecycle**: notes

## Design Decisions

- Docs-only landing of two external memos' conclusions (2026-09-24/25) as rulings with revisit triggers; no code, wire, schema or spec sentence changed. Spec principle sentences are a PROPOSAL in the research doc §8 for the Owner.
- Owner order 2026-09-24 (P0 → official Pi 0.87.1 migration → SummaryJob) left unchanged; every storage item is a deferred ledger row behind a measurement.
- SummaryJob trigger expressed in `artifact.requestBytes` against the Host-ruled bound already on the receipt; no new metric.

## Deviations From Plan Or Spec

- Plan T1 listed `docs/spec.md` line numbers from the stale main checkout; the worker re-located every citation against origin/main @ ad22b89c (e.g. no-TTL rule at `docs/spec.md:148-151`, eight-Turn cap at `:2113-2115`). The doc cites the real lines.
- The admission migration lives at `deploy/sql/0017_agent_message_admission.sql`, not under `packages/cloud-dataplane/src/sql/`; cited accordingly.
- Preparation records carry no conversation id or Turn ordinal; the §5.2 jq runbook groups by `key.scopeId` + `key.agentRef` ordered by `createdAt` and states that it may mix Conversations under one agent, and must run before record GC.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Run the quantification now | Deferred (ledger row) | No populated database on this machine on 2026-09-25 (`pg_isready` no response; no Salesko `.env`). |
| Schedule SDK `terminal_body` dedup as the next storage slice | Deferred behind measurement | Store-representation migration with replay-equivalence proof carries risk; no volume exists to justify it. |
| Write spec principles directly | Proposal only | `docs/spec.md` is product truth; an Owner edit. |

## Open Questions

- None blocking. The dedup threshold is set by the Owner after the first measurement.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Citation spot-check (orchestrator, 2026-09-25): `docs/spec.md:148-151` (no TTL/deletion path), `docs/spec.md:2113-2115` (eight unsettled Turns are a Host choice), `packages/client/src/daemon/agent-message-outbox.ts:251` (`logEntries >= 512`), `deploy/sql/0017_agent_message_admission.sql:11-13` (`CREATE TABLE agent_message_admission`) — all hold at ad22b89c.
- Contract checks run: `git diff --check` clean; `cited-files-exist` → CITED_FILES_OK; `cited-lines-hold` → CITED_LINES_OK; `repo-harness run check-task-workflow --strict` → `[workflow] OK`; `no-ai-attribution` runs after the commit.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- None; the research doc is itself the promoted artifact.
