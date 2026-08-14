> **Archived**: 2026-08-15 02:05
> **Related Plan**: plans/archive/plan-20260815-0102-win32-measured-quiescence.md
> **Outcome**: Completed
> **Lifecycle**: notes
> **Parent Run ID**: run-20260815-0205

# Implementation Notes: Measured Windows Process-Tree Quiescence

> Plan: `plans/plan-20260815-0102-win32-measured-quiescence.md`
> Contract: `tasks/contracts/20260815-0102-win32-measured-quiescence.contract.md`

## What changed

Windows disposal no longer reads taskkill's exit status. `taskkill /T /F` output
is parsed for the pid set it reported walking, and disposal polls that set with
`process.kill(pid, 0)` until every member reports `ESRCH` — the structural mirror
of the POSIX `groupExists` branch. `close` remains the final receipt on both
platforms, as the stdio-flush guarantee rather than the liveness proof.

- `packages/client/src/adapters/taskkill-pid-set.ts` — new pure extractor.
- `packages/client/src/adapters/process-tree.ts` — `requestOwnedProcessTreeTermination`
  is now async and returns the measured pid set via a single
  `WeakMap<ChildProcess, {requested, acceptedPids}>`; the two WeakSets are gone.
- Three runtime clients adjusted to the async signature (fire-and-forget, see below).

## Decisions worth carrying forward

**The daemon's own pid must be excluded explicitly.** taskkill names the root's
parent on the root's own line (`PID <root> (child process of PID <daemon>)`).
Plain co-occurrence therefore accepts this process, and `process.kill(self, 0)`
always succeeds — quiescence would be unreachable by construction and every
win32 disposal would end in a false `stage:'quiescence'` failure. `walkTaskkillPidSet`
takes `excludedPids` for exactly this; the win32 caller passes `[process.pid]`.
Deleting that argument turns 4 of the 6 win32 seam tests red (verified).

**No localized-word parsing.** taskkill's messages are translated; only the
integers and their per-line co-occurrence are stable. Output is decoded latin1
because every OEM codepage encodes ASCII digits as single bytes 0x30-0x39 and no
DBCS trail byte (CP932/936/949/950 all start at 0x40) can land in that range.

**Exit status carries no authority.** `stage:'signal'` now means only that
taskkill could not be spawned. A non-zero taskkill against an already-dead root
is quiescence, which is what commit 44517be worked around with a WeakSet; the
measured poll makes the workaround unnecessary rather than reworking it.

**Interrupt paths stay fire-and-forget.** `kill()` on all three clients voids the
promise. A request that could not be spawned leaves `requested` false, so
`dispose()` re-issues it and raises the typed failure there — nothing is lost by
swallowing it at the interrupt. Because `requested` only flips after the await, a
`dispose()` racing an in-flight `kill()` legitimately issues a second taskkill
against the same root; both writes land in the same Set, so the measured set is
their union.

**win32 has no `isClosed()` short-circuit** (gate finding F1). A root that exits
on its own orphans descendants Windows never re-parents; skipping the walk there
let disposal resolve in ~1ms with zero taskkill spawns and a live descendant —
quiescence claimed but never measured. At least one walk now precedes every
quiescence claim. POSIX keeps its short-circuit: the group signal is already the
whole-tree operation.

**Each phase carries its own full grace** (gate finding F2). The win32 close wait
gets a fresh `killGraceMs` rather than the remainder of the quiescence poll's
budget, matching POSIX, where the SIGTERM, SIGKILL and close waits each carry
their own. A slow drain can no longer starve the close wait.

## Fixture receipt contract (CI regression, run 31824908529)

Moving the pid receipt to the descendant — the only process that knows the
grandchild's pid — broke an invariant nothing had written down: the receipt used
to exist before the root emitted any protocol frame, because the root wrote it
itself. `scripts/adapter-task-smoke.mjs` reads the file exactly once, with no
retry, as soon as the task reports `started`, so the asynchronous write turned
into an ENOENT on all three OSes. The unit tests missed it because
`runtime-process-tree.test.ts` polls.

`src/__tests__/fixtures/process-tree-receipt.mjs` now owns the contract: it
spawns levels 2 and 3 and blocks (bounded, 5s, fail-closed) until the complete
receipt is on disk, and the descendant publishes it by rename so no reader can
see a partial write. Do not make that spawn fire-and-forget again. The smoke now
also asserts the grandchild, so its evidence covers all three levels.

## Residual boundary (documented in the module, restated here)

A descendant whose intermediate parent died before any sweep observed it is
unreachable: Windows does not re-parent orphans, so `taskkill /T` cannot find it.
The same window admits pid reuse reading as alive. Preventing orphans left by a
*daemon* crash needs a job object and is out of scope for this stage.

## Not delivered

The `scripts/release/check-package-graph.mjs` purity rule. Two separate reasons,
both needing a decision outside this work package — see the handback report:

1. `StrictWorktreeGuard` refuses edits to `scripts/release/` outside a linked
   contract worktree.
2. As specified (transitive closure), the rule fails **today**: `@earendil-works/pi-coding-agent`
   pulls in `@earendil-works/pi-tui` (ships `win32-console-mode.node`),
   eight `@mariozechner/clipboard-*` native addons, `@google/genai` (preinstall)
   and `protobufjs` (postinstall). Scoped to **direct** dependencies it passes
   clean (0 findings). A validated prototype of both scopes is in the session
   scratchpad.
