# #412 retention architecture and decision evidence

Status: PR #456 is open; rebase verification is recorded below. Originally based on `5ef13002`, merged `origin/main@a10c67a0` normally, preserving #440 stats, #414 SQLite ownership and #413 TTL presence. The old worker WIP is untouched. The owner later authorized only the execution-recovery fixture port migration recorded below.

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
- Verification is limited to targeted tests with one worker. The later owner instruction authorizes the execution-recovery receipt/pairing collectExpired fixture migration only; other #437/auth changes remain excluded.


## Initial feature verification (2026-10-14, before rebase)

Node 24.21.0 / Bun 1.4.2; all tests used one worker. Final targeted runs:
core 97, cloud 114, server 60, memory conformance 52, SQLite conformance 51,
Worker policy/runtime/packaging 18: 392 passed. Two existing server skips and
229 test-name-filter exclusions are not counted as passes. No full-repo suite
ran. Related core/cloud/server/dataplane builds and all five affected package
typechecks (including conformance) passed. Four changed API surfaces, version
authority and installed SQL order passed.

At initial verification, real PG/S3 tests were unverified: the attempted remainder regression failed at
connection setup with ECONNREFUSED, before product execution. No production
claim is derived from that result. The analogous SQLite fault was first red
on lost committed counts and is now green. Installed SQL and SQLite ownership
support files have no diff from main.

At initial verification the client execution-recovery fixture lacked the new
receipt/pairing methods and its edits were excluded. The later explicit owner
authorization and completed migration are recorded below; no optional port
methods or compatibility code were added.
GitHub access initially failed in the restricted execution environment. The host
shell through Herdr later published PR #456; current CI status belongs to GitHub.

## Rebase integration with embedded wakes

Rebased the candidate onto `origin/main@76e59b21` after the embedded wake queue
landed. The server conflicts retain main's wake constructor hook, schema
adoption and scheduler alongside the retention ledger/byte owner. Both
schedulers start closing synchronously and settle before storage closes; the
maintenance close test additionally rejects a wake call while its pass is still
blocked. No existing assertion was removed or weakened.

Prior-head CI confirmed the known client fixture integration errors and one
retention concurrency assertion that awaited an illegal duplicate `markDeleted`.
The owner explicitly approved two test-contract migrations: five wake timer
expectations include the mandatory maintenance timer, while close still proves
zero timers; the queued `markDeleted` now asserts the existing exact
`object_state_invalid` rejection immediately, avoiding an unhandled rejection.
All delivery, close, lock, byte, usage and same-hash recreation checks remain.
No client fixture or product state transition was changed.

Local rebase checks (Node 24.18.0 / Bun 1.4.3): six related builds, five
package typechecks, four API surfaces, version authority and SQL order passed.
SQLite conformance selection passed 51 tests. After the approved migrations,
the seven-file server selection passed all 86 tests; server and dataplane
typechecks passed again. The restored host Postgres/S3 substrate ran all seven
physical-object retention tests successfully with `BYOK_REQUIRE_DATAPLANE=1`
and one worker, including row-lock concurrency, same-hash recreation, physical
DELETE response loss, exact accounting and committed-count preservation.
These focused results alone do not establish full-repository CI green. The
subsequently authorized receipt/pairing fixture migration is recorded below.


## JavaScript release consumer migration

The new required physical-byte owner also crosses the untyped packed-smoke
composition boundary. CI passed 388 dataplane tests and 181 conformance tests,
then failed constructing the durable smoke's core stores without objectStorage.
Both initial and reopened child compositions already have the same explicit
S3 configuration used by their cloud stores; pass that authority to core too.
This changes two constructor arguments, without changing any smoke assertion,
consumer behavior, receipt fixture or state transition. No fallback is added.

The unchanged recurring smoke source, copied into an isolated context with
links to this worktree's built packages, passes against real Postgres/S3 on
Node 24.18.0. It covers the independent reopen and body-commit/crash/replay legs.
This local check is built-workspace evidence; installed-tarball evidence stays
with the hosted release smoke. Full-repository verification remains excluded.


## Owner-authorized execution-recovery fixture port migration

The owner updated the feature branch onto main c6af648d, yielding 4b9e3f81,
then explicitly authorized fixing its two missing collectExpired methods.
SqliteFixtureReceipts owns fixture_receipt, so its collector uses the same
REQUEST_RECEIPT_PREFIXES authority and input validation as the real store,
with a tenant-scoped, timestamp-ordered batch and transactional remainder probe.
Identity/unknown receipts remain protected; the current request-family set is
empty. The existing ownerWrite guard preserves exclusive SQLite ownership and
the committed-receipt SIGKILL hook. Pairing binds the existing collector on the
same InMemoryPairingCodeStore that owns issue/redeem. No assertion or auth path
changes and no fixture behavior fallback are included.

Client build and both client typecheck passes succeed. The selected committed-
receipt SIGKILL case fails before its recovery scenario: the OS credential
provider cannot replace device credentials during first pairing. This local
prerequisite failure is reported, without altering credentials, auth, test
assertions, deadlines or skips. Hosted CI remains the integration gate.


## Stateless receipt validation

CI on the fixture-migration head passed the required typechecks and both real-
Postgres jobs, including their installed release smoke. Baseline/Node 26 then
exposed the cloud statelessness guard: the new receipt registry's duplicate-
prefix validator constructed a temporary Set outside a store class. Replace
that one expression with an array first-index comparison. Both reject exactly
the same duplicate prefixes; identity-overlap validation is unchanged. The
registry has eleven immutable entries and validation runs once on import.
No guard allowlist or test assertion changes are needed. Cloud build,
typecheck, API surface and 28 targeted constraint/classification/request-family
tests pass after the change.


## Rebase onto main a2ec8697 (19:40 HKT)

Replayed the existing ten feature commits onto `a2ec8697f10adecd5c57eed6061b6a86f7a49fe3`.
The two conflicts were cloud imports and server README structure: preserve main's
`DEFAULT_ACTIVITY_INGRESS` alongside maintenance imports, and retain main's
ownership/close/stats sections with the retention/identity receipt policy.
Both schedulers still start closing synchronously before storage closes; SQLite
still receives its wake consumer. No assertion or test budget changed in this
integration. The six core inventory additions already on remote `91f2f845` were
replayed unchanged; their exact equality tests now pass.

Verified source `59b06ba7437e1366755a781ef016d45454b4f875`: ten package builds,
six related typechecks, all nine declaration goldens and the complete entry
closure/policy gate, version authority and SQL order pass. Targeted tests use
one worker: core 83, cloud 64, server 86, selected SQLite conformance 51, and
real Postgres/S3 physical retention 7 (291 passed). The 113 conformance cases
outside the name filter are exclusions, not passes. No full repository suite
ran locally. These results do not establish hosted CI green. The earlier
Windows ACL positive-probe timeout is only to be investigated if it recurs
on the rebased head; its budget and implementation remain unchanged.
