# Plan: R9 refused required message terminal convergence

> **Status**: In Progress
> **Spec**: docs/spec.md
> **Base**: 0b307202d98daad1dc00e67f983a6532e806ade3

## Authority

User approved the R9 slice. Preserve unrelated WIP in an isolated worktree;
fix, verify, commit and push the bounded correction. R8 and release remain separate.

## P1 / P2 / P3

- P1: AgentMessageOutbox owns immutable draft/disposition persistence. TaskRunner
  owns execution terminal reservation and finish/disposal. Cloud owns the product
  disposition; held is not refusal. No public API or storage format changes.
- P2: inbound agent.message.disposition -> exact applyDisposition + fsync ->
  active refused branch previously revoked context and stopped retries only.
  turn_end then parked completion forever. Cancellation can finish while the
  disposition write is awaited, so the captured active identity must be rechecked.
- P3: after durable refusal clear parked completion and call existing fail().
  Existing semantic reservation arbitrates cancellation, completion and timeout;
  existing finish retains ownership until disposal and terminal commit succeed.
  Retain refused bytes and original reasonCode in the outbox, without publishing
  arbitrary consumer reason text as a new SDK failure contract. At 10x load the
  old behavior consumes all execution slots; no new queue/authority is needed.

## Task Breakdown

- [x] Trace current source and reproduce active task leak before production edit.
- [x] Add before/after turn_end and deterministic cancellation race regressions.
- [x] Route refusal through existing failure/disposal and recheck post-write identity.
- [ ] Run required integrated checks, then commit/push and read exact-head CI.

## Root Cause Evidence

- Trigger: an exact refused required Agent message disposition on an active execution.
- Observed failure: pre-fix regression retains activeTaskCount=1 before/after turn_end;
  close spy stays at zero in the refusal-close scenario.
- Cause: refused branch returns without semantic terminal reservation or finish.
- Guard: real Agent-home/outbox integration, durable disposition, public runner
  envelope entry, turn_end, close barrier and applyDisposition barrier; assert one
  terminal, one close, zero active tasks, expired token and retained nonretryable draft.

## Validation

Focused completion gate: 15 passed on Node 22.22.3 / Bun 1.4.0. Initial test harness
cleanup called a nonexistent method; corrected to shutdownActiveTasks before
capturing the semantic pre-fix failure. Early standalone typecheck requires the
remaining workspace packages built; final checks run after the full build.

## Integrated verification

Build, typecheck, API surface (nine unchanged goldens), version authority,
strict workflow and diff whitespace checks pass. The full test invocation
stopped at client: 1807 passed / 11 skipped / one failed. Failure was the
unchanged runtime-detection-observation timeout fixture: PID receipt ENOENT.
That file passed all 30 tests when rerun alone; no source/test change was made
there. Remaining workspace suites passed 2037 / 124 skipped. The R9 completion
suite passed all 15 tests in the integrated client invocation. This is not a
claim that the original full test command passed. Exact-head remote CI remains
the next verification boundary; record its result on the PR without changing
source only to log a remote receipt.
