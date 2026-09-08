# Plan: R10–R13 durable egress and message lifetime

> **Status**: Completed
> **Spec**: docs/spec.md
> **Base**: 7659bce6f76c9fe288fea9d7cacc96ac4408ce8c

## Authority and scope

User requested fixes for all R10–R13, using Downloads/byok-release-review-7659bce.
These are review labels, not GitHub issue numbers. Isolated worktree preserves
unrelated original WIP. No version/publication/deployment or broad TaskRunner split.

## P1 / P2 / P3

- P1: message outbox owns draft/activation/disposition; spool owns reliable
  event/exact ACK; CursorStore owns inbound processed cursor. TaskRunner owns
  token, startup and terminal/disposal. Filesystem helper owns mechanics only.
- P2: append allocates identity -> write -> sync -> close -> update memory.
  Errors after bytes land leave memory unaware; another append duplicates durable
  identities. CursorStore -> atomicWriteFile omitted fsync; ConnectionManager
  awaits save before publishing its cursor, so failure must propagate there.
  Tool token -> append await -> activate await -> send captured a stale task;
  startup and pump cross the same outbox boundary. Cancellation reserves terminal
  synchronously, then persists evidence before emitting task.cancelled.
- P3: quarantine the writer after uncertain append/replacement errors. Reopen
  validates complete JSONL and flushes recovered bytes before receipts; partial
  frames remain preserved and explicitly rejected. Fixed eventId retries compare
  exact immutable contents. Shared durable file helper does not parse domain data.
  Local revoke entries in the existing outbox fence recovery without synthesizing
  a host refusal. Queue-time activation checks and one send gate serve all authors.
  Cancellation waits for durable revocation before its terminal. Refused/revoked
  evidence is excluded from send quota; held still occupies it. Explicit archive
  copies complete evidence durably before live-log compaction, never auto-deletes.
  At 10x volume disk/audit retention and per-home serialized fsync dominate;
  finite disk still requires operator archival, not an unbounded second queue.

## Task Breakdown

- [x] Verify downloaded evidence and exact base; preserve original worktree.
- [x] Trace storage/confirmation and publish/cancellation/recovery authorities.
- [x] Capture pre-fix regressions on Node 22.22.3.
- [x] Implement narrow storage, quota/archive and lifecycle convergence.
- [x] Verify uncertain append, durable replacement, retention and cancellation races.
- [x] Run required integrated checks and record source-bound evidence.

## Root Cause Evidence

- Trigger: full append followed by write/sync/close EIO; missing fsync at cursor
  save/compaction; many refused messages; cancel while tool append/activate waits.
- Observed failure: initial storage suite 8/8 failed (six retries resolved instead
  of quarantining, cursor save resolved with injected sync failure, refusal quota
  exhausted). Three real-runner cancellation tests returned pending after cancel.
- Cause: memory commit and I/O receipt were conflated; atomic rename mistaken for
  durable replacement; retained audit body charged as send backlog; stale closure
  authorization across async mutation boundaries.
- Guard: real fs fault injection, exact identity/conflict/reopen assertions,
  natural compaction, delayed barriers and real TaskRunner cancellation/recovery.
  The downloaded Linux/Node 22.16.0 probe is source evidence only; local new tests
  use pinned Node 22.22.3. Neither establishes physical power-loss or native Windows.

## Completion evidence

See `docs/researches/2026-09-08-r10-r13-durability.md` for input provenance,
regressions, operational boundaries and local source verification. Final local
Node 22.22.3 / Bun 1.4.0: 3,882 passed, 135 skipped; all six required checks pass.
The API golden delta contains private declarations only. Candidate PR/CI readback
remains a distinct remote acceptance boundary; no main merge or release authority.
