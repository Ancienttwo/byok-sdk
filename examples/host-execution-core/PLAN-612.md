# K4 Host jobs — issue #612

Baseline: `7f34c457`, branch `fix/612-unknown-wake-audit`.
Planning was performed through a Claude Herdr session before implementation.
This file records the final implementation decisions; no SDK/runtime protocol changes.

## P1: Map

`core.ts` owns wake consumption, lifecycle entrypoints, recovery and serialized drain.
`routines.ts` owns calendar/reservation/slot admission; `model.ts` owns the ledger types.
`ledger.ts` owns synchronous SQLite commits and explicit retention. `transitions.ts`
remains the Agent intent/FIFO authority. The embedded SDK owns one-shot wake delivery.
The example and its guide/spec paragraphs are the scope. The changed K4 types also
require one bounded downstream fix in the MCP example: explicit Agent-only guards
and a type-only test assertion. No MCP tool capability is added.

## P2: Trace

`addRoutine` validates exactly one execution or registered Host job and commits a
successor reservation/outbox. SDK delivery enters `consume`; reservation validation,
occurrence, slot dedup and successor commit together. A Host job adds a durable outbox
row instead of an intent. `drain` invokes its handler outside SQLite and atomically
commits the summary plus either a succeeded occurrence or an Agent FIFO intent.
Exceptions retain the pending row and error and reject the drain after other work.
`recover` restores missing wakes and drains pending work; committed results never rerun.

## P3: Decision and refinements

Reuse routine identity/lifecycle/calendar, never add a prefix router or second scheduler.
The pending outbox is the single authority for jobs awaiting results; no parallel pending
flag or persisted running lease is needed for this single-owner serialized reference.
Unlike Agent intent coalescing, admitted Host jobs are not silently superseded: every
admitted job must produce its result. A late escalation is superseded if a newer slot
already committed. Its execution cutoff is stored on the old job so compaction of
the newer occurrence cannot erase it. Pause stops new slots and lets admitted work finish.

The initial planning pass suggested not rejecting failed handlers. Final decision:
reject and retain the row, preserving SDK retry and making failure observable. External
effects are at least once; pass the stable occurrence key to Host idempotency storage.
Keep summaries small under Host policy rather than introduce an arbitrary size limit.

Make occurrence intentId optional and use mutually exclusive definition types. Existing
test changes are type-only non-null assertions and fixture return types. Runtime
assertions, deadlines and skip conditions remain unchanged. Add explicit Host-only
occurrence compaction using the existing transactional slot tombstones; do not infer
acknowledgement from age. Unknown occurrence selections reject atomically.

Reserve the entire `host-scan:` namespace and audit non-current deliveries as
`stale_scan`; both stale and unknown diagnostics share the existing bounded ring.
Document unsalted hashes, audit retention and replay after tombstone expiry.

At 10x volume, serialized external handlers and whole-JSON SQLite rewrites fail first.
This remains a small single-owner copy-and-own example. Long handlers can exceed the
SDK hook deadline and delay dispatch; shutdown signals cancellation and waits for them.

## Task Breakdown

- [x] Public job definition/handler/result types and fail-closed validation.
- [x] Atomic occurrence admission, durable handler work, optional Agent escalation.
- [x] Lifecycle/recovery/replay guards and explicit Host-only compaction.
- [x] Tests for scheduler delivery, failure/reopen, concurrent replay, lifecycle,
      promotion, invalid contracts, missing registration, audit and compaction.
- [x] README, guide and product spec updated.
- [x] Local checks and self-review recorded in `VALIDATION.md`, including the
      out-of-scope client test failure.

Publication contract: commit/push the lane branch and open a non-draft PR (`Refs #612`).
