# Plan: R7 JSONL compaction landing

> **Status**: In Progress
> **Spec**: docs/spec.md
> **Base**: 32f3a80cdfc501a914aef60f2b9759707200e367

## Authority

User approved landing the existing R7 correction. Adopt only the two snapshot
writers, their six regressions and verification notes. Preserve the original
R7 and root WIP. Submit/push and merge after checks; no R8/R9 implementation,
package publication, tag, production migration or deployment.

## P1 / P2 / P3

- P1: AgentMessageOutbox and AgentReliableSpool own JSONL records; atomicWriteFile
  owns replacement and fsync, not record delimiters. Existing exclusive queues
  serialize snapshot and append; protocol/storage schemas are unchanged.
- P2: public append/disposition or append/ack reaches the natural 512-entry
  compaction threshold; a retained final record without newline joins the next
  append, so line-based recovery fails. Regression reopens the real file after
  another append with zero, one and three retained records in both stores.
- P3: terminate every snapshot record with newline, as append already does.
  Empty snapshots stay empty. Keep order/identity, fsync, atomic replacement
  and fail-closed parsing; no salvage heuristic or new format. At 10x traffic
  the same compaction bug occurs sooner, without changing the required fix.

## Task Breakdown

- [x] Confirm prior four-file fingerprints; verify upstream did not change them;
  adopt exact existing correction onto current main in a new isolated worktree.
- [x] Run required checks once on the integrated source; prepare commit/push.
- [ ] Read exact-head CI; merge with HEAD guard; verify the remote merged tree.

## Evidence boundary

The earlier note records old-base evidence. Four-file SHA-256 values match the
existing work exactly. New integrated verification and remote receipts are
reported on this slice's PR, bound to the commit being tested. Already-corrupt
logs are not repaired by this writer correction.

## Integrated local verification

Node 22.22.3 / isolated Bun 1.4.0: build, typecheck, API-surface (nine unchanged
public goldens), version-authority and strict workflow passed. Full workspace
test passed 3841 / 135 skipped (client 1804 / 11 skipped), including all six
natural-compaction append/reopen cases. git diff --check passed. No second
pre-fix reproduction or full test rerun was needed. Remote CI/merge receipts
will be recorded on the PR without mutating the tested source just to log CI.
