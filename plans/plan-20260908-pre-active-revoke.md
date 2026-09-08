# Plan: Pre-active staged message cancellation

> **Status**: In Progress
> **Spec**: docs/spec.md
> **Base**: 62e83ae9ac76e38b5448307fec02850f780d7347

## P1 / P2 / P3

- P1: TaskRunner owns startup cancellation, terminal emission and lease release;
  startOwnedRuntime owns late Session cleanup receipts; outbox owns durable revoke
  and projects send quota/archive eligibility. No protocol or storage redesign.
- P2: pending MCP token -> appendDraft -> staged -> task.cancel -> startup abort
  or rejection -> two catch branches emitted cancelled without revoke -> finally
  released ownership while staged evidence remained charged after restart.
- P3: both pre-active branches use the existing startup owner with an idempotent
  settlement barrier before disposal/terminal-commit/release. Capture terminal
  identity while the offer owns it. Failed revoke retains ownership and existing
  retry behavior; it cannot fabricate cancellation completion. At 10x volume,
  audit disk retention remains an explicit archive responsibility, not send quota.
  Ordinary failure after send and active cancellation stay unchanged.

## Task Breakdown

- [x] Trace exact merged source and preserve dirty original checkout.
- [x] Reproduce staged-before-Session leak before production edits.
- [x] Cover cancellation branches, revoke failure, >64 repeats and archive/reopen.
- [x] Implement narrow durable startup settlement and run required checks (full suite has two timeouts).
- [x] Freeze candidate for the user-authorized follow-up PR.
- [ ] Obtain successful exact-head CI before acceptance.

## Root Cause Evidence

- Trigger: stage a real outbox draft while StubRuntimeAdapter blocks Session return,
  cancel before releasing start, then deliver and close the late Session.
- Observed failure: on base, cancellation terminal exists but reopened retryable
  records length is 1 rather than 0 (before.log, Node 22.22.3).
- Cause: both startup catch cancellation branches bypassed outbox revoke, and
  finally released the lease without a durable message settlement barrier.
- Guard: real TaskRunner/home/outbox test checks no terminal before revoke, retained
  ownership on error, 65 cancellations, restart budget and explicit archival.

The new acceptance ZIP was not found in Downloads or /mnt/data. The user report
is input evidence; the local regression above is independently executed.

## Verification boundary

Node 22.22.3 / Bun 1.4.0. Build, typecheck, API surface (9 goldens), version
and strict task-workflow checks passed before the final synchronous token
revocation addition. The final focused run covers that addition. No public API
or version changes. Full workspace test stopped in client: 1,838 passed,
11 skipped, 2 timed out (spool natural compaction retaining 3 records; outbox
natural compaction temp-sync fault). Both hit the unchanged 10-second limit;
no timeout or assertion was relaxed. This is not a full-suite pass. Following
the user's hard-stop instruction, no unrelated production or test fix was made.
The user subsequently requested PR creation with these limitations retained.
