# Task Review: s3b-local-journal

> **Status**: Reviewed
> **Plan**: plans/plan-20260807-2242-s3b-local-journal.md
> **Contract**: tasks/contracts/20260807-2242-s3b-local-journal.contract.md
> **Notes File**: tasks/notes/20260807-2242-s3b-local-journal.notes.md
> **Checks File**: .ai/harness/checks/latest.json
> **Last Updated**: 2026-08-08 08:20
> **Recommendation**: pass
> **Review Rubric Version**: 2
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending

## Human Review Card

- Verdict: pass — two-round gatekeeper review; round 1 FAIL on a single CRITICAL (Node 20 validation ordering: journal construction preceded policy validation, so `JournalUnavailableError` masked `LocalStoragePolicyError`), fixed with dual-Node proof plus a prerequisite `close()` idempotency fix; round 2 closed via dual-leg evidence + `verify-contract` 19/19 + CI as the matrix backstop
- Change type: code-change (daemon durability core, config-gated; default path byte-equivalent)
- Intended files changed: per contract Scope (journal port + SQLite impl + storage policy under `packages/client/src/daemon/journal/`, create-daemon config seam, task-runner admission guard, status surface, cloud ride-alongs, docs)
- Actual files changed: 14 commits via PR #22, merge `5a03c7f`; `connection-manager.ts` zero-diff (contract red line); server/protocol/keys/examples zero-diff machine-checked
- Commands passed: typecheck 6/6; Node 22 full run green (client 934; repo 1912); Node 20.17 client run 896 passed / 38 skipped / 0 failed (policy-rejection test passes on both legs); build 6/6; golden clean; `check-task-workflow --strict`; `verify-contract --read-only` 19/19; CI 28/28 incl. both Node legs and the strace credential-isolation audit
- Residual risks: `noteSkippedSeq` skip path acks unparseable task-classed envelopes without journal coverage (pre-existing, contract-excluded, ledgered in `tasks/todos.md` for a future amendment); doctor/support-bundle consumption of quarantine manifests is S7 scope
- Reviewer action required: none — receipt recorded via acceptance chain
- Rollback: revert PR #22; config-gated integration leaves the default path untouched; no rollback deletes `daemon.db`, WAL files, or quarantine evidence

## Mode Evidence

- Selected route: parent-agent orchestration; explorer pre-mapped anchors (incl. the onEnvelope line-drift correction); two sequential deep-workers (journal+ack, pressure+matrices), fast-worker docs, fast-worker fix round, gatekeeper ×2
- P1/P2/P3 evidence: plan Agentic Routing; the ack-ordering placement decision (handler-chain head, transport untouched) verified structurally by the gate
- Root cause or plan evidence: round-1 CRITICAL root cause named at file:line with the fix position prescribed and taken verbatim

## Verification Evidence

- Waza `/check` run: not used; gatekeeper agent rounds instead
- Commands run: see Human Review Card
- Manual checks: gate independently swept all `advanceCursor` call sites (two; both behind handler success); verified the promise-gate test asserts adapter-idle + wire-silent + cursor-frozen; verified `CleanableCategory` has no protected member and the single deletion statement re-checks eligibility in-transaction; verified emergency latch clears only on computed-normal; verified quarantine renames (incl. -wal/-shm) with manifest and same-millisecond suffixing; verified PRAGMA order (auto_vacuum pre-table)
- Supporting artifacts: PR #22 (https://github.com/Ancienttwo/byok-sdk/pull/22)
- Implementation notes reviewed: yes — incl. the superseded-evidence correction for the Node 20 reading
- Run snapshot: `.ai/harness/checks/latest.json` (materialized by the acceptance chain)

## Manual Check Evidence

- [x] Ack cannot precede the durable commit on any `onEnvelope` path
  - Evidence: journal append at the handler-chain head; both `advanceCursor` call sites post-success; promise-gate + crash points 1/2
- [x] Protected data is unspellable by the cleanup path
  - Evidence: `CleanableCategory` five-member union; `pruneConfirmedJournalTask` is the only deletion and re-checks `truth_state='confirmed' AND recovery_marker IS NULL` inside the deleting transaction

## Acceptance Receipt Projection

> **Disposition**: unavailable
> **Reviewer**: unavailable
> **Source**: unavailable
> **Actor**: not-applicable
> **Reviewed Subject SHA256**: pending
> **Reviewed Subject Scope**: normalized-final-content
> **Reviewed Target Revision**: pending
> **Verification Evidence SHA256**: pending
> **Issued At**: pending

- Summary: No AcceptanceReceipt has been recorded.
- Findings: none

## Behavior Diff Notes

- Hosted-journal mode (opt-in): durable append gates the ack; emergency pressure refuses acks (frozen cursor + mailbox redelivery is the recovery path); hard pressure declines new offers retryably while terminal flush/delete/export continue.
- Default path: byte-equivalent — no journal object constructed, existing suite unchanged.
- No silent downgrade: hosted journal without `node:sqlite` fails construction with a typed error; config validation precedes all runtime-capability construction.

## Residual Risks / Follow-ups

- Skip-path ack gap ledgered (`tasks/todos.md`) for a future protocol-version or S4A retention amendment.
- S7 owns doctor/quarantine-manifest consumption; S4A owns the cloud ports' durable home.

## Scorecard

| Dimension | Score | Notes |
|-----------|-------|-------|
| Functionality | 9/10 | S3.5 boxes 3-9 green; twelve-point matrix complete |
| Product depth | 9/10 | Alpha gate closes with S3; durability is the program's hardest surface |
| Design quality | 10/10 | Structural ack ordering; unspellable never-delete; emergency latch; zero wall-clock assertions |
| Code quality | 9/10 | Repo-first multi-table transactions done carefully; PRAGMA order captured; dual-leg proof |

## Failing Items

- none

## Retest Steps

- Re-run: the six contract `commands_succeed` at repo root
- Re-check: `journal-crash-matrix.test.ts`; `journal-pressure-matrix.test.ts`; `journal-storage-policy.test.ts` on a Node 20 runtime

## Summary

- Sprint S3b delivered: the durable local journal with structural ack ordering, type-enforced cleanup safety, watermark-driven pressure handling, and the full twelve-point crash/disk matrix. Shipped as PR #22, merge `5a03c7f`, CI 28/28 green on both Node legs. Sprint S3 is fully closed and the program alpha-gate conditions are met.
