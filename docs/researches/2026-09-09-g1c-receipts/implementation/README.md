# SQLite receipt implementation

Baseline: fc4a49ca2495edae1e306a3441df80f78e92da6d. User approved the SQLite
receipt durability/lifetime slice after the G1c contract research. Earlier
store-observation.json and store-probe.ts remain pinned baseline evidence; the
old characterization assertions are not intended to pass on the fixed source.

## Root Cause Evidence

- Trigger: reopen the same database after completion/ACK/mailbox retention, or
  use two embedded compositions against that database.
- Observation: canonical readTaskResult became undefined; independent receipt
  stores both returned created=true for one tenant/key. See baseline-failure.txt.
- Cause: SQLite composition inherited InMemoryRequestReceiptStore while keeping
  task/mailbox authorities in SQLite.
- Regression: packages/server/src/__tests__/sqlite-receipts.test.ts exercises
  actual cloud enqueue, inbound terminal handling and result projection using
  the internal SQLite composition. No provider, OS credentials or consumer.

## Change

RequestReceiptStore now uses atomic INSERT with ON CONFLICT (tenant_id,key)
DO NOTHING, then reads the immutable winner. Rows have no TTL/delete path and
survive mailbox retirement. The synchronous statements do not hold a transaction
across a JavaScript await. The first implementation used the generic async
transaction helper and exposed same-event-loop connection lock contention;
first-implementation-lock-failure.txt preserves that failure.

Schema v3 rejects old writers. Explicit v1-to-v3/v2-to-v3 adoption rejects any
task/message/admission or advanced cursor history; missing historical receipts
are never fabricated. Eligible v2 retains device data; v1 creates an empty
device directory. Table creation/version change is atomic. Receipt columns and
composite primary key are validated on open. Existing unrelated table-constraint
P2 findings are not changed.

The old schema-v2 packed candidate was independently opened against a fresh v3
database and rejected it with its requires-2 version fence. No real databases
were migrated. The previous unpublished migration selector changed deliberately;
api-surface/server.d.ts records only that selector and documentation change.

## Acceptance scope

Tests cover independent connections/tenant isolation; canonical first terminal
across restart; completed identity after ACK and retention rejecting original
and changed payloads; pre-append failure preserving payload identity; append
success followed by delivered-receipt failure reusing the pending mailbox row;
cancellation readback; migration rejection/rollback and malformed receipt PK.
Injected failures and close/reopen are deterministic store/kernel tests, not a
new SIGKILL/provider experiment. Enqueue remains multiple kernel/store calls;
this slice does not promise a single atomic enqueue transaction or every
possible interleaving of concurrent retention and incomplete dispatch.

Receipts grow for the database lifetime. Historical databases cannot be silently
upgraded. Façade caller identity/read/cancel, host binding, consumer ACK, G0 and
Postgres generic receipt cleanup remain separate work. No release or production
journal change is included.

## Final verification

Full workspace: 3940 passed / 135 skipped. Server: 365 passed / 19 skipped.
Build, typecheck, API surface, version authority and strict workflow passed.
`acceptance.json` records source/test hashes and local log hashes. The first full
suite found TypeScript-private `read` exposed in the port inventory; it became
JavaScript-private `#read`, then the complete suite passed. No gate was relaxed.
