# R7–R9 source probe verification

Date: 2026-09-07. Scope: verify the supplied review, no implementation or GitHub mutation.

## Subject and provenance

- Input: `/Users/kito/Downloads/byok-review-r7-r9.zip` and extracted sibling directory.
- Live `git ls-remote origin refs/heads/main`: `0c70396dbec8cc70a354ac7d7222b25cc92b9469`.
- Current checkout: `1dcbff5`, with existing concurrent changes preserved.
- All seven included TypeScript files matched both the supplied Git blob manifest and the corresponding blobs at remote main. This verifies source identity; the CI artifact download and release manifest were not independently repeated.
- Copied probes to a temporary directory; installed pinned TypeScript 5.8.3 with scripts disabled; `npm test` reproduced all four counterexamples on macOS / Node v26.3.1. This is not supported-runtime or whole-SDK acceptance.
- Machine output: [results](2026-09-07-r7-r9-probe-results.json). Probe assertions expect defects, so exit 0 means reproduction.

## P1: map

R7 crosses client outbox/spool snapshot, append and recovery boundaries. R8 crosses cloud inbound validation, atomic task-store ownership and envelope admission. R9 crosses durable message disposition, TaskRunner completion gating and terminal/disposal ownership. Product consumer decisions remain authoritative.

## P2: concrete paths

- R7: one retained pending record + 256 append/ack cycles naturally trigger compaction; snapshot has no trailing newline; next append joins JSON objects; reopening fails in both classes. `retainedRecords: 2` in output is measured after the extra append, not immediately after compaction.
- R8: two inbound handlers read an unclaimed attempt; atomic store retains acme-a; applyLifecycle ignores returned claim identity; completeInboundEnvelope admits both. Store ownership is not overwritten. Entry: `packages/cloud/src/inbound.ts:537,577` at reviewed main.
- R9: pump receives turn_end and defers completion; exact refused disposition is persisted; handler clears retry and revokes context but returns without failure/disposal. Probe retains one active task and pending completion, with zero terminal messages and zero close calls. Entry: `packages/client/src/daemon/task-runner.ts:1324` at reviewed main.

## P3: disposition and bounded repair

Accept suggested priorities: R7 P1, R9 P1, R8 P2. Fix JSONL writer termination at both snapshot sites, with zero/one/multiple retained records through append and reopen. Claim outcome must use atomic returned execution identity, preserving same-identity idempotency and rejecting conflicting custom/builtin identities. Refused required messages must use existing terminal reservation, durable failure and disposal, preserving refusal evidence; held remains a separate product decision. Race tests must cover refusal before/after turn_end and cancellation/timeout.

At increased sustained load R7 reaches compaction sooner; R8 appears under concurrent claims; R9 exhausts execution slots as refused tasks accumulate. No new semantic fallback or second persistence authority is needed.

## Limits and next slice

No production source edited, full repository checks run, issues changed, or publication performed. Postgres, native Windows, actual harnesses, turn_end-before-refusal alternatives and cancellation/timeout races were not tested here. R1–R6 deduplication was not independently re-audited. Next bounded slice: R7 two-writer fix and natural-compaction recovery regressions on a checkout based on verified remote main, then R9 terminal convergence and R8 identity outcome handling.
