# Implementation Notes: issue-109-control-backpressure

> **Status**: Complete
> **Plan**: plans/plan-20260901-0409-issue-109-control-backpressure.md
> **Contract**: tasks/contracts/20260901-0409-issue-109-control-backpressure.contract.md
> **Review**: tasks/reviews/20260901-0409-issue-109-control-backpressure.review.md
> **Last Updated**: 2026-09-01 04:30
> **Lifecycle**: notes

## Design Decisions

- `handleConnection` owns one private outbound writer beside its existing #108 request registry; no global queue or alternate transport authority was introduced.
- Every frame is encoded and byte-checked before a direct write. A frame larger than the 1 MiB cap closes immediately, so the first direct frame cannot bypass the memory limit.
- A false `socket.write` makes the writer blocked. Subsequent frames enter one FIFO queue only while its retained bytes remain at or below 1 MiB; `drain` flushes in arrival order and re-enters blocked state if another write returns false.
- Queue overflow, synchronous write failure, socket error, and close all converge on one terminal connection teardown that clears queued output/listeners and aborts active stream controllers. A real authenticated connection deterministically emits an asynchronous server-socket `error` after `write(false)` has queued output, proving this runtime path rather than inferring it statically. `emit` remains synchronous and unchanged.

## Deviations From Plan Or Spec

- None recorded.

## Tradeoffs Considered

| Option | Decision | Reason |
|--------|----------|--------|
| Per-connection writer with a 1 MiB retained-byte cap | selected | Socket backpressure and stream teardown are connection-local authority; a fixed bound is observable and fail-closed. |
| Async `emit` or handler-visible flow control | rejected | It changes the public control method contract and would distribute one transport concern across all producers. |
| Direct writes after `false` or a buffering fallback | rejected | It violates the Node backpressure boundary and creates unbounded/ambiguous delivery behavior. |

## Open Questions

- Long-lived streams that continuously outrun a peer are intentionally disconnected once the fixed connection budget is exhausted; replay, cancellation RPCs, and cross-connection delivery are separate product decisions.

## Evidence Links

- Pre-fix deterministic artifact: `tasks/notes/20260901-0409-issue-109-control-backpressure.pre-fix.txt` contains the authenticated fake-write regression on `42a8b92`, with `PRE_FIX_EXIT=1` and the observed second write before `drain`.
- Focused runtime/deterministic guard: `bun run --cwd packages/client test -- src/__tests__/control-server.test.ts` passed, 1 file / 30 tests. It covers false→drain FIFO ordering, direct oversized output, blocked queue overflow, disconnect-before-drain listener cleanup, synchronous write failure, and an asynchronous server-socket `error` after queued output; each terminal test uses a real authenticated connection and checks stream abort.
- `bun run build`, client typecheck/build, root typecheck, root test, `repo-harness run check-task-workflow --strict`, and `git diff --check` passed on this candidate.
- No AcceptanceReceipt was recorded. The frozen Protocol-2 `Codex` / `codex-plugin` policy is a later independent acceptance boundary and does not authorize merge, push, PR, issue closure, publish, deploy, or production mutation.

## Residual Risks

- The 1 MiB cap is per connection, so many concurrent authenticated connections retain independently bounded memory; existing half-open admission remains the only global connection limiter in this module.
- Kernel-level socket buffering is outside this JavaScript retained-byte cap; the writer correctly stops issuing application writes after Node reports backpressure.

## Promotion Filter

Promote a candidate to `tasks/lessons.md`, `docs/researches/`, or harness asset files only when all three hold: hard to reverse, surprising without local context, and a real trade-off existed. If any one is missing, keep it in this notes file instead.

## Promotion Candidates

- No promotion candidate: this is a local transport invariant already captured in the active plan/contract and the existing local concurrency/I/O boundary note.
