# SQLite receipt durability

## Scope and architecture snapshot

User approved implementing the G1c SQLite receipt/lifetime slice. The server's
embedded composition owns durable receipts on its existing SQLite coordinator;
cloud's RequestReceiptStore and enqueue/read/cancel authority remain unchanged.
No production journal, Postgres cleanup, consumer, façade recovery API or release.
Schema migration must fence older writers and must not invent missing historical
receipt facts. Preserve prior research observations as baseline evidence.

## Task Breakdown

- [x] Add and capture failing restart/retention/payload regression tests
- [x] Implement atomic first-write-wins receipts and explicit schema adoption
- [x] Verify migration rejection/rollback and canonical terminal recovery
- [x] Run required checks and update architecture/documentation/handoff

Delivery scope: push the existing candidate branch and read back its remote ref; no merge/release.

## Acceptance

A delivered identity stays non-executable after mailbox retirement and reopen;
changed payload cannot overwrite the original offer body; canonical terminal
receipt survives and wins over later conflicting terminals; tenant isolation,
concurrent first writers and cancelled result projection remain correct.

## Final verification

3940 passed / 135 skipped; build, typecheck, API surface, version authority and
workflow passed. Evidence and frozen file hashes:
`docs/researches/2026-09-09-g1c-receipts/implementation/acceptance.json`.
