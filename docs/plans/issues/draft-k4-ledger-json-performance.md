# Draft issue: K4 whole-ledger JSON work delays embedded task claims

Status: local draft. No GitHub issue has been created. No K4 fix is in WO-12.
Source: `_ops/bot-wo/REV-12-round2.md`, 2026-10-19.

## Observed problem

An embedded Host, server, and daemon share one process. A large Unicode room
request creates about five stored copies. The ledger reaches about 564 KB.
`HostLedger.snapshot` parses the full ledger. `transaction` reads and writes
the full ledger. K4 scans and Host processing repeat these operations.

The review probe used 18,000 emoji plus ` CURRENT-END` (72,012 UTF-8 bytes).
Claims occurred after 16.2–19.9 seconds. Equal-byte ASCII controls were much
faster. The Unicode startup window recorded 2,097 snapshots (about 12.1 s) and
1,007 transactions (about 11.7 s). These totals overlap. Review load was about
11. This is CPU delay, not evidence of an SDK claim defect.

## Reproduction evidence

Review probe: `/tmp/rev531r2/probe2.test.ts`. Review head: `ade69391`.
Code entrypoints: `examples/host-execution-core/src/ledger.ts:20-37`, K4 scan,
reconcile, delivered, and Bot Host process/flushWakes/armScan.
Use an isolated ledger and real embedded SDK fixture. Record ledger bytes,
snapshot/transaction counts, CPU time, and time to adapter session start.
Retain the Unicode input. Compare ASCII with the same UTF-8 byte count.

## Required result for the later issue

Bound repeated ledger serialization work as stored data grows. Preserve
transaction durability, replay identity, immutable offers, and crash recovery.
Measure before and after with the same input and unchanged test deadlines.
Include a regression for Unicode and a control for ASCII. Do not solve this
by increasing timeout, sleeps, or retries. Architecture and implementation
selection belong to the K4 owner. This draft proposes no source change.

WO-12 limits and measures the current Request. It does not solve accumulated
ledger growth or repeated full-state JSON work.
