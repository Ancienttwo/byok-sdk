# #412 retention architecture and decision evidence

Status: implementation candidate; targeted verification in progress, PR publication pending network recovery. Integrated on `origin/main@5ef13002`, preserving #440 stats, #414 SQLite ownership and #413 TTL presence. The old worker WIP and #437 fixtures are untouched.

## P1: map

`core` owns mailbox/presence/quota/object/replay contracts, `cloud` owns receipt/nonce/pairing/activity/approval contracts and the closed maintenance executor. `server` composes one tenant and schedules it; SQLite persists mailbox/receipt/manifest/bytes while quota remains process-local. `cloud-dataplane` implements the same ports over PG/R2. Tasks, cancellation, egress, durable truth and cloud-do alarms are out of GC scope. The #415 stats and TaskAttemptStore changes remain separately owned.

## P2: concrete path

A server tick or manual `maintenance.runNow` joins one scheduler pass, obtains its injected clock and policy, invokes the cloud kernel's fixed ten steps, then emits a counts-only completion/failure event. The quota step releases expired reservations before object eligibility is evaluated. For one PG orphan, the entitlement gate excludes racing reservation admission, a bounded manifest selection records the durable tombstone, and a per-object transaction locks the tombstone across R2 DELETE and guarded accounting settlement. Same-hash recreation waits; unrelated admission does not. SQL/byte failures leave the tombstone for replay. SQLite's byte/manifest transaction commits synchronously before the corresponding prepared ledger release, without an await boundary.

## P3: decisions and counterexamples

- A used pairing code cannot be collected: every driver reaches the completion fence through its code row. Preserve redeemed rows and delete only unused codes strictly before expiry; equality remains redeemable.
- All 11 SDK receipt families and unknown keys are identity. The request projection is frozen and empty; only Vitest module mocks test a request-family deletion predicate. No product registration or injection path exists.
- Object selection consumes one budget across retry, new tombstone and delete. With limit one, repeatedly choosing a poison tombstone starves fresh orphans; always choosing fresh rows after the cursor end starves retries. Three phases plus cursor reset provide progress to both sets. PG persists the existing cursor; embedded cursors are process-local.
- PG refuses direct delete_pending revival, but another actor can mark deleted and recreate the same hash before an unlocked DELETE. A manifest row lock across byte deletion closes that race without a lease column or tenant-wide network lock. The real R2 maintenance adapter now has an abortable per-attempt timeout (default 10s); the prior adapter had none.
- Quota and object collection share the existing accounting/reservation facts through `InMemoryStorageLedger`, replacing the old private quota maps. Explicit byte binding prevents a deployed composition from collecting metadata while leaking its bytes. Every construction requires an explicit physical byte owner; byte-free conformance records its deletions. SQLite builds its remaining in-memory stores directly, without a spare object store.

At 10x, eligibility scans, object network latency and a backlog exceeding 500 rows per five minutes become the pressure points. Limits bound mutations, not all in-memory scans. The report exposes actual remainder; the kernel and server do not silently loop. Validate a tenant's real SQL distribution before adding an index.

## Deferred boundaries

Drop installed `cleanup_job` only in a later forward migration once no supported Host reads historical rows. The old writer is removed now. Retained identity receipts, redeemed pairing codes and proof request receipts intentionally remain protected growth.

Reported pre-existing gaps: SQLite pairing enrollment state remains process-local; memory/SQLite allow delete_pending revival while PG refuses it; PG re-issuing an existing pairing code deletes its prior completion receipt outside tenant erasure. These are not changed by #412 and are not represented as solved.

Committed reservations of both kinds remain protected accounting identity: PG uses them as dedup witnesses and stored finalize-replay answers. The settled-row collector deletes only old expired/aborted rows. Removing a committed row would change later accounting while leaving the committed byte counter intact. No new accounting table or fallback is added. Cross-kind dedup differences between drivers are a pre-existing boundary, not corrected by this maintenance change.


## Integration decisions

- `PostgresRetentionPolicyStore` owns policy reads/writes on the neutral runtime entry. The Node operator composition no longer exposes duplicate policy methods. Missing entitlement-selected policy fails closed.
- `CollectExpiredFailure` preserves confirmed committed counts, counts failed rows separately, and omits unknown remainder. A real SQLite remainder-probe fault reproduced lost counts after byte/manifest/accounting commit; the regression now proves those counts survive. PG uses the same contract, but its live regression remains unverified while the local substrate is unreachable.
- The scheduler is constructed last. Close awaits a settled pass, then releases stores, while the pass consumer retains its original error. No shutdown error shim is introduced.
- No installed migration bytes were changed. `cleanup_job` remains installed without writers.
- Latest owner scope limits verification to targeted tests with one worker. No full-repo suite or client fixture edits are authorized for this slice.
