# #412 retention architecture and decision evidence

Status: implementation candidate; verification and PR publication pending. Independent of #399 and #415. Base is initially `7e60e0d1`; the final candidate base and checks are recorded after integration.

## P1: map

`core` owns mailbox/presence/quota/object/replay contracts, `cloud` owns receipt/nonce/pairing/activity/approval contracts and the closed maintenance executor. `server` composes one tenant and schedules it; SQLite persists mailbox/receipt/manifest/bytes while quota remains process-local. `cloud-dataplane` implements the same ports over PG/R2. Tasks, cancellation, egress, durable truth and cloud-do alarms are out of GC scope. The #415 stats and TaskAttemptStore changes remain separately owned.

## P2: concrete path

A server tick or manual `maintenance.runNow` joins one scheduler pass, obtains its injected clock and policy, invokes the cloud kernel's fixed ten steps, then emits a counts-only completion/failure event. The quota step releases expired reservations before object eligibility is evaluated. For one PG orphan, the entitlement gate excludes racing reservation admission, a bounded manifest selection records the durable tombstone, and a per-object transaction locks the tombstone across R2 DELETE and guarded accounting settlement. Same-hash recreation waits; unrelated admission does not. SQL/byte failures leave the tombstone for replay. SQLite's byte/manifest transaction commits synchronously before the corresponding prepared ledger release, without an await boundary.

## P3: decisions and counterexamples

- A used pairing code cannot be collected: every driver reaches the completion fence through its code row. Preserve redeemed rows and delete only unused codes strictly before expiry; equality remains redeemable.
- All 11 SDK receipt families and unknown keys are identity. The request projection is frozen and empty; only Vitest module mocks test a request-family deletion predicate. No product registration or injection path exists.
- Object selection consumes one budget across retry, new tombstone and delete. With limit one, repeatedly choosing a poison tombstone starves fresh orphans; always choosing fresh rows after the cursor end starves retries. Three phases plus cursor reset provide progress to both sets. PG persists the existing cursor; embedded cursors are process-local.
- PG refuses direct delete_pending revival, but another actor can mark deleted and recreate the same hash before an unlocked DELETE. A manifest row lock across byte deletion closes that race without a lease column or tenant-wide network lock. The real R2 maintenance adapter now has an abortable per-attempt timeout (default 10s); the prior adapter had none.
- Quota and object collection share the existing accounting/reservation facts through `InMemoryStorageLedger`, replacing the old private quota maps. Explicit byte binding prevents a deployed composition from collecting metadata while leaking its bytes. Metadata-only construction is limited to byte-free core conformance and the unused SQLite spare.

At 10x, eligibility scans, object network latency and a backlog exceeding 500 rows per five minutes become the pressure points. Limits bound mutations, not all in-memory scans. The report exposes actual remainder; the kernel and server do not silently loop. Validate a tenant's real SQL distribution before adding an index.

## Deferred boundaries

Drop installed `cleanup_job` only in a later forward migration once no supported Host reads historical rows. The old writer is removed now. Retained identity receipts, redeemed pairing codes and proof request receipts intentionally remain protected growth.

Reported pre-existing gaps: SQLite pairing enrollment state remains process-local; memory/SQLite allow delete_pending revival while PG refuses it; PG re-issuing an existing pairing code deletes its prior completion receipt outside tenant erasure. These are not changed by #412 and are not represented as solved.

Committed reservations of both kinds remain protected accounting identity: PG uses them as dedup witnesses and stored finalize-replay answers. The settled-row collector deletes only old expired/aborted rows. Removing a committed row would change later accounting while leaving the committed byte counter intact. No new accounting table or fallback is added. Cross-kind dedup differences between drivers are a pre-existing boundary, not corrected by this maintenance change.
