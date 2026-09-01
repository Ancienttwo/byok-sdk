# Implementation Notes: issues-112-121-security-reliability-batch

> **Status**: Active
> **Plan**: plans/plan-20260901-1128-issues-112-121-security-reliability-batch.md
> **Contract**: tasks/contracts/20260901-1128-issues-112-121-security-reliability-batch.contract.md
> **Review**: tasks/reviews/20260901-1128-issues-112-121-security-reliability-batch.review.md
> **Last Updated**: 2026-09-01 12:55
> **Lifecycle**: notes

## Design Decisions

- P1 map: the client daemon owns first-pair persistence, URL diagnostics,
  replay-cursor behavior, and blob transfer lifecycle; the reference server
  owns pairing, blob metadata/bytes, outbox and WebSocket epochs; hosted Cloud
  owns HTTP admission and product-consumer composition; cloud-dataplane owns
  cross-process Postgres authority and forward-only SQL.
- P2 trace: every affected input now crosses a single authority before its
  side effect: exact pairing binding -> completion; signed PUT -> declared
  size -> bounded buffer; bearer tenant -> tenant-owned blob; cursor ->
  recoverable floor; WS hello -> admission -> current epoch; message publish ->
  common rate/dedup -> live-task reservation -> immutable disposition; blob
  operation -> per-request deadline/lifecycle signal through body completion.
- P3 decision: fail closed wherever the repository cannot prove recovery. In
  particular, an unknown pending hosted message is never retried or converted
  from elapsed time: an external consumer may still be running. Only the
  reservation owner can write the terminal disposition; retries reject until
  that terminal exists.
- Keep reference-server pairing completion in the existing in-memory pairing
  authority. The reference token signer and pairing codes are already scoped
  to that process lifetime; no second persistence authority was introduced.
- Preserve legacy SQLite blob rows with `tenant_id = NULL` and return 404.
  Missing ownership is not inferred during schema upgrade.
- Keep replay-gap signaling explicit (`cursor_too_old`) rather than deriving
  continuity from sequence gaps, because acknowledgement and terminal
  filtering can create legal non-contiguous sequences.

## Deviations From Plan Or Spec

- Independent review first found three correctness gaps: BlobClient rejected
  without cancelling its body stream, hosted PUT retained chunks plus a second
  full buffer, and hosted message reservation could remain pending while a
  retry was counted as success. All three were fixed before freeze.
- A proposed 30-second pending recovery was rejected in the second gate:
  elapsed time cannot prove an external consumer is dead. The final design
  permanently rejects unknown pending retries and tests a still-running
  consumer after 60 seconds.
- The first frozen root test saw stale generated `dist/runtime.js` and
  `dist/sql` after that design change. A fresh root build regenerated them;
  the unchanged source then passed the full root suite.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Time-based pending recovery | rejected | A slow consumer can outlive the lease and still produce an external side effect. |
| Permanent pending failure | selected | It preserves at-most-once side-effect authority and exposes uncertain completion instead of inventing a result. |
| Chunk list plus final join | rejected | It doubles peak attacker-controlled upload memory. |
| One preallocated bounded upload buffer | selected | The reservation size and deployment ceiling bound the only retained byte buffer. |

## Open Questions

- Production migration/deployment and GitHub issue closure are not part of this
  local commit. They require separate target-bound authorization and runtime
  readback.

## Evidence Links

- Checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Red-first record: `tasks/notes/20260901-1128-issues-112-121-security-reliability-batch.pre-fix.log`
- Focused exact-diff guards: client 6/6, server 12/12, hosted Cloud 8/8.
- Disposable local PostgreSQL: dataplane 3/3 passed without skips, including
  migration 0017 and concurrent/reservation terminal readback. These tests do
  not exercise S3/MinIO.
- Frozen root verification: `bun run build`, `bun run typecheck`, and
  `bun run test` passed; package reports total 3,398 passed and 112 skipped.
- `repo-harness run check-deploy-sql-order` and `git diff --check` passed.
- Independent gatekeeper: final pass after two bounded fix rounds; no remaining
  P0-P2 findings.
- `repo-harness run verify-sprint --prepare-acceptance` fulfilled all 30
  contract checks for subject
  `sha256:eb66a7ce6ffbfbbcc6c58b203f7f1ae3ad053212882289b436a7fa5ce3746894`.
- `codex@openai-codex` 1.0.5 was enabled and read back at user scope. The retry
  stayed bound to base `d8df33e6f99d051877e3d825773e000b50eefe3c` and subject
  `sha256:eb66a7ce6ffbfbbcc6c58b203f7f1ae3ad053212882289b436a7fa5ce3746894`,
  but `repo-harness` rejected it before provider invocation with
  `review_budget_exhausted`: the original disabled-provider admission had
  already consumed the one semantic-review budget. The owner then explicitly
  authorized a `user_waiver`; repo-harness recorded and verified a protocol-2
  AcceptanceReceipt for the same subject with verification evidence
  `sha256:ed1b24234598c4fb7acf382e2c40bc460ceb20263947c4eb25fd23f22596adb7`.
  This is owner acceptance, not an `external_pass` claim.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- Promote to `tasks/lessons.md` only after a repeated correction or failure pattern.
- Promote to `docs/researches/` only when it is durable repo knowledge with evidence.
- Promote to harness asset files only after verification across more than one task or fixture.
