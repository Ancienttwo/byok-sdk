# #412 Cloud retention: one `collectExpired` per expiring port, one closed `runMaintenance`

Status: plan only (Claude planning collaborator for Codex `byok399`, pane w2:pZ). Production, tests, migrations and Git are read-only for this slice.
Base: `origin/main` `7e60e0d1` (includes #411: mailbox bytes derived from retained rows). WT `/private/tmp/worktrees/byok-sdk-412-maintenance`, branch `fix/412-cloud-maintenance`.
Concurrent owner: `byok397` (pane pY) owns #415 and the shared files listed in "Shared file scopes". #412 must not edit those files until pY hands them off explicitly.
Owner decisions applied (user-approved through the parent):
- **Policy defaults:** run every 5 min ±20%. Acked mailbox rows 24h, unacked 7d, request receipts 24h, orphan grace 24h, at most 500 rows per step. Retention cannot be disabled.
- **Receipts:** one kernel prefix table. All existing SDK families are `identity`, an unknown prefix is treated as `identity`, and the `request` class is empty.
- **`cleanup_job`:** the installed schema stays and its writers go. `runTenant` is removed; the operator APIs remain.
- **Durable state:** tasks and history stay out of GC.

## Goal

Every port that holds expiring state has exactly one bounded `collectExpired`. `ByokCloud.runMaintenance` calls them in a fixed, closed order and returns one report. The reference server schedules it, and hosted deployments call the same entry point from their own scheduler. The scattered paths are deleted, not wrapped: `collectRetired`, the two `deleteExpired` methods, the issue-time nonce cleanup, `runTenant` and its single CTE, and `ByokServer.mailbox`.

## P1 Architecture map

### Ports (10) × drivers (3)

| # | Port (file) | Expiring state | In-memory | SQLite (server) | Postgres (dataplane) |
|---|---|---|---|---|---|
| 1 | `core` `MailboxStore` (`core/src/mailbox.ts:157-205`; `collectRetired` + `MailboxRetentionInput{deviceId?,ackedBefore,expireUnackedBefore}`) | acked rows → delete; pending rows → `expired` | `core/src/in-memory/mailbox.ts` | `SqliteMailboxStore` `server/src/stores/sqlite/index.ts:787` | `cloud-dataplane/src/stores/core/mailbox.ts` |
| 2 | `core` `PresenceStore` (`core/src/presence.ts:110`) | hints past `expires_at` | `core/src/in-memory/presence.ts` | in-memory (composition `sqlite/index.ts:1290-1340`) | `stores/core/presence.ts` |
| 3 | `core` `QuotaStore` (`core/src/quota.ts:182-210`; has `expireReservations(tenant)`) | `reserved` past TTL → `expired`; settled rows deleted after grace | `core/src/in-memory/quota.ts` | in-memory over SQLite objects | `stores/core/quota.ts` |
| 4 | `core` `ObjectStore` (`core/src/blob.ts:206-224`) | orphan manifests (ref 0, no live reservation, older than grace) → tombstone → bytes delete → settle | `core/src/in-memory/blob.ts` (metadata only; bytes in `cloud/src/stores/in-memory/blobs.ts:183`) | `SqliteObjectStore` `:1009` + `blob` table `:158` | `stores/core/objects.ts` + `R2ObjectMaintenanceStore` `stores/r2-blobs.ts:578` |
| 5 | `core` `DeviceAssertionReplayAuthority` (`core/src/device-assertion.ts:502-504`, only `consume`) | keys past `expiresAt` | `core/src/in-memory/device-assertion-replay.ts:43-57` (`deleteExpired`, no caller) | — (not composed) | `stores/device-assertion-replay.ts:46` (`deleteExpired`, no caller) |
| 6 | `cloud` `RequestReceiptStore` (`cloud/src/stores/ports.ts:502-515`) | only prefixes the kernel classifies `request` (currently none) | `cloud/src/stores/in-memory/receipts.ts` | `SqliteRequestReceiptStore` `:432` | `stores/receipts.ts` |
| 7 | `cloud` `NonceStore` (`ports.ts:212`) | used or expired nonces | `in-memory/nonces.ts` (issue-time cleanup to delete) | in-memory | `stores/nonces.ts` |
| 8 | `cloud` `PairingCodeStore` (`ports.ts:179`) | redeemed or expired codes | `in-memory/pairing-codes.ts:57-58` (never deletes) | in-memory (`InMemoryPairingCodeStore` wired at `sqlite/index.ts:1316`) | `stores/pairing-codes.ts` |
| 9 | `cloud` `ActivityStore` (`cloud/src/activity.ts:64`) | tails past `expires_at` | `in-memory/activity.ts` | in-memory | `stores/activity.ts` |
| 10 | `cloud` `ApprovalTimelineStore` (`cloud/src/approval-timeline.ts:114`) | tails past `expires_at` | `in-memory/approval-timeline.ts` | in-memory | `stores/approval-timeline.ts` |

Not swept (durable or bounded by design): `TaskAttemptStore`, `TaskCancellationStore`, `AgentEgressStore`, `TruthStore`, `BoardStore`, `SkillPackStore`, agent-memory projection, `InboundDedupStore` (1024-entry ring per key), `devices`, `rateLimiter`. `ProofRequestReceiptStore` (`ports.ts:571-583`) also grows without bound and is not on the issue's list. Default: treat it as identity (never expires) and report it; see Q6.

cloud-do keeps its own alarm and implements none of these ports, so it has no compile impact.

### Today's drivers of expiry

- **Embedded server:** the only path is the Host calling `ByokServer.mailbox.collectRetired` (`server/src/index.ts:252-272`, `:867-871`). Presence, activity and approval tails are deleted lazily on read. Nonce cleanup happens at issue time. Pairing codes, receipts, replay keys and objects are never deleted.
- **Hosted:** `PostgresCloudCleanup.runTenant` (`cloud-dataplane/src/cleanup.ts:264-352`):
  - takes a per-tenant advisory lock and records a `cleanup_job` row (`:559-578`, `:925-990`);
  - runs one unbounded CTE over outbox, reservations, nonces, pairing codes, presence, activity and approvals (`:580-650`);
  - tombstones up to `batchSize` orphans (`:653-704`), deletes R2 objects and settles them (`:706-760`), then reconciles manifests and R2 (`:761-875`).
  - Receipts are already excluded (#411 comment at `:592-597`).
  - Policy comes from `tenant_retention_policy` (`deploy/sql/0003_cloud_cleanup.sql:20-34`), referenced by `storage_entitlement.retention_policy_id` (`0002_core_domain.sql:340`). A missing policy fails closed with `cleanup_policy_missing`.
- **Unused:** the replay `deleteExpired` methods (two drivers) and `QuotaStore.expireReservations`. The implementer should check its callers before deleting it from the port.

### Receipt key families (all written through `RequestReceiptStore`)

| Family (key shape) | Writer | Reader / authority |
| --- | --- | --- |
| `task-offer:<messageId>` | `cloud.ts:1209` | claim and recovery (`inbound.ts:609,623`), `cloud.ts:2375` |
| `task-offer-delivered:<messageId>` | `cloud.ts:1210` | `cloud.ts:2387` |
| `task:<taskId>:terminal` | `inbound.ts:348` (`terminalReceiptKey`) | terminal idempotency |
| `agent-message-offer:<deviceId>:<taskId>` | `cloud.ts:1971` | `inbound.ts:219`, `task-agent-message.ts:37` |
| `agent-content-request:[…]` / `agent-content-receipt:[…]` | `cloud.ts:2103`, `inbound.ts:387-391` (`agentReliabilityKey`, `agent-reliability.ts:10-18`) | mismatch checks |
| `agent-home-projection-request:[…]` / `-completion:[…]` | `agent-home-projections.ts:32,40` | server projection authority (`server/src/index.ts` request receipt) |
| `agent-input-preparation-request:[…]` / `-completion:[…]` | `input-preparations.ts:40,48` | completion idempotency |
| `pairing-completion:v1:sha256:<hex>` | `cloud-dataplane/src/stores/pairing-codes.ts:58-61` | pairing authority |

That gives 11 families. Every key is `<family>:` followed by a family-specific suffix, except the terminal key, which has the shape `task:<id>:terminal`.

## P2 Concrete paths

### Embedded server, after #412 (one tick)

1. `createByokServer(opts)` (`server/src/index.ts:~300`) builds the composition and the one tenant (`serverTenantId`, `:319`). It then constructs `MaintenanceScheduler({ run: () => cloud.runMaintenance({ tenant, now: clock.now(), policy, limit }), intervalMs, jitter: 0.2 })`.
2. The timer fires through `setTimeout` (unref'd) with delay `intervalMs × (1 + U[-0.2, 0.2])`. If a pass is already in flight, the tick is skipped and the timer re-armed. The timer is armed only after the previous pass settles, so passes never overlap.
3. `runMaintenance` (`cloud/src/maintenance.ts`, new; `ByokCloud` method in `cloud.ts`) validates the policy and `now`, then runs `MAINTENANCE_STEPS` in order. Each step is called with `limit` and its own cutoff, and errors are caught per step. The result is `MaintenanceReport`, passed to `observer.onMaintenance?.(report)` and also returned.
4. Example step: the mailbox step calls `core.mailbox.collectExpired(tenant, { now, limit, ackedBefore: now - 24h, expireUnackedBefore: now - 7d })`. SQLite deletes at most `limit` acked rows (`DELETE … WHERE rowid IN (SELECT … LIMIT ?)`) and then moves up to `limit − removed` pending rows to `expired`. It returns `{ removed, expired, releasedBytes: 0n, more }`. `releasedBytes` is always `0n` for the mailbox: usage is derived from the retained rows (#411), so deleting rows releases nothing to accounting, and the step never reads or writes mailbox usage. Non-zero `releasedBytes` comes only from steps that really release accounted bytes: quota (the `reservedBytes` of reservations moved from `reserved` to `expired`; deleting already-settled rows releases nothing) and objects (the accounted bytes settled after delete). Mailbox is always `0n`, and every TTL-only step reports `0n`.
5. The server emits `maintenance.completed` (`{ report }`), or `maintenance.failed` when any step failed. The steps that did succeed still commit.
6. `close()` clears the timer, awaits the in-flight pass, and only then runs `relay.stop()` and `composition.close()` (SQLite).

### Hosted (Postgres + R2)

The Host's cron, Cloudflare cron trigger or Durable Object alarm runs, per tenant:

```ts
const policy = await maintenance.readRetentionPolicy(tenant); // existing operator API; missing row → cleanup_policy_missing, fail closed
cloud.runMaintenance({ tenant, now, policy, limit });          // TenantRetentionPolicy is structurally a RetentionPolicy; no conversion
```

Each step is one bounded statement or transaction inside its PG store.

**Objects step: one candidate budget of at most `limit` distinct objects per call.** It replaces the earlier "`limit` tombstones plus `limit` deletes" sketch, which allowed up to 2×`limit` objects.

1. **Retry first, within the cycle (D5).** Select `delete_pending` manifests whose accounting fields are set and whose `hash` is greater than the persisted `gc_cursor` `delete` cursor (`cleanup.ts:877-920`). Take up to `limit + 1`; the first `limit` rows become the work set R. There is no wrap in this phase.
2. **Fill with new orphans only if R has fewer than `limit` rows.** In one transaction:
   - take the entitlement gate (`SELECT 1 FROM storage_entitlement … FOR UPDATE`, same as `cleanup.ts:663-666`);
   - select eligible orphans (ref 0, no `object_reference`, no `reserved` reservation, older than the cutoff) with `ORDER BY updated_at, hash LIMIT (limit − |R|) + 1 FOR UPDATE OF m SKIP LOCKED`;
   - mark the first `limit − |R|` of them `delete_pending` with their accounted bytes (the existing tombstone statement), commit, and add them to R.
3. **Delete and settle.** For each object in R (|R| ≤ `limit`): R2 delete, then the existing guarded settle statement (`cleanup.ts:706-760`). Network I/O happens outside the transaction. A failed delete or settle leaves the tombstone in place, so the next call retries it in step 1.
4. **Result.**
   - On success: `removed` = objects settled to `deleted` in this call, `expired = 0`, `releasedBytes` = their settled accounted bytes. The tombstone is an internal phase of one deletion, not a second counted retirement.
   - `more` is true if step 1 or step 2 saw a `limit + 1`-th eligible row, or if any object in R failed. It reflects real eligible remainder, never a second loop.

In-memory and SQLite apply the same algorithm in one process: retry-first, then fill. SQLite takes the manifest and `blob` row deletion in one transaction.

The PG composition binds the R2 maintenance handle, and the objects logic is lifted from `cleanup.ts:653-760` into `PostgresObjectStore`. No `cleanup_job` row is written. Manifest and R2 reconciliation (`cleanup.ts:761-875`) becomes the explicit operator method `reconcileObjectStorage(tenant)`, next to `rebuildObjectUsage` and the dead-letter APIs.

### Receipt step (amended: no caller-supplied prefixes)

`receipts.collectExpired(tenant, { now, limit, requestBefore })` takes no prefix argument. Each driver (in-memory `cloud/src/stores/in-memory/receipts.ts`, SQLite `server/src/stores/sqlite/index.ts`, PG `cloud-dataplane/src/stores/receipts.ts`) imports `REQUEST_RECEIPT_PREFIXES` from `@byok-sdk/cloud`'s `receipt-retention.ts` and builds its filter from it. That module is the only classification authority. Matching is exact prefix comparison: `substr(key,1,length(?)) = ?` in SQLite, `left(key, length($n)) = $n` in PG, and `startsWith` in memory. LIKE is never used.

**Test-only seam for the issue-required request family (amended: no product entry).**
- The production table is identity-only. `RECEIPT_RETENTION` is frozen and holds exactly the 11 SDK families as `identity`. `REQUEST_RECEIPT_PREFIXES` is derived from it and is `[]`. `receiptRetentionClass(key)` returns `identity` for every key, registered or not. There is no registration, extension, injection or constructor path. Module-load assertions still guard future entries: request prefixes end in `:`, never overlap an identity family, and never repeat.
- Driver rule that makes mocking sufficient: drivers outside `@byok-sdk/cloud` (SQLite in `server`, Postgres in `cloud-dataplane`) import `REQUEST_RECEIPT_PREFIXES` only through the public `@byok-sdk/cloud` entry, never a deep path, and read it when building the statement. The in-memory driver imports it from `../../receipt-retention`.
- Test authority, Vitest module mocks only:
  - In-memory source tests (`packages/cloud`): `vi.mock('../receipt-retention', async (orig) => ({ ...await orig(), REQUEST_RECEIPT_PREFIXES: Object.freeze(['test-request:']) }))`. The path is relative to the test file and points at the source module.
  - SQLite and Postgres tests (`packages/server`, `packages/cloud-dataplane`): `vi.mock('@byok-sdk/cloud', async (orig) => ({ ...await orig(), REQUEST_RECEIPT_PREFIXES: Object.freeze(['test-request:']) }))`.
  - Each mocked state gets its own test file, because `vi.mock` is file-scoped and hoisted. Example pairs: `retention-receipts.test.ts` (default, unmocked) and `retention-receipts-request-mock.test.ts` (mocked), for each of in-memory, SQLite and Postgres.
- Conformance hook: `runCloudRetentionConformance(name, factory, { requestPrefixMock?: string })`.
  - Without the option, the suite asserts that `REQUEST_RECEIPT_PREFIXES` (imported through `@byok-sdk/cloud`) is `[]`. It writes one receipt per identity family plus an unregistered key, ages them past every cutoff, and asserts `removed: 0` with all rows intact. This is the issue's empty=zero acceptance.
  - With the option, the suite first asserts that the mock is active (`REQUEST_RECEIPT_PREFIXES` deep-equals `[requestPrefixMock]`), so a mock that silently failed to apply cannot pass as "nothing to delete". It then asserts that only `test-request:` rows older than `requestBefore` are removed, at most `limit` per call, with `more` set correctly, and that identity and unregistered rows survive.
- Known mock limitation, recorded so nobody relies on it: an `@byok-sdk/cloud` mock replaces only the package export seen by the importing test graph. Code inside the cloud dist that reads the table through internal references would not see it. That is acceptable because only the drivers read the projection, and the guard below keeps it that way.
- Guard tests (unmocked): every SDK key builder output classifies as `identity`, an unregistered key is `identity`, and `REQUEST_RECEIPT_PREFIXES` is `[]`. A source scan confirms that no non-test file outside `receipt-retention.ts` and the three receipt drivers references `REQUEST_RECEIPT_PREFIXES`.
- Rejected: a reserved probe family in the production table (it violates the empty-class acceptance and adds product semantics); an exported extend API, a constructor-injected table or a caller-supplied prefix list (each is a second registration authority).

## P3 Contract, invariants, scale bounds

### Contract (`@byok-sdk/cloud`, new `cloud/src/maintenance.ts` + `cloud/src/receipt-retention.ts`)

```ts
export interface CollectExpiredResult { readonly removed: number; readonly expired: number; readonly releasedBytes: bigint; readonly more: boolean }
// core ports (core/src/*.ts), tenant-first:
MailboxStore.collectExpired(tenant, { now, limit, ackedBefore, expireUnackedBefore })        // replaces collectRetired; no deviceId
PresenceStore.collectExpired(tenant, { now, limit })
QuotaStore.collectExpired(tenant, { now, limit, settledBefore })                              // ONE budget: expire reserved past TTL first (expired, releasedBytes = their reservedBytes), then delete settled rows before cutoff with the remaining slots (removed); more = eligible remainder in either set
ObjectStore.collectExpired(tenant, { now, limit, orphanBefore })                              // ONE budget ≤ limit: retry delete_pending first, fill with new orphans, delete+settle; removed = settled, expired = 0
DeviceAssertionReplayAuthority.collectExpired(tenant, { now, limit })                         // replaces both deleteExpired
// cloud ports (cloud/src/stores/ports.ts, activity.ts, approval-timeline.ts):
RequestReceiptStore.collectExpired(tenant, { now, limit, requestBefore })                    // filter derived inside each driver from REQUEST_RECEIPT_PREFIXES
NonceStore.collectExpired(tenant, { now, limit }); PairingCodeStore.collectExpired(tenant, { now, limit })
ActivityStore.collectExpired(tenant, { now, limit }); ApprovalTimelineStore.collectExpired(tenant, { now, limit })

export const MAINTENANCE_STEPS = ['mailbox','receipts','nonces','pairingCodes','presence','activity','approvals','deviceAssertionReplay','quota','objects'] as const;
export interface RetentionPolicy {   // field names and bigint type are exactly the existing dataplane TenantRetentionPolicyInput fields; no translator or alias
  readonly mailboxAckedRetentionMs: bigint; readonly mailboxUnackedRetentionMs: bigint;
  readonly requestReceiptRetentionMs: bigint; readonly objectOrphanGraceMs: bigint;
}                                      // each must be > 0n and <= Number.MAX_SAFE_INTEGER; no disable
export const DEFAULT_RETENTION_POLICY: RetentionPolicy = { 24h, 7d, 24h, 24h } (as bigint ms);
export const DEFAULT_MAINTENANCE_LIMIT = 500;
export type MaintenanceStepReport =
  | { step; status: 'ok'; removed; expired; releasedBytes; more }
  | { step; status: 'failed'; errorCode; removed; expired; releasedBytes; failures }   // committed partial work stays visible (no cross-step rollback); e.g. objects with failed deletes keep their tombstones and count in `failures`
  | { step; status: 'not-configured' }   // the port is not composed; carries NO counts, never a fake zero
export interface MaintenanceReport { tenantId; startedAt; finishedAt; steps: readonly MaintenanceStepReport[] }  // steps in MAINTENANCE_STEPS order, always 10
ByokCloud.runMaintenance(input: { tenant; now: string; policy: RetentionPolicy; limit?: number }): Promise<MaintenanceReport>
ByokCloudObserver.onMaintenance?(report): void   // inbound.ts:181 interface
export const RECEIPT_RETENTION: readonly { prefix: string; class: 'identity' | 'request' }[]   // exactly the 11 SDK families, all identity; frozen
export const REQUEST_RECEIPT_PREFIXES: readonly string[]                                       // derived from RECEIPT_RETENTION; [] in production; the only filter source for all 3 drivers (tests substitute it via vi.mock)
export function receiptRetentionClass(key: string): 'identity' | 'request'                 // unregistered → identity
```

Step order rationale: cheap TTL deletes come first. Quota runs before objects, because the orphan check excludes manifests that still have a `reserved` reservation. Objects run last because they do external I/O and are the slowest step.

### Invariants

1. **One authority per retention fact.** The receipt class lives only in `RECEIPT_RETENTION`, and cutoffs only in `RetentionPolicy` plus `now`. Drivers receive computed cutoffs and prefixes and never own constants.
2. **Unacked mailbox rows are never deleted by maintenance.** They only move to `expired`; dead-letter discard stays an operator action.
3. **Maintenance never reads or writes mailbox usage.** Object settlement adjusts object accounting only, through the existing guarded statement.
4. **Identity fences never expire.** That covers the 11 families and every unregistered prefix. `tasks.get()` keeps `createdAt` and `sessionRef`.
5. **Bounded work.** Every step, objects and quota included, touches at most `limit` distinct rows or objects per call. PG implements this as `ctid`/PK `IN (SELECT … LIMIT $n)`. Each step shares one budget across its phases:
   - mailbox: delete acked rows, then expire pending rows;
   - quota: expire reservations, then delete settled rows;
   - objects: retry `delete_pending`, then tombstone new orphans, then delete and settle that same set.

   Each phase selects `remaining + 1` candidates and acts on `remaining`. `more` means a further eligible row actually exists. It never means "the bound was hit", and it never implies a second loop ran.
6. **Step isolation.** A failing step records `status: 'failed', errorCode` and the run continues. No step's partial work is rolled back by another step's failure.
7. **No disable.** There is no `enabled: false`. A policy value ≤ 0, a non-integer value or `limit` outside 1..5000 throws a typed `MaintenanceInputError` (`ByokCloudError` code `maintenance_invalid_input`). Values are never clamped.
8. **The caller owns the clock.** `now` is a canonical ISO-8601 UTC string, which keeps maintenance testable under a test clock.

### Scale bounds (what fails first at 10x)

- **PG step latency.** Each step is one indexed range scan plus at most 500 row mutations. Required indexes:
  - outbox `(tenant_id, state, appended_at)`;
  - `expires_at` on presence, activity, approval and nonce tables;
  - `request_receipt (tenant_id, key)`, where the PK prefix scan serves `left(key,…)` only if the PK has a `text_pattern_ops` btree. While the request class is empty there is no query at all.

  Run `EXPLAIN` on real PG in acceptance. Add migration `0024_maintenance_indexes.sql` only for the indexes `EXPLAIN` proves missing.
- **Backlog drain.** At 500 rows per step every 5 min, one tenant drains about 144k rows per day per step. A tenant that accumulates more than that needs `runNow()` loops while `more` is true. The report exposes `more`, and the server must not loop on its own.
- **SQLite multi-process.** Every process runs maintenance; that needs #414's lock. The statements are idempotent, so a duplicate run is wasted work, not a correctness bug.
- **Hosted concurrency.** `runTenant`'s advisory lock is removed along with `runTenant`. Concurrent passes on one tenant are safe: deletes are idempotent, tombstoning uses `SKIP LOCKED`, and settlement is guarded. They waste work, though. Recommendation: document "one scheduler per tenant". Adding a kernel lock would add a second authority.

## Downstream contract

- New exports: `RetentionPolicy`, `DEFAULT_RETENTION_POLICY`, `DEFAULT_MAINTENANCE_LIMIT`, `MaintenanceReport`, `MaintenanceStepReport`, `MAINTENANCE_STEPS`, `CollectExpiredResult`, `RECEIPT_RETENTION`, `REQUEST_RECEIPT_PREFIXES`, `receiptRetentionClass`, `ByokCloudOptions.deviceAssertionReplay`, `ByokCloud.runMaintenance`, `ByokCloudObserver.onMaintenance`.
- **Breaking for Host-implemented ports:** each of the 10 ports gains `collectExpired`, and `collectRetired`, `deleteExpired` and (if no caller remains) `expireReservations` are removed. Conformance ships the retention suites.
- **Server:**
  - `createByokServer({ maintenance?: { policy?: Partial<RetentionPolicy>; intervalMs?: number; limit?: number } })`, defaults as above. `intervalMs` must be ≥ 1000, typed error otherwise.
  - New events `maintenance.completed` / `maintenance.failed`, and `ByokServer.maintenance.runNow(): Promise<MaintenanceReport>`, which joins an in-flight pass.
  - `ByokServer.mailbox` is deleted, and `MailboxRetentionInput` / `MailboxRetentionResult` are no longer re-exported (`server/src/index.ts:106`).
- **Dataplane:**
  - Deleted: `PostgresCloudCleanup.runTenant`, `#runRetention`, `#startJob`, `#finishJob`, `#failJob`, `#readJob`, `CloudCleanupResult`, `CleanupJobState`, `CLOUD_CLEANUP_ERROR_CODES.cleanup_job_running`.
  - Kept as operator APIs: `writeRetentionPolicy`, `readRetentionPolicy`, `listDeadLetters`, `replayDeadLetter`, `discardDeadLetter`, `rebuildObjectUsage`, and the new `reconcileObjectStorage`.
  - The `cleanup_job` table stays installed with no writer. Removal condition: a later forward migration drops it once no Host reads it (record in `tasks/todos.md`).
  - `createPostgresCoreStores` gains `objectStorage` (the R2 maintenance options) so `ObjectStore.collectExpired` can delete bytes.
  - Maintenance code stays reachable from `./runtime` (stores are already exported there, `runtime.ts:33-60`). `cleanup.ts`, the only `node:crypto` user via dead-letter replay, stays Node-only.
- **Wire and client:** unchanged. `api-surface/{core,cloud,server,cloud-dataplane}.d.ts` are regenerated.
- **Docs:**
  - `deploy/runbooks/cloud-cleanup.md` and `mailbox-retention.md` lose the "SDK does not schedule" text and describe `runMaintenance` plus hosted scheduling.
  - `packages/server/README.md:34-37` becomes: identity fences never expire; prefixes registered as `request` expire by policy (none today). #416 owns the full README maintenance section.
  - `docs/architecture/sdk-architecture.md` updates its retention paragraph, and `cloud-dataplane/README.md` its cleanup paragraph.

## Shared file scopes (exact)

| Scope | Files | Owner / gate |
| --- | --- | --- |
| **#412 exclusive (edits only after B1 handoff completes)** | `core/src/{mailbox,presence,quota,blob,device-assertion,ports-contract}.ts`, `core/src/in-memory/{mailbox,presence,quota,blob,device-assertion-replay}.ts`, `cloud/src/maintenance.ts` (new), `cloud/src/receipt-retention.ts` (new), `cloud/src/activity.ts`, `cloud/src/approval-timeline.ts`, `cloud/src/stores/in-memory/{receipts,nonces,pairing-codes,activity,approval-timeline,blobs}.ts`, `cloud-dataplane/src/stores/{receipts,nonces,pairing-codes,activity,approval-timeline,device-assertion-replay,r2-blobs}.ts`, `cloud-dataplane/src/stores/core/{mailbox,presence,quota,objects,index}.ts`, `cloud-dataplane/src/{cleanup,runtime,index}.ts`, `conformance/src/core/{retention(new),mailbox,timestamps,harness,port-inventory}.ts`, `conformance/src/cloud/{retention(new),harness,port-inventory,receipts}.ts`, `conformance/src/device-assertion-replay.ts`, `deploy/runbooks/*`, `deploy/sql/0024_*` (only if needed), docs | #412 |
| **Shared, #415 first, then handoff to #412** | `cloud/src/stores/ports.ts` (#415 edits `TaskAttemptStore`), `cloud/src/stores/ports-contract.ts`, `cloud/src/cloud.ts` (`runMaintenance` method + options), `cloud/src/inbound.ts` (observer interface; confirm with pY), `cloud/src/index.ts`, `cloud/src/tenant-stores.ts` (only if `deviceAssertionReplay` is threaded), `server/src/index.ts`, `server/src/stores/sqlite/index.ts`, `api-surface/*.d.ts` goldens. `core/src/index.ts` is confirmed free by pY and moves to the #412 set, still gated by B1 | pY → explicit handoff message → #412 |
| **Read-only for #412** | `cloud-dataplane/src/stores/task-attempts.ts`, every `TaskAttemptStore` implementation, stats/dispatch code, `cloud-do/**` | #415 / out of scope |

## Task breakdown (sequential, one writer per file)

Gate: pY asked that all #412 production files stay read-only until the full shared-file handoff. No slice below, S0 included, is authorized to edit before that handoff message arrives. Before it, only this plan file may change.


- **S0 (first slice after B1 handoff).** Write `cloud/src/receipt-retention.ts` with the frozen identity-only `RECEIPT_RETENTION` (11 families), the derived empty `REQUEST_RECEIPT_PREFIXES`, `receiptRetentionClass` and the module-load assertions. Write `cloud/src/maintenance.ts` with the types, `MAINTENANCE_STEPS`, policy validation and the pure `runMaintenanceSteps(ports, input)` executor, with no `ByokCloud` wiring yet. Unit tests:
  - closed step order and a report with exactly 10 entries;
  - per-step error isolation;
  - typed input errors, and a test that no disable value exists;
  - unknown prefix → identity, and every SDK family → identity;
  - module-load assertions hold; `REQUEST_RECEIPT_PREFIXES` is `[]`; the source scan limits its readers to `receipt-retention.ts` and the three receipt drivers;
  - the `not-configured` step carries no counts.
- **S1 Core ports + in-memory drivers.** Add `collectExpired` on mailbox, presence, quota, objects and replay. Remove `collectRetired` and `deleteExpired`. Update `core/src/ports-contract.ts`. In-memory objects delete bytes through a composition-bound deleter (see Q2).
- **S2 Cloud in-memory drivers.** `collectExpired` for receipts, nonces, pairing codes, activity and approvals. Remove the issue-time nonce cleanup.
- **S3 Postgres drivers.** Write the 10 bounded statements. Lift tombstone, delete and settle from `cleanup.ts` into `PostgresObjectStore`, and add `objectStorage` to `createPostgresCoreStores`. Delete `runTenant` and its helpers and add `reconcileObjectStorage`. Optional `0024` index migration, then `check:deploy-sql`.
- **S4 Conformance.**
  - Core suite `packages/conformance/src/core/retention.ts`: seeds every core state, asserts the counts, `≤ limit` per step and `more`, that unacked rows only expire, and that mailbox usage is unchanged by the step apart from derived removal.
  - Cloud suite `packages/conformance/src/cloud/retention.ts` with the `requestPrefixMock` hook: covers receipts (the default run asserts empty prefixes → 0 with all rows intact; mocked runs assert the mock is active and that `test-request:` rows expire up to `limit`; identity and unregistered keys are never deleted), nonces, pairing codes, activity and approvals. Each driver package adds one default and one mocked test file.
  - Quota case: `releasedBytes` equals the sum of `reservedBytes` of the reservations expired in that call; settled-row deletion adds 0.
  - Budget cases:
    - quota: with `limit` expirable reservations plus settled rows present, one call expires `limit` and deletes 0, with `more: true`;
    - objects: with k pending retries and n new orphans, one call touches exactly `min(limit, k + n)` distinct objects, retries first; `removed` = settled count, `expired = 0`;
    - objects: an injected delete failure leaves the tombstone, reports `status: 'failed'` with `failures ≥ 1`, and the object is retried on the next call;
    - for every step: `more` is false when the eligible set is exactly `limit`, and true at `limit + 1`.
  - Mailbox case: `releasedBytes === 0n`, and mailbox usage read before and after equals the value derived from the retained rows.
  - Run both suites against in-memory, SQLite (`server/src/stores/sqlite/__tests__/conformance.test.ts`) and PG (`cloud-dataplane/src/__tests__/{core-,}conformance.test.ts`).
  - Migrate the retention cases in `core/mailbox.ts` and `timestamps.ts`, and the replay cases in `core/src/__tests__/device-assertion.test.ts` and `cloud-dataplane/src/__tests__/device-assertion-replay.test.ts`.
- **S5 (after handoff) ByokCloud wiring.** `cloud.ts` `runMaintenance`, `onMaintenance` in the observer interface, `ports.ts` / `ports-contract.ts` members, exports, plus the replay handle (Q1).
- **S6 (after handoff) Server.**
  - `MaintenanceScheduler` in a new file `server/src/maintenance-scheduler.ts`, wired in `server/src/index.ts`: options, events, `runNow`, `close()` ordering, deletion of `mailbox`. Add SQLite driver `collectExpired` for mailbox, receipts and objects in `server/src/stores/sqlite/index.ts`.
  - Tests in `packages/server/src/__tests__/maintenance-scheduler.test.ts`:
    - jitter bounds under an injected timer and random source;
    - no overlap when a pass outlives the interval;
    - `close()` waits for the in-flight pass before the SQLite close (an assertion on store usage after close);
    - `runNow` joins an in-flight pass;
    - the events.
  - One-day simulated-clock test: acked mailbox rows and expired pairing codes are gone; every identity fence remains; `tasks.get()` `createdAt`/`sessionRef` are unchanged.
  - Migrate `sqlite-receipts`, `issues-112-120-security-reliability`, `server-reliability-regression` and `coordination-characterization`, with a per-assertion rationale in the PR.
- **S7 Hosted cleanup tests + docs + goldens.** Rewrite `cloud-dataplane/src/__tests__/cleanup.test.ts` around the store steps and operator APIs (no `cleanup_job` writes), plus `tenant-erasure.test.ts` references. Update runbooks, READMEs, architecture doc, api-surface and the todos entry for dropping `cleanup_job`.

## Verification

```bash
(cd packages/conformance && bun run test)
(cd packages/core && bun run test) && (cd packages/cloud && bun run test)
(cd packages/server && bun run test -- maintenance-scheduler sqlite-receipts coordination-characterization issues-112-120-security-reliability server-reliability-regression)
docker compose -f docker-compose.test.yml up -d --wait
BYOK_TEST_POSTGRES_URL=postgres://byok:byok@127.0.0.1:5433/byok_test BYOK_TEST_S3_ENDPOINT=http://127.0.0.1:9100 \
  bun run --cwd packages/cloud-dataplane test
bun run build && bun run typecheck && bun run test && bun run check:api-surface && bun run check:deploy-sql && bun run check:version-authority
```

Real PG acceptance, required and not skippable:
- the PG conformance retention suites pass;
- a tenant with acked rows older than retention completes maintenance; this is the #411 failure mode;
- `EXPLAIN` of each step statement shows an index scan, recorded in the PR;
- an R2 object orphaned past grace is deleted and settled, with storage usage decreasing by exactly its accounted bytes;
- no `cleanup_job` rows are written.

## Decisions to confirm (recommended defaults; none guessed into code)

- **Q1 Replay authority has no handle in `ByokCloud` (amended).** `DeviceAssertionReplayAuthority` is composed only into the Host-facing `authenticateHosted*Assertion` deps (`cloud/src/auth/device-assertion.ts:13-16`), not into `CoreStores` or the server. Recommendation: an optional `ByokCloudOptions.deviceAssertionReplay?: DeviceAssertionReplayAuthority`. When it is absent, the `deviceAssertionReplay` step reports `{ status: 'not-configured' }` with no count fields. It is never `ok` with zeros, and it is not `failed`, so a dashboard can tell an unconfigured composition from a clean sweep. The embedded server never configures it, so its reports always show `not-configured` for this step. The server's `maintenance.completed` event still fires, and `not-configured` does not trigger `maintenance.failed`. The runbook tells hosted deployments that use `authenticateHosted*Assertion` to pass the same authority instance to `createByokCloud`, or replay keys are never collected. The rejected alternative is a mandatory `CoreStores` member, which would break every composition for a port the server never uses.
- **Q2 Who deletes object bytes in embedded drivers.** Superseded by D2 below.
- **Q3 Settled-reservation grace.** No policy column exists for it. Recommendation: reuse `objectOrphanGraceMs`, which adds no migration. The consequence is that a finalize or abort retry later than 24h after settlement gets `storage_reservation_not_found` instead of the settled row.
- **Q4 Server `stop()` before #414 lands.** It is synchronous, so it cannot await. Recommendation: `stop()` clears the timer and chains `composition.close()` after the in-flight pass settles. If #414 deletes `stop()` first, this is moot.
- **Q5 Hosted missing policy.** Recommendation: keep failing closed with `cleanup_policy_missing` when reading the policy for `runMaintenance`. Hosted defaults never apply silently. The server uses `DEFAULT_RETENTION_POLICY`.
- **Q6 `ProofRequestReceiptStore` growth.** It is not on the issue's list. Recommendation: identity, never expires in #412. Report it as a gap for a follow-up classification.
- **Q7 Hosted cross-process single flight.** Recommendation: no kernel lock (statements are idempotent); runbook rule "one scheduler per tenant".

## Hard blockers

- **B1 Shared files: resolved 2026-10-14.** pY handed off at `d3aa4a85` (`/tmp/byok-415-shared-handoff.md`); production ownership is the #412 root, with no cherry-pick. Historical text: S5 and S6 need pY's (#415) explicit handoff for `cloud/src/stores/ports.ts`, `ports-contract.ts`, `cloud.ts`, `cloud/src/index.ts`, `server/src/index.ts`, `server/src/stores/sqlite/index.ts` and the api-surface goldens. Confirm with pY whether `cloud/src/inbound.ts` (the observer) and `core/src/index.ts` are free. No #412 production edit happens before the full handoff (pY's request), including the slices on #412-exclusive files. `core/src/index.ts` is confirmed free. After the handoff the order is S0 → S7, and the S2 cloud drivers land together with the S5 `ports.ts` change.
- **B2 Real PG/S3 substrate: resolved.** Docker 29.5.2 is available, so the real-PG acceptance items are mandatory and are not skipped.
- There are no owner-decision blockers. Q1–Q7 have conservative defaults that the parent may accept or override.

## Implementation design forks (2026-10-14, after the #415 handoff)

### D1 Pairing codes (revised under the fixed identity invariant): collect only expired, unused codes. A used code row is protected identity state.

**Fixed constraint.** All 11 SDK receipt families are `identity`, and an identity fence is never deleted except by tenant erasure. Invariant 4 stands unchanged. No maintenance step deletes a `pairing-completion:` receipt, and no maintenance step may make one unreachable either: a fence that can no longer be looked up is erased in effect.

**Lookup as it is today (all three drivers gate on the code):**

| Driver | Code state | Completion fence | Replay lookup |
|---|---|---|---|
| PG | `pairing_code(code PK, tenant_id, product_id, expires_at, redeemed_at)` (`deploy/sql/0001_cloud_local.sql:72-78`) | `device_request_receipts(tenant_id, key, body, recorded_at)`, PK `(tenant_id, key)` (`:152-158`). Key `pairing-completion:v1:sha256:<hex(sha256("byok-pairing-completion-v1\0" + code))>`, body `{"deviceId","binding":{deviceName,devicePublicKey,proofKeyId,proofKeyEpoch,machineId?}}` | `SELECT … FROM pairing_code WHERE code=$1 FOR UPDATE`. A missing row returns `undefined` before the receipt is read. The receipt is read under the row's `tenant_id`, then `sameBinding`, `getDeviceOnClient`, and `sameDevice`, which checks tenant and product from the row (`stores/pairing-codes.ts:170-199`). |
| In-memory and SQLite (SQLite wires the in-memory pairing store with `SqliteDeviceDirectory`, `server/src/stores/sqlite/index.ts:1316`) | `#codes: Map<code, {claims, expiresAtMs, used, completion?}>` | `completion: {device, binding}` inside the code record | Map get; a missing record returns `undefined`. Otherwise `sameBinding` plus `devices.get(completion.device)`. |

Every driver's fence is reachable only through its code. A used code is therefore part of the identity fence, not expiring state.

**Recommendation (option A): collect `!used && expiresAt < now` only.**
- **In-memory** (`cloud/src/stores/in-memory/pairing-codes.ts`): `collectExpired` deletes this tenant's records with `!used && expiresAtMs < nowMs`, up to `limit`, and skips any code with a live `#enrollmentTails` entry. Used records, with their `completion`, are never collected.
- **PG** (`cloud-dataplane/src/stores/pairing-codes.ts`): `DELETE FROM pairing_code WHERE ctid IN (SELECT ctid FROM pairing_code WHERE tenant_id=$1 AND redeemed_at IS NULL AND expires_at < $2 ORDER BY expires_at LIMIT $3 FOR UPDATE SKIP LOCKED)`. Select `limit + 1` to compute `more`. `SKIP LOCKED` leaves a code that an in-flight redemption holds `FOR UPDATE`. No receipt is touched.
- **Boundary.** Redeem accepts while `now <= expiresAt`, so collection uses strict `expiresAt < now` in all drivers. The deleted CTE's `<=` could remove a still-redeemable code.
- **Report and docs.** `removed` counts only the expired-unused codes deleted; the report shape is unchanged. The runbooks and `packages/server/README.md` state the protected state: "a redeemed pairing code is identity state; it is retained with its completion fence and removed only by tenant erasure (`tenant-erasure.ts:56` covers `pairing_code`)". The issue's "expired pairing codes are collected" requirement is met for unused codes; redeemed codes are kept on purpose.
- **Index.** Add a PG partial index on `pairing_code(tenant_id, expires_at) WHERE redeemed_at IS NULL` only if `EXPLAIN` in acceptance shows a sequential scan (in `0024`).
- **Conformance** (all three drivers):
  - an expired unused code is collected;
  - a code whose `expiresAt == now` is not collected;
  - a redeemed code, even past `expiresAt`, is not collected, and it replays (`sameBinding` plus an active device) after any number of passes;
  - a code mid-enrollment is not collected;
  - PG only: the `pairing-completion:` receipt row is unchanged.
- **Behaviour change versus the deleted `runTenant` (hosted).** `runTenant` deleted redeemed codes and so made fences unreachable. Retaining them restores the approved identity lifetime. This is called out in the PR.
- **Growth.** One retained row per successful pairing. That is the same order as the identity receipts themselves (one per pairing), which already never expire.

**Option B (completion-first lookup) is rejected; analysis follows.** Redemption is pre-tenant, and the fence's only key is tenant-scoped `(tenant_id, key)`. Consulting the fence first would need a tenant-free read: `SELECT tenant_id, body FROM device_request_receipts WHERE key=$1`.
- That read requires a new index on `key` alone. It would be a third naked-key, cross-tenant lookup, beyond the whitelisted `device.device_id` and `pairing_code.code` (`0002_core_domain.sql:17`).
- The body lacks `tenantId`/`productId`, so `sameDevice` would have to be re-sourced from the row's `tenant_id` and the device row.
- In-memory and SQLite would need a separate completions map: the never-collected second authority from my first draft.
- Once the code row is gone, a later re-issue of the same code to another tenant cannot find the old tenant's fence. Redemption would then see two candidate fences (ambiguous), or `issue` would have to delete a fence cross-tenant, which violates invariant 4.

  Option B is larger, touches the pre-tenant auth path, and still conflicts with the invariant.

**Reported, not changed by #412.** `PostgresPairingCodeStore.issue` re-minting an existing code deletes that code's completion receipt (`stores/pairing-codes.ts:124-135`). This is an explicit control-plane action that predates #412, and it is the one existing deletion of an identity fence outside tenant erasure. It is flagged for the owner, not altered.

### D2 Embedded object collection: extract the in-memory storage ledger; inject bytes explicitly at construction; no WeakMap.

**Observed coupling.** In-memory and SQLite both use `InMemoryQuotaStore` (`core/src/in-memory/index.ts:46-47`, `server/src/stores/sqlite/index.ts:1290-1291`). Its private `#reservations`, `#usage` and `#committedHashes` are the only authority for "is this hash reserved" and "which bytes were accounted". Quota already depends on objects (`finalizeReservation` calls `objects.commit`), and object collection needs quota's state. That is a real mutual dependency. A callback bound later through a WeakMap would hide it; it does not remove it. PG avoids the problem because both stores share one database.

The in-memory analog of that shared database is one shared state object:

1. **`core/src/in-memory/storage-ledger.ts` (new), `InMemoryStorageLedger`.** It holds the three maps moved verbatim out of `InMemoryQuotaStore`. They are removed from quota, not mirrored, plus the existing `#settle`/`#usageOf`/`#setUsage`/`#hashesOf` logic. Quota keeps its port methods and delegates its state to the ledger. Objects use exactly two ledger methods:
   - `hasReservedObject(tenant, hash): boolean`: any reservation in state `reserved` for that hash, regardless of TTL. The quota step runs first and expires stale ones. It is a linear scan in memory; add a `hash → count` index only if a test shows it is needed.
   - `releaseCollectedObject(tenant, hash, byteSize): bigint`. If the hash is in this ledger's counted set, it removes it, decrements `committedObjectBytes` and `objectCount`, and returns `byteSize`. Otherwise it returns `0n`. This covers the SQLite restart case: manifests persist but the process-local ledger never counted them, so nothing is released and usage cannot underflow.

   No other component reads or writes these maps, so there is no second data authority.
2. **Construction, acyclic and explicit.**
   ```ts
   ledger = new InMemoryStorageLedger();
   objects = new InMemoryObjectStore(clock, { ledger, bytes });
   quota = new InMemoryQuotaStore(clock, objects, ledger);
   ```
   For SQLite: `new SqliteObjectStore(coordinator, clock, ledger)` and `new InMemoryQuotaStore(clock, objects, ledger)`. SQLite needs no `bytes` handle because its bytes are in its own `blob` table.
3. **Bytes are a required composition input, with no default.**
   - `createInMemoryCoreStores({ clock, objectBytes })` takes `objectBytes: ObjectBytes`, where `type ObjectBytes = 'metadata-only' | { deleteObject(tenant: TenantId, hash: ContentHash): void }`.
   - `'metadata-only'` is an explicit declaration that the composition holds no bytes. It is legal only for an honestly byte-free composition: core conformance (`conformance/src/compositions/in-memory-core.test.ts:15`, `createInMemoryCoreCompositionWithClock` at `core/src/in-memory/index.ts:61-66`) and the SQLite composition's dead spare. Every deployed composition binds the real byte owner: the in-memory cloud registry, SQLite's `blob` table (inside `SqliteObjectStore`), or the PG R2 maintenance handle. A test asserts that `createInMemoryByokCloud` and `createByokServer` (both the SQLite and the in-memory path) never pass `'metadata-only'` for the object store they actually use.
   - `deleteObject` is synchronous on purpose; see the algorithm.
   - These are constructor options on a composition factory, not `CoreStores` members and not port methods. Only `InMemoryStorageLedger` and `ObjectBytes` become new exports (from `@byok-sdk/core`), because the server's SQLite composition must construct them.
4. **The in-memory byte registry exists before core.**
   - `cloud/src/stores/in-memory/blobs.ts` gains `createInMemoryBlobBytes(clock, crypto, options)`. It returns an opaque handle that carries the module-private registry plus `objectBytes.deleteObject`. That method removes every registry record and `reservationBlobs` entry with this `tenantId`/`contentHash`.
   - `createInMemoryCloudStores(clock, crypto, objects, mailbox, bytes)` takes the handle instead of creating a registry, and `createInMemoryBlobs` builds its two halves over the handle's registry.
   - Callers to update: `cloud/src/composition/in-memory.ts:106-111`, `server/src/stores.ts:126-129`, the SQLite composition's spare in-memory core and cloud at `server/src/stores/sqlite/index.ts:1304-1310` (pass `'metadata-only'` and a fresh handle; both are already-dead spares, unchanged waste), `conformance/src/compositions/in-memory-cloud.test.ts:16`, `cloud/src/__tests__/{public-route-limiter.test.ts:44-45,route-inventory.test.ts:278-279}` and `server/src/__tests__/server-reliability-regression.test.ts:37,47`.
5. **Bounded objects algorithm.** It is the same for in-memory and SQLite and mirrors the PG step, with one budget ≤ `limit`.
   1. **Retry set R.** Take this tenant's `delete_pending` manifests with `hash` > a process-local per-tenant cursor (the analog of `gc_cursor`), ordered by `hash`. Select `limit + 1` and keep `limit`. The wrap and cursor rule is D5.
   2. **Fill**, only if `|R| < limit`. Candidates are `pending` or `committed` manifests with `refCount = 0`, `updatedAt < orphanBefore` and `!ledger.hasReservedObject`, ordered by (`updatedAt`, `hash`). Select `(limit − |R|) + 1`, then tombstone the first `limit − |R|` (`pending|committed → delete_pending` is legal per `OBJECT_STATE_TRANSITIONS`).
   3. **Per object in R, one atomic unit:**
      - re-check `state === 'delete_pending'` (a re-upload can legally revive `delete_pending → committed`, so skip a revived object) and `!hasReservedObject`;
      - delete the bytes;
      - `delete_pending → deleted`;
      - `released += ledger.releaseCollectedObject(…)`.

      In-memory runs this unit with no `await` between the check and the settle. That is why `deleteObject` is synchronous: no reservation, upload or revival can interleave, and a revived upload's bytes can never be deleted by hash. SQLite runs it as one `coordinator.transaction` (`DELETE FROM blob WHERE tenant_id=? AND content_hash=?` plus the manifest update), followed by the synchronous ledger release in the same tick.
   4. **Failure.** A throwing deleter or transaction leaves the tombstone in place, increments `failures`, and the next call retries it from R.
   5. **Result.** `removed` = settled, `expired = 0`, `releasedBytes = released`. `more` is true if step 1 or step 2 saw a `+1` row, or if any unit failed.
6. **Conformance additions** (core retention suite; the composition supplies either bytes or `'metadata-only'`):
   - a reserved hash is never tombstoned;
   - an object accounted in this ledger releases exactly its `byteSize`, and an uncounted one releases `0n`;
   - a revived `delete_pending → committed` object is skipped, and its bytes survive;
   - with k retries and n orphans, exactly `min(limit, k+n)` objects are touched, retries first;
   - the injected failure case.

   Byte-level assertions (registry or `blob` rows gone) run in the in-memory-cloud and SQLite composition tests, not in the byte-free core composition.
7. **Rejected:**
   - A WeakMap binding. It hides the dependency, still needs an exported binder for the SQLite store in another package, and fails silently for an unbound store.
   - Callbacks implemented as extra public methods on `InMemoryQuotaStore`. These are auxiliary methods on a port class.
   - Moving accounting onto the manifest (the PG shape). That is a correct end state but a larger rewrite than #412 needs.

### D1/D2 files

- **D1:** `cloud/src/stores/in-memory/pairing-codes.ts`, `cloud-dataplane/src/stores/pairing-codes.ts`, `conformance/src/cloud/retention.ts`.
- **D2:**
  - core: `core/src/in-memory/{storage-ledger(new),quota,blob,index}.ts`, `core/src/index.ts`;
  - cloud: `cloud/src/stores/in-memory/{blobs,index}.ts`, `cloud/src/composition/in-memory.ts`;
  - server: `server/src/stores.ts`, `server/src/stores/sqlite/index.ts` (`SqliteObjectStore`);
  - conformance: `conformance/src/core/retention.ts`, the two composition tests;
  - the three caller tests listed in D2 item 4.

  All of these are in the #412 set after the handoff. D2 lands in S1, with the SQLite part in S6.

### Policy shape (fixed 2026-10-14)

- `RetentionPolicy` in `cloud/src/maintenance.ts` keeps the existing names and type: `mailboxAckedRetentionMs`, `mailboxUnackedRetentionMs`, `requestReceiptRetentionMs`, `objectOrphanGraceMs`, all `bigint`.
- The dataplane declares `TenantRetentionPolicyInput extends RetentionPolicy { policyId }` (`cloud-dataplane/src/cleanup.ts:54-60`), so the stored policy passes straight to `runMaintenance`. There is no `toRetentionPolicy`, no alias, and no second field set.
- The server's `maintenance.policy?: Partial<RetentionPolicy>` uses the same names.
- The DB `CHECK` allows `>= 0`, but `runMaintenance` requires `> 0`. A stored zero fails that tenant's pass with `maintenance_invalid_input`. It is fail-closed, never clamped, and documented in the runbook.

### D3 PG physical delete: the revival premise does not hold; the real hazard is recreation. Fix it with a per-object row lock held through the R2 delete (no migration).

**`delete_pending` exits in PG (every writer that changes a DP row):**

| Writer | Transition | Lock |
|---|---|---|
| `PostgresObjectStore.markDeleted` (port, `stores/core/objects.ts` `UPDATE … SET state='deleted' WHERE state='delete_pending'`) | DP → deleted, no byte delete | row (UPDATE) |
| `#settleDeleted` (`cleanup.ts:706-760`, used by the GC delete loop and by `#reconcileManifests` when R2 reports the object absent) | DP → deleted, plus the usage decrement | `FOR UPDATE OF m, u` |
| tenant erasure (`tenant-erasure.ts:28,381`) | row deleted | table-wide erasure |

**Not a DP exit in PG:**
- `commit` (`objects.ts:123-128`, `state='pending'` only);
- `finalizeReservation` (`quota.ts` `manifest_valid` requires `pending|committed`, and its UPDATE requires `m.state='pending'`);
- `reserve`, which refuses a DP hash (`quota.ts:327-330` and `:640-650`);
- `putManifest` and `#reconcileR2`'s witness upsert, which both reset only `WHERE state='deleted'`;
- the ref-count recounts.

So PG has **no `delete_pending → committed` revival**.

**The race that does exist is recreation.** Some other DP exit (a second maintenance pass, `reconcileObjectStorage`, or a Host calling `markDeleted`) moves the row to `deleted`. Then `putManifest` resets it to `pending`, the client uploads to the same hash-keyed R2 object, and `finalize` commits it. If all of that happens between collector A selecting the row into R and A's R2 delete, A deletes committed bytes. A's guarded settle then correctly no-ops, but the bytes are already gone.
- With exactly one DP-exit actor per tenant, network I/O outside the transaction is safe, because nothing can leave DP during A's work.
- The deleted `runTenant` serialized its own passes with a per-tenant advisory lock. #412 removes that lock (Q7: "one scheduler per tenant" is a runbook rule, not enforced), and port `markDeleted` was never covered by it. So outside-transaction I/O is **not** safe for port-conforming concurrent use.

**Recommendation.** Each object in R is one short transaction on one pooled connection:

```sql
BEGIN;
SELECT gc_accounted_bytes, gc_accounted_object FROM object_manifest
 WHERE tenant_id=$1 AND hash=$2 AND state='delete_pending'
   AND gc_accounted_bytes IS NOT NULL AND gc_accounted_object IS NOT NULL
 FOR UPDATE SKIP LOCKED;
-- no row  -> ROLLBACK; the object was skipped (locked by a concurrent pass, or it left DP); set more = true if it was locked
-- row     -> R2 delete (network: the maintenance R2 adapter's `requestTimeoutMs`, default 10000, aborts each attempt; the existing retry is at most 3 attempts plus backoff), then the existing #settleDeleted statement on this client, then COMMIT
-- R2 or settle error -> ROLLBACK; the tombstone stays; failures += 1
```

**Why it is sound.**
- The physical delete happens only while holding the row lock in state DP.
- Every DP exit is an UPDATE of that row, so it must wait.
- Recreation needs a DP exit first, so it cannot happen during the delete.
- After commit the row is `deleted`, and `putManifest` may legally start over.

**Lock order.** The delete transaction takes m, then (in `#settleDeleted`) m and u. Elsewhere:
- `finalize` takes m, then u;
- `reserve` takes entitlement, then u, and never locks m (it only reads m);
- the tombstone transaction takes entitlement, then m with `SKIP LOCKED`, so it never waits on m;
- recount and `addReference` take m only.

The global order is m → u. No transaction holds entitlement across network I/O, and no transaction locks u and then waits on m, so there is no deadlock. The delete phase does **not** take entitlement. The entitlement → manifest step stays only in the tombstone transaction, which is unchanged.

**Admission latency.**
- Tenant admission (`reserve`) is unaffected, because it holds entitlement and u, reads m without a lock, and refuses DP anyway.
- Only writers of the same hash wait, for at most one maintenance R2 delete (≤ 3 attempts × `requestTimeoutMs` plus backoff): `putManifest`'s `ON CONFLICT DO UPDATE` locks the conflicting row, and so do `markDeleted`, recount and reconcile settle. After the wait they see `deleted`, which is correct.
- Cost: one pooled connection held per in-flight object delete, sequentially, at most `limit` per pass.

**Rejected:**
- A claim or lease column plus a migration. It needs a time-based lease expiry (a semantic fallback), and every DP-exit writer would have to honor it. A row lock is enforced by PG and released on crash or disconnect.
- Restoring a tenant advisory lock. It does not cover port `markDeleted`, and it needs a session-pinned connection anyway.
- Holding entitlement across the delete. It would stall all tenant admission for the duration of R2 I/O.

**Files:**
- `cloud-dataplane/src/stores/core/objects.ts`: `collectExpired` with the per-object transaction, which receives the R2 maintenance handle at construction.
- `cloud-dataplane/src/cleanup.ts`: `#settleDeleted` is lifted so it is callable on the caller's client. `reconcileObjectStorage` needs no change, because the collector re-checks DP under the lock.

**Conformance** (PG, real DB):
- With two concurrent `collectExpired` calls on one tenant, each object is R2-deleted exactly once.
- Recreation interleave: while collector A is blocked inside the R2 delete through an injected handle, `markDeleted`, `putManifest` and `commit` for the same hash wait. After A commits, the re-upload succeeds and its bytes survive.
- A locked row is skipped and reported through `more`.

The bound applies only to the maintenance network boundary. The root added `requestTimeoutMs` (default 10000, abort signal) to the real R2 adapter's maintenance calls; the PR records the worst-case lock hold as 3 × timeout plus backoff. Before that change the adapter had no request timeout.

### D4 SQLite: the ledger release must not run inside an async transaction body

**Observed.** `SqliteCoordinator.transaction(op)` (`server/src/stores/sqlite/index.ts:343-359`) does `BEGIN IMMEDIATE`, then `await op(db)`, then `COMMIT`. Even a synchronous `op` yields a microtask at that `await`. The in-memory ledger does not go through the coordinator queue, so ledger readers and writers (quota `reserve`/`finalize`) can run in that gap. Releasing the ledger inside `op` would be visible before `COMMIT`, and a `COMMIT` failure would leave the ledger released while the DB rolled back.

**Recommendation.** Add one coordinator primitive:

```ts
transactionSync<T>(body: (db) => T, afterCommit: (result: T) => void): Promise<T>
// run(db => { BEGIN IMMEDIATE; try { r = body(db); COMMIT } catch { ROLLBACK; throw }; afterCommit(r); return r })
```

`body`, `COMMIT` and `afterCommit` run in one synchronous JavaScript segment with no `await`, so no reservation or finalize can interleave.

The SQLite objects unit then runs as follows:
- In `body`: re-check `state='delete_pending'`, check `!ledger.hasReservedObject(tenant, hash)` (a synchronous read in the same segment), `DELETE FROM blob WHERE tenant_id=? AND content_hash=?`, and update the manifest to `deleted`.
- In `afterCommit`: `ledger.releaseCollectedObject(…)`, the post-commit ledger mutation.
- On a thrown `COMMIT` or body: `ROLLBACK`, with the ledger untouched.

All other database access is serialized by the coordinator queue, so new blob rows for a re-reserved hash can only land after this transaction.

**Rejected:** a ledger checkpoint and rollback. It needs a snapshot copy of the maps, a second transient authority, and restore logic. The synchronous post-commit release is smaller and has no copy.

**Files:** `server/src/stores/sqlite/index.ts` (`SqliteCoordinator.transactionSync`, `SqliteObjectStore.collectExpired`). The existing async `transaction` is unchanged.

**Test:**
- An injected `COMMIT` failure leaves the ledger usage unchanged.
- A reserve issued concurrently with collection observes either the pre-commit state (ledger not yet released, row still DP, so the reserve proceeds against the old manifest) or the post-commit state (released, row `deleted`). It never observes a half-applied state.

### Reported separately, not fixed in #412: DP revival divergence between drivers

- In-memory (`core/src/in-memory/blob.ts` `commit` → `#transition` via `OBJECT_STATE_TRANSITIONS.delete_pending` including `committed`; `putManifest` returns an existing DP entry) and SQLite (the same transition table) allow `delete_pending → committed` revival. `InMemoryQuotaStore.reserve` does not refuse a DP hash.
- PG refuses DP at `reserve` and allows only `pending → committed`.
- The core transition table and two drivers therefore disagree with PG. #412's D2 unit keeps its "re-check DP, skip revived" guard because in-memory and SQLite really do revive.
- Follow-up issue: pick one semantic and align `OBJECT_STATE_TRANSITIONS`, the drivers and conformance.

### D5 Objects budget fairness: the cursor wraps only after a pass with no retries beyond it

**Counterexample to the first sketch (accepted).** `limit = 1`, h1 is `delete_pending` and its delete always fails, and h2 and h3 are fresh orphans. "Retry first, rotate with wrap" puts h1 in R on every pass, so the fill phase never gets a slot. The deleted `runTenant` did not have this problem, because it tombstoned with its own budget before it ran deletes.

**The proposed three-phase rule has the opposite starvation.** The proposal is: retry DP > cursor, then fresh orphans, then wrap DP ≤ cursor into unused slots. If fresh orphans keep arriving at ≥ `limit` per pass, phase 3 never gets a slot. The cursor then stays at the end, phase 1 stays empty, and failed deletes are never retried.

**Rule (one distinct-object budget, `limit`, per pass):**
1. **P1, retries:** DP hashes `> cursor`, ordered by hash, up to `limit + 1`. Keep at most `limit`.
2. **P2, fresh:** tombstone fresh orphans (the existing gate and order) into the remaining slots, selecting `slots + 1`.
3. **P3, wrap:** if slots remain, DP hashes `<= cursor` that are not already in R, ordered by hash, selecting `slots + 1`.
4. **Cursor after the pass:**
   - if P3 took any row, the cursor becomes the last P3 hash;
   - otherwise, if P1 took any row, it becomes the last P1 hash;
   - otherwise (P1 empty: the cursor was already at the end), it resets to `''`, so the next pass starts a new cycle.

   PG persists this in `gc_cursor`; in-memory and SQLite keep it per tenant in the process.
5. **Delete and settle** every row of R as in D3/D4. `more` is any `+1` look-ahead in P1, P2 or P3, or any failure.

**Progress, in the worst case.** Let D be the DP rows that keep failing, with L = `limit`.
- A cycle is the run of passes from cursor `''` until a pass in which P1 is empty. P1 advances strictly through `hash > cursor`, so a cycle has at most ⌈|D| / L⌉ + 1 passes.
- In the pass that ends a cycle, P1 is empty, so P2 gets all L slots. Fresh orphans therefore make progress of at least min(L, eligible) every cycle, whatever D does.
- Every DP row with `hash > cursor` at the start of a cycle is retried within that cycle by P1. A row tombstoned behind the cursor is reached next cycle (or earlier, by P3). So no failing row is starved by sustained fresh inflow either.

**Re-check against the counterexample (L = 1):**

| Pass | P1 | P2 | Cursor after |
|---|---|---|---|
| 1 | {h1}, fails | — | h1 |
| 2 | {} | h2 deleted | `''` |
| 3 | {h1}, fails | — | h1 |
| 4 | {} | h3 deleted | `''` |

Both progress. With no inflow, P3 retries h1 every pass.

**Bound.** P1 and P3 are disjoint (`> cursor` versus `<= cursor`), and P3 excludes the rows this pass tombstoned. So R holds at most `limit` distinct objects.

**Files:** `cloud-dataplane/src/stores/core/objects.ts` (PG, `gc_cursor` read and write in the selection transaction), `core/src/in-memory/blob.ts`, and `server/src/stores/sqlite/index.ts` (`SqliteObjectStore`).

**Conformance**, on all three drivers:
- the L = 1 counterexample above, with the injected failing deleter;
- sustained inflow of L fresh orphans per pass plus one failing row: the failing row is retried within ⌈|D| / L⌉ + 1 passes;
- no pass touches more than L distinct objects.

### D6 PG construction binding (root implementation detail, recorded 2026-10-14)

- `PostgresObjectStore` requires the physical R2 deleter as a constructor argument. There is no optional parameter and no metadata-only construction path left behind.
- `createPostgresCoreStores` requires `R2ObjectMaintenanceOptions` and builds the real R2 maintenance adapter, using `requestTimeoutMs` per D3.
- Standalone metadata tests and Worker probes are migrated to real R2 bindings. Fake byte handles appear only in tests that inject a fault on purpose.
- This applies the no-compatibility-fallback rule and the deployed-composition byte guard from D2: every deployed composition binds its real byte owner (in-memory registry, SQLite `blob` table, or R2). `'metadata-only'` stays limited to byte-free core conformance and the SQLite dead spare.

### D7 Quota settled-row GC: committed reservation rows are accounting identity; collect only `expired` and `aborted` rows after grace

**Paths traced (PG, `cloud-dataplane/src/stores/core/quota.ts`):**
- **`reserve`** takes the entitlement lock, refuses a hash in `delete_pending` (object kind), and inserts a `reserved` row.
- **`finalizeReservation`**, a candidate CTE:
  - `manifest_valid`;
  - `inline_deduplicated = EXISTS (storage_reservation p WHERE tenant, content_hash, p.state = 'committed')`. There is **no kind filter**, so a committed *object* row also witnesses an *inline* hash;
  - `committed_manifest`, which moves the manifest from `pending` to `committed`;
  - `settled.deduplicated = object ? NOT EXISTS committed_manifest : inline_deduplicated`;
  - `accounted`, which adds bytes only when `NOT deduplicated`.
- **Replay of a committed reservation** returns the stored `deduplicated` flag (`:386-394`).
- **Nothing releases inline bytes.** The only other writer of `committed_inline_bytes` is `truth-committer.ts:625-640`, which adds signed deltas for truth bodies and never touches reservations.
- **Callers.** The only SDK production caller of `reserve` is `cloud/src/handlers/blobs.ts:82` with `kind: 'object'`. Inline reservations exist on the public `QuotaStore` port (through the tenant-stores projection) and in conformance.

**Counterexample 1 (inline; yours, confirmed).** `r1` inline H, 100 B, is finalized: EXISTS is false, so `+100`. GC deletes `r1` after grace. `r2` inline H, 100 B, is finalized: EXISTS is now false, so `+100` again. Without GC, `r2` would deduplicate (`+0`). GC changed an accounting outcome: committed inline bytes went from 100 to 200 for one hash. In-memory keeps H in the ledger's counted-hash set, so the drivers diverge.

**Counterexample 2 (breaks option A as proposed).** `r_o` object H is committed (object bytes counted). Under option A, GC deletes `r_o` after grace while the object stays live. Then inline H is finalized: PG's EXISTS no longer sees `r_o`, so the inline bytes are counted, whereas before GC it deduplicated. So "collect committed OBJECT rows, because their dedup authority is `object_manifest`" holds for object finalize but not for PG inline finalize, which also uses committed object rows as witnesses.

**Recommendation (A′, the smallest rule that changes no accounting outcome):** the quota step collects `state IN ('expired', 'aborted') AND settled_at < cutoff` only. Every `committed` row of either kind is protected accounting identity:
- it is the PG dedup witness set;
- it is the stored replay answer.

Apply the same predicate in in-memory and SQLite (the ledger's reservation map) so replay semantics stay equal.
- No new table, migration or fallback. The committed rows already are the persistent accounting ledger, so a separate one is not required.
- Document them next to the redeemed pairing codes: "committed storage reservations are accounting identity; retained; removed only by tenant erasure".
- Growth: one row per successful finalize. That is the same order as `object_manifest` and truth rows, which are also retained.
- Q3 changes accordingly: replay of a committed reservation never returns `storage_reservation_not_found`, because committed rows are never collected. The Q3 consequence now applies only to expired and aborted rows, which already answer `storage_reservation_expired`.

**Rejected:**
- **Option A**, because of counterexample 2.
- **Also collecting `committed AND deduplicated` rows.** They are redundant witnesses only if every deduplicated row has a non-deduplicated counting row for the same hash. The port's `ObjectStore.commit` can commit a manifest without any reservation, after which an object finalize deduplicates with no counting row. Deleting that row then changes PG inline EXISTS. This is unsafe without a dedicated witness.
- **A new persistent counted-hash ledger** (a migration). It is needed only if the owner later wants committed rows collected, and it is outside #412.

**Settled-row requirement.** The issue's "settled rows after grace" is met for `expired` and `aborted`, which are the abandoned holds. The committed exception is narrow and justified by invariant 3: maintenance never changes accounting. It is the same pattern as the redeemed pairing codes in D1, and is documented in the runbook and PR.

**Conformance** (all three drivers):
- inline H finalized → maintenance passes past grace → a new inline H reservation finalizes `deduplicated: true` with usage unchanged;
- object H committed → maintenance passes → inline H still deduplicates;
- committed rows survive any number of passes, and replay returns the stored flag;
- expired and aborted rows are collected after grace, at most `limit`, with correct `more`;
- the quota step's `releasedBytes` comes only from `reserved → expired`.

**Reported separately, not fixed in #412 (pre-existing dedup divergence):**
1. Cross-kind dedup differs. PG inline deduplicates against any committed row, object or inline, while PG object deduplicates only by manifest. In-memory uses one counted-hash set for both kinds, so object-after-inline also deduplicates in memory but not in PG.
2. PG can undercount inline after an object is deleted. After object H is GC-deleted and its bytes released, its committed object row remains, so a later inline H deduplicates against bytes that are no longer counted. In-memory, after D2, removes H from the counted set on release, so it counts the inline. The drivers diverge after object GC; the root cause is the cross-kind witness, which predates #412.

Follow-up issue: one counted-hash authority per kind, aligned across drivers.
