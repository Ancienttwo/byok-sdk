// ==== @byok-sdk/cloud-dataplane dist/cleanup.d.ts ====
import { type Clock, type MailboxMessage, type TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
import { type R2BlobStoreOptions, type R2ObjectMaintenance } from './stores/r2-blobs';
export declare const CLOUD_CLEANUP_ERROR_CODES: {
    readonly cleanup_invalid_input: 'cleanup_invalid_input';
    readonly cleanup_policy_missing: 'cleanup_policy_missing';
    readonly cleanup_job_running: 'cleanup_job_running';
    readonly cleanup_dead_letter_not_found: 'cleanup_dead_letter_not_found';
    readonly cleanup_accounting_drift: 'cleanup_accounting_drift';
};
export type CloudCleanupErrorCode = (typeof CLOUD_CLEANUP_ERROR_CODES)[keyof typeof CLOUD_CLEANUP_ERROR_CODES];
export declare class CloudCleanupError extends Error {
    readonly code: CloudCleanupErrorCode;
    constructor(code: CloudCleanupErrorCode, message: string, options?: ErrorOptions);
}
export interface TenantRetentionPolicyInput {
    readonly policyId: string;
    readonly mailboxAckedRetentionMs: bigint;
    readonly mailboxUnackedRetentionMs: bigint;
    readonly requestReceiptRetentionMs: bigint;
    readonly objectOrphanGraceMs: bigint;
}
export interface TenantRetentionPolicy extends TenantRetentionPolicyInput {
    readonly tenantId: TenantId;
    readonly updatedAt: string;
}
export type CleanupJobState = 'running' | 'completed' | 'completed_with_errors' | 'failed';
export interface CloudCleanupResult {
    readonly tenantId: TenantId;
    readonly jobId: string;
    readonly state: CleanupJobState;
    readonly startedAt: string;
    readonly finishedAt?: string;
    readonly mailboxDeletedCount: bigint;
    readonly mailboxExpiredCount: bigint;
    readonly mailboxReleasedBytes: bigint;
    readonly reservationsExpired: bigint;
    readonly ttlRowsDeleted: bigint;
    readonly objectsTombstoned: bigint;
    readonly objectsDeleted: bigint;
    readonly objectReleasedBytes: bigint;
    readonly orphanWitnessesCreated: bigint;
    readonly missingObjects: bigint;
    readonly shapeDrift: bigint;
    readonly invalidObjectKeys: bigint;
    readonly operationErrors: bigint;
    readonly errorMessage?: string;
}
export interface DeadLetterQuery {
    readonly deviceId?: string;
    /** Exclusive composite cursor; use the last message from the prior page. */
    readonly after?: DeadLetterRef;
    readonly limit?: number;
}
export interface DeadLetterPage {
    readonly messages: readonly MailboxMessage[];
    readonly hasMore: boolean;
}
export interface DeadLetterReplayInput {
    readonly deviceId: string;
    readonly seq: number;
    /** Operator-issued idempotency key for the new delivery. */
    readonly replayMessageId: string;
}
export interface DeadLetterRef {
    readonly deviceId: string;
    readonly seq: number;
}
export interface ObjectUsageRebuildResult {
    readonly committedObjectBytes: bigint;
    readonly objectCount: bigint;
    readonly updatedAt: string;
}
export interface PostgresCloudCleanupOptions {
    readonly pool: Pool;
    readonly clock: Clock;
    readonly objectStorage: R2ObjectMaintenance;
    readonly batchSize?: number;
}
export interface PostgresCloudMaintenanceOptions {
    readonly pool: Pool;
    readonly clock: Clock;
    readonly objectStorage: Omit<R2BlobStoreOptions, 'objects'>;
    readonly batchSize?: number;
}
export declare class PostgresCloudCleanup {
    #private;
    constructor(options: PostgresCloudCleanupOptions);
    writeRetentionPolicy(tenant: TenantId, input: TenantRetentionPolicyInput): Promise<TenantRetentionPolicy>;
    readRetentionPolicy(tenant: TenantId): Promise<TenantRetentionPolicy>;
    /** Run one bounded tenant maintenance cycle. Completed job ids are replay-safe. */
    runTenant(tenant: TenantId, jobId: string): Promise<CloudCleanupResult>;
    listDeadLetters(tenant: TenantId, query?: DeadLetterQuery): Promise<DeadLetterPage>;
    /** Clone an expired row to a new monotonic seq. The original remains evidence. */
    replayDeadLetter(tenant: TenantId, input: DeadLetterReplayInput): Promise<MailboxMessage>;
    /** Explicit operator discard. Automatic retention never deletes dead letters. */
    discardDeadLetter(tenant: TenantId, ref: DeadLetterRef): Promise<MailboxMessage>;
    /**
     * Explicit recovery operation: rebuild object accounting from committed
     * Postgres manifests. Reconciliation must run first; R2 LIST is never used as
     * billing authority and inline/mailbox usage is left untouched.
     */
    rebuildObjectUsage(tenant: TenantId): Promise<ObjectUsageRebuildResult>;
}
/** Build the maintenance composition against the same Postgres/R2 authority. */
export declare function createPostgresCloudMaintenance(options: PostgresCloudMaintenanceOptions): PostgresCloudCleanup;
// ==== @byok-sdk/cloud-dataplane dist/index.d.ts ====
/**
 * `@byok-sdk/cloud-dataplane` — the durable data plane.
 *
 * `cloud-dataplane → core + cloud + protocol + pg`, and never the reverse. The two
 * platform-neutral packages stay loadable on Workers precisely because the
 * database driver lives here (design §4): `@byok-sdk/cloud` is a stateless handler
 * package, and a `hono` user must not be made to install `pg` to use it.
 *
 * The package name follows its hosted role rather than leaking one storage
 * technology into the public identity. Postgres remains the transaction
 * authority and R2/S3-compatible storage remains the byte plane; a future
 * alternative composition must use a distinct package name rather than making
 * this authority conditional at runtime.
 *
 * Two entries, one online surface:
 *
 * - `.` (this file) is the superset: the online request path plus the Node-only
 *   operations — the migration runner, the migrations directory, and the
 *   cleanup/maintenance composition — that a resident Node/VPS service runs
 *   in-process.
 * - `./runtime` is the Worker-loadable online surface alone, and is the single
 *   authority for the online export list: this file re-exports it wholesale
 *   rather than duplicating it, so the two entries cannot drift.
 *
 * The invariant that makes the split real: the `./runtime` subgraph must never
 * reach a node builtin. It is enforced at build time by the neutral-platform
 * tsup pass over `src/runtime.ts`, and pinned by the runtime-entry test.
 */
export * from './runtime';
export { MigrationChecksumMismatchError, MigrationFilenameError, MigrationStateMismatchError, migrate, readMigrationFiles, verifyMigrations, } from './migrate';
export type { MigrationFile, MigrationResult, MigrationStateIssue, MigrationVerificationRow, } from './migrate';
export { migrationsDir } from './migrations-dir';
export { CLOUD_CLEANUP_ERROR_CODES, CloudCleanupError, PostgresCloudCleanup, createPostgresCloudMaintenance, } from './cleanup';
export type { CleanupJobState, CloudCleanupErrorCode, CloudCleanupResult, DeadLetterPage, DeadLetterQuery, DeadLetterRef, DeadLetterReplayInput, ObjectUsageRebuildResult, PostgresCloudCleanupOptions, PostgresCloudMaintenanceOptions, TenantRetentionPolicy, TenantRetentionPolicyInput, } from './cleanup';
export { TENANT_ERASURE_ERROR_CODES, TENANT_ERASURE_TABLES, PostgresTenantErasure, TenantErasureError, createPostgresTenantErasure, } from './tenant-erasure';
export type { PostgresTenantErasureCompositionOptions, PostgresTenantErasureOptions, TenantErasureConflict, TenantErasureErrorCode, TenantErasureReadback, TenantErasureResult, TenantErasureStatus, } from './tenant-erasure';
// ==== @byok-sdk/cloud-dataplane dist/migrate.d.ts ====
import type { Pool } from 'pg';
/** One file on disk, already ordered and checksummed. */
export interface MigrationFile {
    /** The filename, e.g. `0001_cloud_local.sql`. This is the ledger's `version`. */
    readonly version: string;
    /** The four-digit prefix as a number, used for ordering only. */
    readonly ordinal: number;
    readonly checksum: string;
    readonly sql: string;
}
/** What a run did. `applied` is empty when the database was already up to date. */
export interface MigrationResult {
    readonly applied: readonly string[];
    readonly alreadyApplied: readonly string[];
}
/** The exact package-owned row returned after a successful ledger readback. */
export interface MigrationVerificationRow {
    readonly version: string;
    readonly checksum: string;
}
export type MigrationStateIssue = {
    readonly kind: 'missing';
    readonly version: string;
    readonly expectedChecksum: string;
} | {
    readonly kind: 'unexpected';
    readonly version: string;
    readonly actualChecksum: string;
} | {
    readonly kind: 'checksum_mismatch';
    readonly version: string;
    readonly expectedChecksum: string;
    readonly actualChecksum: string;
} | {
    readonly kind: 'ledger_missing';
    readonly table: 'byok_schema_migration';
};
/**
 * The database's migration state does not exactly match this package's files.
 *
 * This is deliberately aggregate and fail-closed: a host can report every
 * drift fact in one readiness result, but it cannot continue as though a
 * partially matching schema were usable.
 */
export declare class MigrationStateMismatchError extends Error {
    readonly issues: readonly MigrationStateIssue[];
    constructor(issues: readonly MigrationStateIssue[], options?: ErrorOptions);
}
/**
 * A published migration file changed after it was applied.
 *
 * Fail-closed by design: the runner cannot know whether the edit was a harmless
 * comment or a dropped column, and a deployment that guesses wrong corrupts a
 * schema. The fix is a NEW migration file, never an edit to an old one.
 */
export declare class MigrationChecksumMismatchError extends Error {
    readonly version: string;
    readonly expectedChecksum: string;
    readonly actualChecksum: string;
    constructor(version: string, expectedChecksum: string, actualChecksum: string);
}
/** A file in the migration directory that the naming contract does not admit. */
export declare class MigrationFilenameError extends Error {
    readonly filename: string;
    constructor(filename: string, reason: string);
}
/**
 * Reads and orders the migration files in `directory`.
 *
 * Ordering is by the four-digit prefix, not by whatever order the filesystem
 * hands back — `readdir` makes no promise, and on some filesystems it is
 * effectively insertion order. A non-conforming filename or a duplicated prefix
 * is an error rather than a skip: silently ignoring a `.sql` file someone
 * dropped in this directory is how a migration goes missing.
 */
export declare function readMigrationFiles(directory: string): Promise<readonly MigrationFile[]>;
/**
 * Reads the package migration files and the existing ledger, then requires an
 * exact version/checksum match.
 *
 * The default directory is the migration projection shipped by this package.
 * This function only reads state: it never creates the ledger, applies a
 * migration, or synthesizes a compatible result for a missing/changed row.
 */
export declare function verifyMigrations(pool: Pool, directory?: string): Promise<readonly MigrationVerificationRow[]>;
/**
 * Applies every pending migration in `directory`, in prefix order.
 *
 * @param pool The pool to migrate. One client is checked out for the whole run
 *   because the advisory lock is session-scoped.
 * @param directory Absolute path to the migration directory (this repo's
 *   `deploy/sql/`). Required rather than defaulted: a published package cannot
 *   guess where its consumer keeps deployment assets, and guessing wrong would
 *   mean silently migrating nothing.
 */
export declare function migrate(pool: Pool, directory: string): Promise<MigrationResult>;
// ==== @byok-sdk/cloud-dataplane dist/migrations-dir.d.ts ====
/**
 * Absolute path to the migration directory shipped inside this package, ready
 * to hand to {@link migrate}. The directory exists in an installed package and
 * in this repository after a build; it does not exist in an unbuilt checkout,
 * where `deploy/sql/` is the thing to read.
 */
export declare function migrationsDir(): string;
// ==== @byok-sdk/cloud-dataplane dist/pool.d.ts ====
import type { Pool, PoolClient, PoolConfig } from 'pg';
export interface ByokPoolOptions extends Omit<PoolConfig, 'types'> {
    /** `postgres://user:password@host:port/database`. */
    readonly connectionString: string;
    /**
     * Where an IDLE client's error goes. See {@link createByokPool} — a pool
     * MUST carry an `'error'` listener or an idle-backend reset crashes the host.
     * This is where the host takes over that policy (log to its own sink, page,
     * increment a metric). It is NOT a `PoolConfig` field, so it is stripped
     * before the config reaches `pg.Pool`, exactly as `types` is kept off the
     * process-wide registry.
     *
     * Left unset, the pool still gets a listener — an observable default, not a
     * silent swallow.
     */
    readonly onPoolError?: (err: Error, client?: PoolClient) => void;
}
/**
 * Creates a pool wired with the int8 parser above.
 *
 * The caller owns the pool's lifetime: this package never holds a module-level
 * pool, because a process that composes two deployments (a migration runner and
 * a serving path, say) has to be able to close one without breaking the other.
 *
 * The `'error'` listener is MANDATORY, not defensive. A `pg.Pool` emits
 * `'error'` when a client that is sitting IDLE in the pool has its backend
 * connection reset from under it — a failover, an operator
 * `pg_terminate_backend`, an idle-timeout on a proxy, a network blip. There is
 * no `await` in flight to reject at that moment, so `pg` surfaces it on the
 * pool, and Node's rule for an `EventEmitter` `'error'` with no listener is to
 * rethrow it as an uncaught exception — which terminates the whole host
 * process. A bare `new pg.Pool(...)` therefore hands the host a latent crash on
 * an event it cannot see coming and did not cause. The listener converts that
 * into a handled, observable event: routed to the host's {@link
 * ByokPoolOptions.onPoolError} when supplied, or to a labelled `console.error`
 * so the reset is never invisible. It does not paper over live query errors —
 * those still reject their own `await`; this is only the idle-client path.
 */
export declare function createByokPool(options: ByokPoolOptions): Pool;
// ==== @byok-sdk/cloud-dataplane dist/runtime.d.ts ====
/**
 * The Worker-loadable online surface of `@byok-sdk/cloud-dataplane`.
 *
 * This entry is the single authority for the online request-path exports:
 * the pool factory, the cloud-local stores (including the R2 blob exports),
 * the core stores, and the truth committer. Everything reachable from here
 * is the portable half of the package — `pg` over TCP, `aws4fetch` over
 * `fetch`, and nothing else — so the same bundle loads on Cloudflare Workers
 * (`nodejs_compat` + Hyperdrive, with `pg` left external to the host bundler)
 * as well as on Node.
 *
 * The Node-only operations — `migrate`, `migrationsDir`, and the cleanup /
 * maintenance composition — deliberately stay on the package root
 * (`./index.ts`) and never appear here. They read migration files off disk
 * and hash with `node:crypto`, none of which exists on a Worker. The host
 * picks the composition explicitly at wiring time: a Worker imports
 * `@byok-sdk/cloud-dataplane/runtime` and runs its migrations from a Node
 * process; a resident Node service imports the root. Nothing in this package
 * detects its host or falls back across the two.
 *
 * The build enforces the boundary: `tsup.config.ts` compiles this entry with
 * `platform: 'neutral'`, so an import of a node builtin anywhere in this
 * subgraph is a build failure rather than a Worker that breaks at deploy
 * time. The declaration build (`tsconfig.build.json`) emits the matching
 * `dist/runtime.d.ts`.
 */
export { createByokPool } from './pool';
export type { ByokPoolOptions } from './pool';
export { PostgresDeviceDirectory, PostgresInboundDedupStore, PostgresNonceStore, PostgresPairingCodeStore, PostgresProofRequestReceiptStore, PostgresRequestReceiptStore, PostgresTaskAttemptStore, PostgresTaskCancellationStore, PostgresActivityStore, PostgresApprovalTimelineStore, PostgresDeviceAssertionReplayAuthority, PostgresAgentMemoryProjectionStore, createPostgresAgentMemoryProjectionStore, createPostgresCloudStores, } from './stores/index';
export type { PostgresCloudStoreOptions, PostgresCloudStores, PostgresObjectStorageOptions, PostgresAgentMemoryProjectionStoreOptions, } from './stores/index';
export { DEFAULT_MAX_ATTEMPTS, DEFAULT_PRESIGN_TTL_SECONDS, DEFAULT_RETRY_DELAY_MS, MAX_PRESIGN_TTL_SECONDS, MIN_PRESIGN_TTL_SECONDS, ObjectStoreRequestError, R2_BLOB_ERROR_CODES, R2BlobStoreError, R2CloudBlobStore, R2ObjectMaintenanceStore, } from './stores/index';
export type { ObjectStoreFetch, R2BlobErrorCode, R2BlobStoreOptions } from './stores/index';
export type { R2DeleteResult, R2ListedObject, R2ObjectMaintenance, R2ObjectMaintenanceOptions, R2ObjectPage, } from './stores/index';
export { PostgresBoardStore, PostgresMailboxStore, PostgresObjectStore, PostgresPresenceStore, PostgresQuotaStore, PostgresSkillPackStore, PostgresTruthStore, createPostgresCoreStores, } from './stores/core/index';
export type { PostgresCoreStoreOptions } from './stores/core/index';
export { PostgresTruthCommitter } from './truth-committer';
export type { PostgresTruthCommitterOptions } from './truth-committer';
// ==== @byok-sdk/cloud-dataplane dist/stores/activity.d.ts ====
import { type ActivityAppendInput, type ActivityStore, type ActivityTail } from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
export declare class PostgresActivityStore implements ActivityStore {
    private readonly pool;
    private readonly clock;
    constructor(pool: Pool, clock: Clock);
    append(tenant: TenantId, input: ActivityAppendInput): Promise<ActivityTail>;
    read(tenant: TenantId, taskId: string): Promise<ActivityTail | undefined>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/agent-egress.d.ts ====
import type { AgentEgressRecord, AgentEgressStore } from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
/** Postgres implementation of the immutable reliable Agent egress receipt fact. */
export declare class PostgresAgentEgressStore implements AgentEgressStore {
    private readonly pool;
    private readonly clock;
    constructor(pool: Pool, clock: Clock);
    record(tenant: TenantId, input: Omit<AgentEgressRecord, 'tenantId' | 'recordedAt'>): Promise<{
        readonly record: AgentEgressRecord;
        readonly created: boolean;
    }>;
    get(tenant: TenantId, deviceId: string, eventId: string): Promise<AgentEgressRecord | undefined>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/agent-memory-projection.d.ts ====
/**
 * Postgres authority for the optional, one-way hosted Agent-memory projection.
 *
 * The only stored body is the latest accepted redacted snapshot. Immutable
 * receipt rows retain the complete non-body replay binding and byte metering so
 * an old exact retry is still provable after the head advances or an epoch is
 * superseded. Neither table has a raw-source hash, cwd, path, or audit body.
 */
import { type AgentMemoryProjectionCommitInput, type AgentMemoryProjectionEraseResult, type AgentMemoryProjectionReceipt, type AgentMemoryProjectionStore, type CloudCrypto } from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
export interface PostgresAgentMemoryProjectionStoreOptions {
    readonly pool: Pool;
    readonly clock: Clock;
    /** The same Worker-safe crypto authority used by the hosting cloud composition. */
    readonly crypto: Pick<CloudCrypto, 'randomUuid' | 'sha256'>;
}
/**
 * A transaction-scoped Postgres projection store. The per-source advisory lock
 * closes the empty-head race without creating a separate lock row or making a
 * tenant-wide writer bottleneck; erase takes the identical lock.
 */
export declare class PostgresAgentMemoryProjectionStore implements AgentMemoryProjectionStore {
    #private;
    constructor(options: PostgresAgentMemoryProjectionStoreOptions);
    commit(input: AgentMemoryProjectionCommitInput): Promise<AgentMemoryProjectionReceipt>;
    /** Delete body/receipts but retain a body-free epoch fence under one source lock. */
    erase(input: {
        readonly tenantId: TenantId;
        readonly agentId: string;
    }): Promise<AgentMemoryProjectionEraseResult>;
}
/** Build the runtime-safe Postgres implementation of the optional cloud port. */
export declare function createPostgresAgentMemoryProjectionStore(options: PostgresAgentMemoryProjectionStoreOptions): AgentMemoryProjectionStore;
// ==== @byok-sdk/cloud-dataplane dist/stores/approval-timeline.d.ts ====
import { type ApprovalTimelineAppendInput, type ApprovalTimelineStore, type ApprovalTimelineTail } from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
export declare class PostgresApprovalTimelineStore implements ApprovalTimelineStore {
    private readonly pool;
    private readonly clock;
    constructor(pool: Pool, clock: Clock);
    append(tenant: TenantId, input: ApprovalTimelineAppendInput): Promise<ApprovalTimelineTail>;
    read(tenant: TenantId, taskId: string): Promise<ApprovalTimelineTail | undefined>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/core/board.d.ts ====
/**
 * Postgres {@link BoardStore} (§12.3).
 *
 * Every mutation is one guarded `UPDATE ... WHERE`, and the guard carries the
 * caller's whole expectation: who holds the item, what status it is in, and —
 * for `claim` — that it is claimable at all. Zero rows is the rejection, and
 * the store then re-reads the item to say WHICH rejection and to hand the
 * caller the snapshot it lost to. A conflict that reports only "conflict"
 * forces a second round trip and invites a retry loop that eventually
 * overwrites the winner (§12.3: no silent last-write-wins).
 *
 * The concurrent-claim property comes out of Postgres' own re-check: three
 * sessions issue the same `UPDATE ... WHERE holder_id IS NULL`, one wins, and
 * the other two re-evaluate the qual against the winner's committed row and
 * match nothing. The suite asserts the outcome, not the mechanism — the
 * in-memory reference gets the same outcome from its `await` boundaries.
 *
 * **`board_seq` is allocated in its own statement, before the guarded write.**
 * Folding the allocator into a data-modifying CTE would let one session lock
 * `tenant_stream` then `board_item` while another locks them in the order the
 * planner picked for it, which is a deadlock rather than a conflict. Allocating
 * first, in an autocommitted statement that releases immediately, gives every
 * writer one lock order. A rejected write therefore burns a sequence number:
 * `boardSeq` is contractually monotonic, never contractually gapless, and the
 * incremental feed reads `> afterSeq` either way.
 */
import { type BoardClaimInput, type BoardItem, type BoardItemInput, type BoardListQuery, type BoardPage, type BoardStatusUpdateInput, type BoardStore, type BoardUnclaimInput, type Clock, type TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
export declare class PostgresBoardStore implements BoardStore {
    #private;
    constructor(pool: Pool, clock: Clock);
    create(tenant: TenantId, input: BoardItemInput): Promise<BoardItem>;
    get(tenant: TenantId, itemId: string): Promise<BoardItem | undefined>;
    list(tenant: TenantId, query: BoardListQuery): Promise<BoardPage>;
    claim(tenant: TenantId, input: BoardClaimInput): Promise<BoardItem>;
    unclaim(tenant: TenantId, input: BoardUnclaimInput): Promise<BoardItem>;
    updateStatus(tenant: TenantId, input: BoardStatusUpdateInput): Promise<BoardItem>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/core/index.d.ts ====
/**
 * The Postgres composition of the seven `@byok-sdk/core` ports.
 *
 * All seven, or none: `runCoreConformance`'s port-inventory dimension asserts a
 * composition supplies exactly `CORE_STORE_NAMES` and exactly the methods
 * `CORE_PORT_METHODS` declares, so there is no such thing as a partial core
 * composition to certify. The original seven landed in one slice (design §11);
 * `skillPacks` joined in Phase 2 of `skill-pack-delivery-channel`
 * when it graduated from a bridge port to a mandatory `CoreStores` member. This
 * function returns a full `CoreStores` where the cloud-local sibling returns a
 * named subset.
 *
 * Everything that reads time reads the injected clock. Nothing calls SQL
 * `now()` — presence expiry and reservation expiry are both
 * contract behavior the suite asserts by moving a test clock, and a store that
 * asked the database for the time would make every one of those assertions
 * either a sleep or a flake.
 */
import type { Clock, CoreStores } from '@byok-sdk/core';
import type { Pool } from 'pg';
export { PostgresMailboxStore } from './mailbox';
export { PostgresBoardStore } from './board';
export { PostgresTruthStore } from './truth';
export { PostgresPresenceStore } from './presence';
export { PostgresObjectStore } from './objects';
export { PostgresQuotaStore } from './quota';
export { PostgresSkillPackStore } from './skill-pack';
export interface PostgresCoreStoreOptions {
    readonly pool: Pool;
    /**
     * The clock every TTL and timestamp in this composition reads. Injected, not
     * the database's `now()`: expiry has to be assertable under a test clock, and
     * a store that asks the server for the time cannot be.
     */
    readonly clock: Clock;
}
export declare function createPostgresCoreStores(options: PostgresCoreStoreOptions): CoreStores;
// ==== @byok-sdk/cloud-dataplane dist/stores/core/mailbox.d.ts ====
/**
 * Postgres {@link MailboxStore} (§12.7.3).
 *
 * The load-bearing rule, and the one a composition can break silently:
 * **reading is not acknowledging.** `readAfter` is a `SELECT` and nothing else.
 * The only ack is `advanceCursor`, which the daemon calls after it has durably
 * journaled the envelope. It is monotonic and bounded by `recordDelivery`:
 * regression and future cursors are refused with the cursor state they lost
 * to rather than re-delivering or silently skipping work.
 *
 * `collectRetired` deletes acked rows and **marks** unacked ones `expired`. It
 * never deletes an unacked row. §12.7.5 requires an envelope that aged out
 * before anyone consumed it to stay visible; deleting it would make "we dropped
 * work" indistinguishable from "there was no work", and dead-lettering those
 * rows is S4B's job (O-009), not this one's.
 *
 * Every row lives under `(tenant_id, device_id, seq)`, so a cross-tenant read
 * is not denied — it addresses a different key space and finds nothing. That is
 * the SQL expression of §12.6.2 layer 3: there is no bare device index to
 * accidentally query.
 */
import { type Clock, type MailboxAdvanceCursorInput, type MailboxAppendInput, type MailboxCursorState, type MailboxMessage, type MailboxPage, type MailboxReadQuery, type MailboxRecordDeliveryInput, type MailboxRetentionInput, type MailboxRetentionResult, type MailboxStore, type TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
export declare const OUTBOX_COLUMNS = "tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at";
export interface OutboxRow {
    readonly tenant_id: string;
    readonly device_id: string;
    readonly seq: bigint;
    readonly message_id: string;
    readonly body: string;
    readonly body_hash: string;
    readonly byte_size: bigint;
    readonly state: string;
    readonly appended_at: string;
}
export declare function toMailboxMessage(row: OutboxRow): MailboxMessage;
export declare class PostgresMailboxStore implements MailboxStore {
    #private;
    constructor(pool: Pool, clock: Clock);
    append(tenant: TenantId, input: MailboxAppendInput): Promise<MailboxMessage>;
    readAfter(tenant: TenantId, query: MailboxReadQuery): Promise<MailboxPage>;
    advanceCursor(tenant: TenantId, input: MailboxAdvanceCursorInput): Promise<MailboxCursorState>;
    recordDelivery(tenant: TenantId, input: MailboxRecordDeliveryInput): Promise<MailboxCursorState>;
    readCursor(tenant: TenantId, deviceId: string): Promise<MailboxCursorState>;
    collectRetired(tenant: TenantId, input: MailboxRetentionInput): Promise<MailboxRetentionResult>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/core/objects.d.ts ====
/**
 * Postgres {@link ObjectStore} — the manifest, and only the manifest
 * (§12.7.4, §12.7.8).
 *
 * Zero bytes cross this file. The manifest is the transaction authority and the
 * object store holds the payload; the R2 adapter that moves bytes is S4A-c.
 * What lives here is the state machine that stands between a failed object-store
 * delete and either a leaked object or a deleted one a truth record still points
 * at.
 *
 * Three properties the SQL is shaped around:
 *
 * - **`ref_count` is recomputed, never incremented.** Every reference mutation
 *   sets it to `count(*)` over `object_reference`. An increment drifts the
 *   moment a retried `addReference` lands twice, and a drifted count strands
 *   the object forever because `markDeletePending` refuses at `refCount != 0`.
 *   The reference table's primary key already makes the write idempotent; the
 *   count just reads it.
 * - **Reference mutations hold the manifest row under `FOR UPDATE`.** The
 *   recomputation above is only authoritative because of this lock, not on its
 *   own: under READ COMMITTED the `count(*)` subquery is evaluated on the
 *   snapshot its statement started with, so an unlocked `addReference` reads a
 *   `committed` state, and `markDeletePending`'s `ref_count = 0` guard can pass
 *   in the window before the reference row lands — leaving `delete_pending`
 *   with a live reference, which is a truth record pointing at bytes S4B's GC
 *   is entitled to delete. Taking the manifest row exclusively first makes the
 *   tombstone and the reference write queue against each other, exactly as
 *   `PostgresQuotaStore.reserve` serializes reservers on the entitlement row.
 * - **Every state move is a guarded `UPDATE`.** The legal transitions are the
 *   guard, so an illegal one writes nothing and the row is re-read to say which
 *   typed rejection applies. `commit` additionally guards on the DECLARED size
 *   and type, because the whole point of the check is that what the composition
 *   observed on the object store and what the client declared can differ
 *   (§12.7.7 step 4).
 */
import { type Clock, type ContentHash, type ObjectCommitInput, type ObjectListQuery, type ObjectManifestEntry, type ObjectManifestInput, type ObjectReferenceInput, type ObjectStore, type TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
export declare class PostgresObjectStore implements ObjectStore {
    #private;
    constructor(pool: Pool, clock: Clock);
    putManifest(tenant: TenantId, input: ObjectManifestInput): Promise<ObjectManifestEntry>;
    commit(tenant: TenantId, input: ObjectCommitInput): Promise<ObjectManifestEntry>;
    get(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry | undefined>;
    list(tenant: TenantId, query: ObjectListQuery): Promise<readonly ObjectManifestEntry[]>;
    addReference(tenant: TenantId, input: ObjectReferenceInput): Promise<ObjectManifestEntry>;
    removeReference(tenant: TenantId, input: ObjectReferenceInput): Promise<ObjectManifestEntry>;
    markDeletePending(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry>;
    markDeleted(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/core/presence.d.ts ====
/**
 * Postgres {@link PresenceStore} (§12.3).
 *
 * Presence is lossy, TTL-bounded, unsigned, and never authoritative. It is a
 * bounded upsert with one row per device. Nothing here may be
 * used to derive coordination state, execution state, authorization, billing or
 * recovery — which is why this file shares no vocabulary with `board.ts` and
 * none with the frozen wire states.
 *
 * **Expiry is absence, and it is expressed as a read filter.** A hint past its
 * `expiresAt` is invisible to every read, so no reader can observe a stale
 * level and mistake it for a live one. The in-memory reference deletes the
 * entry lazily on read; here the row stays and the predicate excludes it. Same
 * observable answer, and a `SELECT` that does not write to answer itself.
 *
 * Every instant is the injected clock's. Asserting TTL behavior against a wall
 * clock means sleeping or accepting flakes, which is why the port takes `ttlMs`
 * and the composition supplies the clock.
 */
import { type Clock, type PresenceHint, type PresenceHintInput, type PresenceStore, type TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
export declare class PostgresPresenceStore implements PresenceStore {
    #private;
    constructor(pool: Pool, clock: Clock);
    publish(tenant: TenantId, input: PresenceHintInput): Promise<PresenceHint>;
    read(tenant: TenantId, deviceId: string): Promise<PresenceHint | undefined>;
    list(tenant: TenantId): Promise<readonly PresenceHint[]>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/core/quota.d.ts ====
/**
 * Postgres {@link QuotaStore} — entitlement, usage, reservation (§12.7.6-12.7.7).
 *
 * The invariant this file exists to hold is
 * `committed + reserved + expected <= hardLimitBytes`, and the reason it is the
 * hardest statement in the slice is that the obvious shapes all get it wrong in
 * a way nothing throws about.
 *
 * **Why `reserve` opens a transaction.** Admission is one guarded
 * `INSERT ... SELECT ... WHERE`, exactly as every other CAS in this package is
 * one guarded statement. But the guard's operand is an AGGREGATE over the
 * tenant's live reservations, and under READ COMMITTED a statement's snapshot
 * is taken when the statement starts. Two concurrent reservers therefore both
 * read a pre-insert world and both pass — the classic oversell. Postgres'
 * EvalPlanQual re-check, which is what makes `UPDATE ... WHERE status = $x` a
 * genuine CAS elsewhere in this package, re-evaluates the qual only against the
 * updated TARGET row; a subquery over another table keeps the original
 * snapshot. So no single statement over this shape can serialize reservers.
 *
 * The two ways out are a counter column CAS'd in place, or a lock. The counter
 * loses: it has to be decremented on all three of finalize / abort / expire,
 * and a path that settles without decrementing leaves a tenant permanently
 * short of quota it actually released — durable drift, invisible until someone
 * audits. So `storage_usage` has NO `reserved_bytes` column and
 * `TenantStorageUsage.reservedBytes` is a `SUM` over live reservations, which
 * cannot drift, and admission takes `FOR UPDATE` on the tenant's entitlement
 * row first. The next statement in that transaction takes a FRESH snapshot,
 * acquired behind the lock, so it sees every committed reservation. This is the
 * "row-locked transaction" `packages/core/src/in-memory/quota.ts` names as the
 * Postgres shape.
 *
 * What is NOT happening here: a read whose result is compared in TypeScript and
 * then written. Every admission decision lives in the SQL guard. The reads on
 * the rejection path exist only to answer "which of the five typed rejections
 * is this", after the write has already been refused.
 *
 * Nothing in this file calls SQL `now()`. Every instant is the injected clock's,
 * so reservation expiry is assertable under a test clock — and
 * `__tests__/constraints.test.ts` scans this directory to keep it that way.
 */
import { type Clock, type MailboxUsageDeltaInput, type QuotaStore, type StorageFinalizeInput, type StorageFinalizeResult, type StorageReservation, type StorageReservationInput, type StorageStatus, type TenantId, type TenantStorageEntitlement, type TenantStorageEntitlementInput, type TenantStorageUsage } from '@byok-sdk/core';
import type { Pool } from 'pg';
export declare class PostgresQuotaStore implements QuotaStore {
    #private;
    constructor(pool: Pool, clock: Clock);
    readEntitlement(tenant: TenantId): Promise<TenantStorageEntitlement | undefined>;
    writeEntitlement(tenant: TenantId, input: TenantStorageEntitlementInput): Promise<TenantStorageEntitlement>;
    readUsage(tenant: TenantId): Promise<TenantStorageUsage>;
    readStatus(tenant: TenantId): Promise<StorageStatus>;
    readReservation(tenant: TenantId, reservationId: string): Promise<StorageReservation | undefined>;
    reserve(tenant: TenantId, input: StorageReservationInput): Promise<StorageReservation>;
    finalizeReservation(tenant: TenantId, input: StorageFinalizeInput): Promise<StorageFinalizeResult>;
    abortReservation(tenant: TenantId, reservationId: string): Promise<StorageReservation>;
    expireReservations(tenant: TenantId): Promise<readonly StorageReservation[]>;
    applyMailboxDelta(tenant: TenantId, input: MailboxUsageDeltaInput): Promise<TenantStorageUsage>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/core/skill-pack.d.ts ====
/**
 * Postgres {@link SkillPackStore} (plan `skill-pack-delivery-channel`, Phase 2).
 *
 * A faithful projection of {@link InMemorySkillPackStore}: same validators, same
 * refusals, same read shape. What `publish` checks and what it rejects is core's
 * decision, not this store's — it reuses `checkSkillPackManifest` /
 * `checkSkillPackEntry` and the manifest/file cross-checks the reference
 * performs, because this store cannot hash (integrity is the installing device's
 * job) but it CAN refuse to persist a pack whose declared path set or byte sizes
 * already disagree with the bytes it was handed. Storing that pair unchecked
 * would hand a device a corrupt publication it could not tell from a tampered
 * response.
 *
 * Two tables, one per level of the manifest (`deploy/sql/0005_skill_packs.sql`):
 * `skill_pack` carries the pack-level fields a `SkillPackManifest` needs to be
 * reconstructed (version, description, the pack content hash), and
 * `skill_pack_file` carries one row per declared file with its content hash,
 * byte size, and the UTF-8 text itself. A publish is a single transaction that
 * upserts the pack row and REPLACES its file set, so a re-publish of a changed
 * pack under the same name never leaves a stale file behind.
 *
 * `byte_size` is `integer`, not `bigint`: `SkillPackFile.byteSize` is a core
 * `number` bounded by `SKILL_PACK_FILE_MAX_BYTES` (256 KiB), unlike the quota
 * and truth byte fields the contract declares as `bigint`. `integer` is the
 * type that round-trips a `number` without a cast at the boundary — the same
 * call `object_manifest.ref_count` makes for a small count.
 *
 * No injected clock: a manifest carries no timestamp, so this store writes none
 * and asks the database for none. That mirrors the reference, which takes no
 * clock either.
 */
import { type SkillPackFileContent, type SkillPackListQuery, type SkillPackManifest, type SkillPackPublishInput, type SkillPackStore, type TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
export declare class PostgresSkillPackStore implements SkillPackStore {
    #private;
    constructor(pool: Pool);
    publish(tenant: TenantId, input: SkillPackPublishInput): Promise<SkillPackManifest>;
    get(tenant: TenantId, name: string): Promise<SkillPackManifest | undefined>;
    list(tenant: TenantId, query: SkillPackListQuery): Promise<readonly SkillPackManifest[]>;
    readFile(tenant: TenantId, name: string, path: string): Promise<SkillPackFileContent | undefined>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/core/truth.d.ts ====
/**
 * Postgres {@link TruthStore} (§12.3, §12.6.4).
 *
 * Two write models over one table, and the primary key does the deciding for
 * both.
 *
 * - `task.terminal` is first-write-wins: `INSERT ... ON CONFLICT DO NOTHING`
 *   plus an equality re-read. A replay of the identical hash returns the
 *   ORIGINAL row — same `rev`, same `writtenAt`, same `requestId` — and a
 *   different hash for the same task is refused with the record already
 *   committed attached. An upsert would pass a naive "write it twice" check
 *   while quietly restamping the first fact, which §12.6.4 forbids outright.
 * - `profile` / `memory` are per-key snapshots under an `expectedRev` CAS:
 *   `UPDATE ... WHERE rev = $expectedRev`, with `expectedRev = 0` expressed as
 *   the insert. Zero rows is the conflict, and the caller gets the current
 *   record — or `undefined` when it claimed a revision of a record that does
 *   not exist.
 *
 * The store never merges bodies. A conflict hands back what it lost to and
 * stops, because the device holding the context is the only party that can
 * decide what the merged truth should be (§12.3).
 */
import { type Clock, type SnapshotWriteInput, type TenantId, type TerminalWriteInput, type TruthManifestEntry, type TruthManifestQuery, type TruthRecord, type TruthRecordSelector, type TruthStore } from '@byok-sdk/core';
import type { Pool } from 'pg';
export declare class PostgresTruthStore implements TruthStore {
    #private;
    constructor(pool: Pool, clock: Clock);
    writeTerminal(tenant: TenantId, input: TerminalWriteInput): Promise<TruthRecord>;
    writeSnapshot(tenant: TenantId, input: SnapshotWriteInput): Promise<TruthRecord>;
    getRecord(tenant: TenantId, selector: TruthRecordSelector): Promise<TruthRecord | undefined>;
    listManifest(tenant: TenantId, query: TruthManifestQuery): Promise<readonly TruthManifestEntry[]>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/dedup.d.ts ====
/**
 * Postgres {@link InboundDedupStore} (N3): bounded at-most-once processing.
 *
 * Check-and-record is one `INSERT ... ON CONFLICT DO NOTHING`, so a
 * composition cannot accidentally split it into a racy read-then-write: the
 * primary key does the deciding, and zero returned rows means "already seen".
 *
 * Reclaim runs only on the path that actually grew the table, and it deletes
 * oldest-first down to `DEDUP_RING_CAPACITY` rows for that device — the same
 * bound the in-memory ring holds. The ids most likely to be redelivered are the
 * recent ones, so dropping the oldest is the retention that matches the wire's
 * behavior. An unbounded set would pass every duplicate assertion and still let
 * one chatty device grow this table without limit.
 */
import { type InboundDedupStore } from '@byok-sdk/cloud';
import type { TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
export declare class PostgresInboundDedupStore implements InboundDedupStore {
    #private;
    constructor(pool: Pool, capacity?: number);
    checkAndRecord(tenant: TenantId, deviceId: string, envelopeId: string): Promise<boolean>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/device-assertion-replay.d.ts ====
import type { DeviceAssertionReplayAuthority, DeviceAssertionReplayConsumeInput } from '@byok-sdk/core';
import type { Pool } from 'pg';
/** Durable atomic replay authority for hosted device-assertion exchange. */
export declare class PostgresDeviceAssertionReplayAuthority implements DeviceAssertionReplayAuthority {
    #private;
    constructor(pool: Pool);
    consume(input: DeviceAssertionReplayConsumeInput): Promise<boolean>;
    /** Bounded retention cleanup; callers choose cadence and batch size. */
    deleteExpired(before: Date, limit: number): Promise<number>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/devices.d.ts ====
/**
 * Postgres {@link DeviceDirectory}.
 *
 * Rows live under the composite key `(tenant_id, device_id)`, so a cross-tenant
 * read is not "denied" — it addresses a different key space and finds nothing
 * (§12.6.2 layer 3). `resolveByDeviceId` is the documented pre-tenant entry
 * point, and it is safe for exactly one reason: the row it returns CARRIES its
 * tenant, so the caller never compares a tenant it was handed against one it
 * guessed. One row, two access paths, never two copies to keep in sync — a
 * stale pre-tenant index would be a revoked device that can still get a token.
 *
 * Revocation DELETES. The `revoked` column and {@link DeviceRecord.revoked}
 * survive because every auth path reads them, but nothing in this module ever
 * writes `true` any more: `revoke` and machine supersession remove the row and
 * its device-scoped state, so a revoked device is byte-for-byte a device that
 * was never registered. `device_active_machine_key` (0015) is still the
 * invariant — its `NOT revoked` predicate simply never has a false row left to
 * exclude.
 */
import { type Clock, type PresenceStore, type TenantId, type TenantReadiness } from '@byok-sdk/core';
import type { DeviceDirectory, DeviceRecord, DeviceRegistration } from '@byok-sdk/cloud';
import type { Pool, PoolClient } from 'pg';
/**
 * The client-scoped registration mutation shared by standalone device
 * registration and pairing enrollment. Its caller owns the transaction so the
 * guarded pairing-code update, machine supersession cleanup, and insert can
 * commit or roll back together.
 */
export declare function registerDeviceOnClient(client: PoolClient, tenant: TenantId, input: DeviceRegistration): Promise<DeviceRecord>;
/** Read one active device while a caller-owned transaction still holds its authority lock. */
export declare function getDeviceOnClient(client: PoolClient, tenant: TenantId, deviceId: string): Promise<DeviceRecord | undefined>;
export declare class PostgresDeviceDirectory implements DeviceDirectory {
    #private;
    constructor(pool: Pool, clock?: Clock);
    register(tenant: TenantId, input: DeviceRegistration): Promise<DeviceRecord>;
    get(tenant: TenantId, deviceId: string): Promise<DeviceRecord | undefined>;
    /**
     * Revocation removes the registration and the device-scoped state that only
     * existed to serve it, in one transaction: a half-applied revoke that left
     * live presence or an unspent challenge nonce behind would be state for a
     * device the directory can no longer name.
     *
     * A no-op for a device this tenant does not own: revoking what you cannot
     * address deletes nothing and reports nothing back.
     */
    revoke(tenant: TenantId, deviceId: string): Promise<void>;
    recordCapabilities(tenant: TenantId, input: {
        readonly deviceId: string;
        readonly capabilities: readonly string[];
    }): Promise<DeviceRecord | undefined>;
    list(tenant: TenantId): Promise<readonly DeviceRecord[]>;
    readiness(tenant: TenantId, _presence: PresenceStore): Promise<TenantReadiness>;
    resolveByDeviceId(deviceId: string): Promise<DeviceRecord | undefined>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/index.d.ts ====
/**
 * The Postgres composition of the cloud-local ports.
 *
 * Nine durable stores, one object-storage blob store, one in-memory limiter:
 *
 * - Six durable ones have rows in `deploy/sql/0001_cloud_local.sql`; S6's
 *   proof receipt authority is the seventh, in `0004_device_proof_truth.sql`;
 *   typed activity uses the JSONB tail row in `0002_core_domain.sql`; approval
 *   lifecycle observations use `0007_approval_timeline.sql`.
 * - `blobs` is the R2 adapter over the `object_manifest` row the core store
 *   already owns: metadata in Postgres, bytes in the object store, one
 *   reserve/verify protocol binding them (design §6). It supplies grants only,
 *   and this composition deliberately hands `createByokCloud` NO
 *   `BlobContentProxy` — a device uploading straight to R2 is what having no
 *   byte-proxy path means, and saying so by absence is what keeps the two
 *   `/content` routes from mounting on a deployment that cannot serve them.
 * - `rateLimiter` gets the allow-all reference and NO table, by design
 *   (docs/researches/s4a-dataplane-design.md §5). Persisting an allow-all would
 *   create a table that is always empty, and a real limiter is edge/infra work
 *   whose implementation would not be a per-request Postgres write either.
 */
import { type CloudStores } from '@byok-sdk/cloud';
import type { CloudCrypto } from '@byok-sdk/cloud';
import type { Clock } from '@byok-sdk/core';
import type { Pool } from 'pg';
import { type R2BlobStoreOptions } from './r2-blobs';
export { PostgresDeviceDirectory } from './devices';
export { PostgresInboundDedupStore } from './dedup';
export { PostgresNonceStore } from './nonces';
export { PostgresPairingCodeStore } from './pairing-codes';
export { PostgresRequestReceiptStore } from './receipts';
export { PostgresProofRequestReceiptStore } from './proof-receipts';
export { PostgresTaskAttemptStore } from './task-attempts';
export { PostgresTaskCancellationStore } from './task-cancellations';
export { PostgresActivityStore } from './activity';
export { PostgresApprovalTimelineStore } from './approval-timeline';
export { PostgresAgentEgressStore } from './agent-egress';
export { PostgresAgentMemoryProjectionStore, createPostgresAgentMemoryProjectionStore, } from './agent-memory-projection';
export type { PostgresAgentMemoryProjectionStoreOptions } from './agent-memory-projection';
export { PostgresDeviceAssertionReplayAuthority } from './device-assertion-replay';
export { DEFAULT_MAX_ATTEMPTS, DEFAULT_PRESIGN_TTL_SECONDS, DEFAULT_RETRY_DELAY_MS, MAX_PRESIGN_TTL_SECONDS, MIN_PRESIGN_TTL_SECONDS, ObjectStoreRequestError, R2_BLOB_ERROR_CODES, R2BlobStoreError, R2CloudBlobStore, R2ObjectMaintenanceStore, } from './r2-blobs';
export type { ObjectStoreFetch, R2BlobErrorCode, R2BlobStoreOptions } from './r2-blobs';
export type { R2DeleteResult, R2ListedObject, R2ObjectMaintenance, R2ObjectMaintenanceOptions, R2ObjectPage, } from './r2-blobs';
/** Every cloud-local port. All twelve, or it is not a composition. */
export type PostgresCloudStores = CloudStores;
/** Everything the blob store needs that is not already a composition-wide input. */
export type PostgresObjectStorageOptions = Omit<R2BlobStoreOptions, 'objects'>;
export interface PostgresCloudStoreOptions {
    readonly pool: Pool;
    /**
     * The clock every TTL and timestamp in this composition reads. Injected, not
     * the database's own: expiry has to be assertable under a test clock, and a
     * store that asks the server for the time cannot be.
     */
    readonly clock: Clock;
    readonly crypto: CloudCrypto;
    /**
     * Where the bytes go. Required, because a composition that cannot say where
     * its objects live cannot honestly claim the `blobs` port — and the
     * conformance suite certifies compositions whole, never in parts.
     */
    readonly objectStorage: PostgresObjectStorageOptions;
}
export declare function createPostgresCloudStores(options: PostgresCloudStoreOptions): PostgresCloudStores;
// ==== @byok-sdk/cloud-dataplane dist/stores/nonces.d.ts ====
/**
 * Postgres {@link NonceStore}: single-use challenge nonces bound to the
 * (tenant, device) they were issued for, expiring after `NONCE_TTL_MS`
 * (docs/protocol.md §6.2).
 *
 * Expiry is compared against the INJECTED clock, never the database's `now()`.
 * A store that asked the server for the time would be unassertable under a test
 * clock, and the conformance suite's TTL dimension would have to sleep — which
 * is how a replay-window regression ships unnoticed.
 *
 * `issue` sweeps this device's spent and expired rows inline, same posture as
 * the in-memory reference and the reference server: a long-lived deployment
 * never calls a sweep on a timer, and the sweep is bounded to one (tenant,
 * device) so it stays proportional to the caller that triggered it.
 */
import { type NonceStore } from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { CloudCrypto } from '@byok-sdk/cloud';
import type { Pool } from 'pg';
export declare class PostgresNonceStore implements NonceStore {
    #private;
    constructor(pool: Pool, clock: Clock, crypto: CloudCrypto, ttlMs?: number);
    issue(tenant: TenantId, deviceId: string): Promise<string>;
    consumeIfValid(tenant: TenantId, deviceId: string, nonce: string): Promise<boolean>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/pairing-codes.d.ts ====
/**
 * Postgres {@link PairingCodeStore}: single-use codes bound to the tenant and
 * product they were minted for.
 *
 * Enrollment is one transaction. `UPDATE ... WHERE redeemed_at IS NULL AND
 * expires_at >= $now RETURNING ...` claims the code only inside the same client
 * transaction that applies machine supersession/state cleanup and inserts the
 * device. A read-then-write would let two callers observe an unused code; an
 * autocommitted redemption would strand a code when registration fails.
 *
 * Unknown, expired, and already-used all answer `undefined`. The reference
 * server distinguishes them in its 401 text; a hosted multi-tenant surface
 * deliberately does not — the code is a bearer credential addressable across
 * every tenant, and "already used" versus "never existed" is precisely the
 * difference an attacker enumerating codes would pay for.
 */
import type { Clock, TenantId } from '@byok-sdk/core';
import type { DeviceRecord, PairingCodeInfo, PairingCodeIssueInput, PairingCodeStore } from '@byok-sdk/cloud';
import type { Pool } from 'pg';
export declare class PostgresPairingCodeStore implements PairingCodeStore {
    #private;
    constructor(pool: Pool, clock: Clock);
    issue(tenant: TenantId, input: PairingCodeIssueInput): Promise<PairingCodeInfo>;
    redeemAndRegister(input: {
        readonly pairingCode: string;
        readonly deviceId: string;
        readonly deviceName: string;
        readonly devicePublicKey: string;
        readonly proofKeyId: string;
        readonly proofKeyEpoch: number;
        readonly machineId?: string;
    }): Promise<DeviceRecord | undefined>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/proof-receipts.d.ts ====
import type { ProofRequestReceipt, ProofRequestReceiptInput, ProofRequestReceiptStore } from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
export declare class PostgresProofRequestReceiptStore implements ProofRequestReceiptStore {
    #private;
    constructor(pool: Pool, clock: Clock);
    record(tenant: TenantId, input: ProofRequestReceiptInput): Promise<{
        readonly receipt: ProofRequestReceipt;
        readonly created: boolean;
    }>;
    get(tenant: TenantId, deviceId: string, requestId: string): Promise<ProofRequestReceipt | undefined>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/r2-blobs.d.ts ====
/**
 * The R2/S3 {@link CloudBlobStore} — grants, and only grants (§12.7.4, §12.7.7).
 *
 * Zero bytes cross this file either, but for the opposite reason to
 * `stores/core/objects.ts`: the manifest store holds metadata because bytes are
 * not its job, and this store holds no bytes because the DEVICE talks to the
 * object store directly. What it mints is a presigned URL; what the device does
 * with it is between the device and R2. That is why this composition supplies
 * no `BlobContentProxy` — there is no byte path here to proxy, and the absence
 * is the honest declaration (`@byok-sdk/cloud`'s `ports.ts`, design §6).
 *
 * Manifest and bytes are one transaction authority split across two systems
 * with no shared transaction, so the protocol is reserve/verify rather than
 * write/trust:
 *
 * 1. `createUpload` writes the `pending` manifest row FIRST, then signs a PUT.
 *    Row-before-bytes is what makes an abandoned upload a reclaimable
 *    tombstone instead of an object nobody has a record of.
 * 2. The device PUTs straight to the object store. `Content-Length` and
 *    `Content-Type` are in the signed headers, so a body of the wrong size or
 *    the wrong type is refused by the object store itself — before a byte is
 *    stored, and without this process being in the path.
 * 3. The explicit finalize route calls `observeUpload`, which performs an
 *    unconditional `HEAD`. Unconditional because §12.7.7 step 4 is about what
 *    the store OBSERVES versus what the client DECLARED, and signing the length
 *    proves what one client sent, not what is at the key now. The quota
 *    authority then commits manifest/reservation/usage in one Postgres
 *    statement; download never performs that transition.
 * 4. `committed` is terminal for writes. Step 1 is re-runnable while a row is
 *    `pending` — that is what makes a retried upload idempotent — and refused
 *    once it is `committed`, because §12.7.4 lets truth reference a committed
 *    manifest and the reference means nothing if the bytes can still be
 *    replaced by a same-shaped body under a freshly signed PUT.
 *
 * **No checksum header.** `x-amz-checksum-sha256` was probed rather than
 * assumed (design §3 marked it `[unverified]`): MinIO honors it in a presigned
 * PUT and rejects mismatched bytes with `XAmzContentChecksumMismatch`, but R2's
 * S3 compatibility table lists SHA-256 as `COMPOSITE` only — `FULL_OBJECT`, the
 * type a single-shot PutObject uses, is ❌, and R2's PutObject feature row names
 * no `x-amz-checksum-*` header at all. Signing one would mint URLs that work
 * against the test substrate and fail against production, which is worse than
 * not signing it. The `HEAD` above was never conditional on it.
 *
 * The `blobId` this store mints IS the content hash. That is what makes "no
 * naked object index" constructive rather than disciplinary: there is no
 * surrogate id to look up, every read is `(tenant, hash)` against the manifest
 * primary key, and the object key is derived — once, in {@link #objectUrl} —
 * from a `ContentHash` that core already validated. A non-hex id cannot reach
 * key construction because it cannot become a `ContentHash`.
 */
import { type Clock, type ContentHash, type ObjectStore, type StorageReservation, type TenantId } from '@byok-sdk/core';
import type { BlobObservation, CloudBlobStore } from '@byok-sdk/cloud';
/** 15 minutes, matching the in-memory reference's `BLOB_URL_TTL_MS`. */
export declare const DEFAULT_PRESIGN_TTL_SECONDS: number;
/** `X-Amz-Expires` floor. Below a second there is no grant, only a signature. */
export declare const MIN_PRESIGN_TTL_SECONDS = 1;
/** `X-Amz-Expires` ceiling: seven days, the longest lifetime R2 will honor. */
export declare const MAX_PRESIGN_TTL_SECONDS = 604800;
/** Three total attempts: the first plus two retries. */
export declare const DEFAULT_MAX_ATTEMPTS = 3;
/** Doubles per retry. Deterministic — no jitter, so a test can assert the sequence. */
export declare const DEFAULT_RETRY_DELAY_MS = 100;
/** The subset of `fetch` this store uses. The seam a fault injector replaces. */
export type ObjectStoreFetch = (request: Request) => Promise<Response>;
/**
 * Raised when the object store answered something this adapter cannot act on —
 * a 4xx that is not "absent", or a transient failure that outlived its retries.
 *
 * A local class rather than a core code: core's taxonomy describes the manifest
 * contract, and "R2 returned 503 three times" is an adapter fault, not a
 * statement about the object.
 */
export declare class ObjectStoreRequestError extends Error {
    readonly status: number | undefined;
    readonly attempts: number;
    constructor(message: string, attempts: number, status?: number, options?: ErrorOptions);
}
/**
 * What this adapter refuses on its own account, before anything is signed.
 *
 * A second local class rather than more core codes, for the same reason
 * {@link ObjectStoreRequestError} is one: core's taxonomy describes the
 * manifest contract, and "this deployment's tenant ids cannot be key segments"
 * or "this deployment configured a lifetime R2 will not honor" are facts about
 * an S3 adapter's configuration and inputs, not about an object. Core's code
 * union is closed and deliberately so; widening it from an adapter would put
 * an adapter's vocabulary on a wire contract every composition shares.
 *
 * Code-based branching, matching the idiom of every other error type here.
 */
export declare const R2_BLOB_ERROR_CODES: {
    /**
     * A tenant id that cannot be one safe path segment. Wire-relevant: it is the
     * only signal a control plane gets that the id it issued cannot address
     * object storage, and it is raised BEFORE any key is built.
     */
    readonly storage_tenant_key_unsafe: 'storage_tenant_key_unsafe';
    /** A presign lifetime outside `[MIN_PRESIGN_TTL_SECONDS, MAX_PRESIGN_TTL_SECONDS]`. Construction-time only. */
    readonly storage_presign_ttl_invalid: 'storage_presign_ttl_invalid';
    /** ListObjectsV2 accepts 1..1000 keys per page. Maintenance input only. */
    readonly storage_list_limit_invalid: 'storage_list_limit_invalid';
    /** Continuation tokens are opaque but non-empty. Maintenance input only. */
    readonly storage_list_cursor_invalid: 'storage_list_cursor_invalid';
};
export type R2BlobErrorCode = (typeof R2_BLOB_ERROR_CODES)[keyof typeof R2_BLOB_ERROR_CODES];
export declare class R2BlobStoreError extends Error {
    readonly code: R2BlobErrorCode;
    constructor(code: R2BlobErrorCode, message: string, options?: ErrorOptions);
}
export interface R2BlobStoreOptions {
    /**
     * The manifest authority. Same `ObjectStore` the core composition supplies —
     * one row per (tenant, hash), and this store never opens a second one.
     */
    readonly objects: ObjectStore;
    /**
     * The clock SigV4's `X-Amz-Date` is read from — WALL time, and deliberately
     * NOT the composition's logical clock.
     *
     * Every other instant in this program comes from an injected clock so TTLs
     * are assertable without sleeping, and a store reaching for wall time is a
     * bug. A request signature is the exception, and not a soft one: its validity
     * window is adjudicated by the object store against the object store's own
     * clock. Signing with a logical instant produces a credential the remote side
     * rejects as skewed the moment the two disagree — a 403 at upload time, from
     * a decision made at composition time.
     *
     * Separate and required rather than defaulted, so the distinction is a choice
     * someone makes rather than one they inherit. A test that needs an EXPIRED
     * grant backdates this clock, which is also the only way to assert expiry
     * without sleeping through it.
     */
    readonly signingClock: Clock;
    /** Origin only, e.g. `https://<account>.r2.cloudflarestorage.com`. */
    readonly endpoint: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    /**
     * `auto` for R2. Required rather than defaulted: a signature scoped to the
     * wrong region fails as a 403 at upload time, which is a terrible place to
     * discover a config default nobody chose.
     */
    readonly region: string;
    /**
     * A key namespace for this deployment, e.g. `acme/prod` →
     * `acme/prod/tenants/<tenant>/objects/sha256/<hex>`. Omit it and the key is
     * the unprefixed `tenants/...` layout, byte for byte.
     *
     * What it is for: one bucket, several deployments. Without it every
     * deployment owns the bucket root, so a host running two products against
     * one R2 account has to open a bucket per product.
     *
     * **Immutable per deployment, and only for a NEW one.** This value is
     * spliced into the key at write time and at read time from the same field;
     * there is no second layout anything falls back to, by design. Change it on
     * a deployment that has already stored objects and those objects are
     * stranded — still in the bucket, no longer addressable, and invisible to
     * this SDK's own maintenance surface. A dual-read across the old and new
     * prefix is NOT a supported way to switch and will not be added: it would
     * make two key layouts simultaneously authoritative for the same object.
     * Moving an existing deployment onto a prefix is a separate, one-shot,
     * operator-invoked copy of the objects themselves, out of this SDK's scope.
     *
     * Validated at construction ({@link ObjectKeyPrefix}): slash-joined segments
     * of lowercase alphanumerics, `.`, `_`, `-`, each starting with an
     * alphanumeric, no leading/trailing slash, no empty segment. `''` is a
     * refusal, not a synonym for "no prefix" — it is what an unset environment
     * variable looks like, and silently treating it as the default would put a
     * deployment's objects somewhere nobody chose.
     */
    readonly keyPrefix?: string;
    readonly presignTtlSeconds?: number;
    /** Injected so a fault injector can sit in front of the real one. */
    readonly fetch?: ObjectStoreFetch;
    readonly maxAttempts?: number;
    readonly retryDelayMs?: number;
}
/** One tenant-prefixed R2 key returned by ListObjectsV2. */
export interface R2ListedObject {
    readonly key: string;
    /** Present only when the key is exactly `tenants/<tenant>/objects/sha256/<64 lowercase hex>`. */
    readonly hash?: ContentHash;
    readonly byteSize: bigint;
}
export interface R2ObjectPage {
    readonly objects: readonly R2ListedObject[];
    readonly nextContinuationToken?: string;
}
export type R2DeleteResult = 'deleted' | 'absent';
/** Operations used only by the host-owned S4B-c maintenance worker. */
export interface R2ObjectMaintenance {
    inspectObject(tenant: TenantId, hash: ContentHash): Promise<BlobObservation | undefined>;
    deleteObject(tenant: TenantId, hash: ContentHash): Promise<R2DeleteResult>;
    listTenantObjects(tenant: TenantId, continuationToken?: string, limit?: number): Promise<R2ObjectPage>;
}
export declare class R2CloudBlobStore implements CloudBlobStore {
    #private;
    constructor(options: R2BlobStoreOptions);
    /**
     * Reserve the manifest row, then hand back a PUT bound to this tenant, this
     * key, this length, this type, and this expiry.
     *
     * `putManifest` is idempotent per (tenant, hash), so a device that declares
     * the same content twice while it is still `pending` gets the same row and
     * the same key — an interrupted upload is retried, not duplicated. It is
     * idempotent per TENANT, which is the same reason the key embeds the tenant:
     * two tenants holding identical bytes hold two independent objects, and
     * neither can learn of the other's.
     *
     * Idempotence stops at `committed`, and that boundary is the point: a
     * committed object is what a truth record is allowed to reference, so it has
     * to be immutable, and re-issuing a write grant for one is the only way this
     * adapter could make it otherwise.
     */
    createUpload(tenant: TenantId, reservation: StorageReservation): Promise<{
        readonly blobId: string;
        readonly uploadUrl: string;
    }>;
    observeUpload(tenant: TenantId, blobId: string, reservation: StorageReservation): Promise<BlobObservation | undefined>;
    /**
     * A GET for a committed object this tenant owns; `undefined` otherwise.
     *
     * Every miss answers identically — unknown hash, another tenant's object, a
     * malformed id, bytes that never landed, a tombstoned row. A caller cannot
     * tell them apart, which is what keeps `getDownloadUrl` from being an
     * existence oracle across tenants.
     *
     * This is a pure committed-manifest gate. Observation and commit belong to
     * the explicit finalize route; a download must never decide accounting.
     */
    getDownloadUrl(tenant: TenantId, blobId: string): Promise<string | undefined>;
}
export type R2ObjectMaintenanceOptions = Omit<R2BlobStoreOptions, 'objects' | 'presignTtlSeconds'>;
/**
 * R2 maintenance adapter kept deliberately outside `CloudBlobStore`.
 *
 * Cloud conformance certifies the device-facing blob port with an exact method
 * inventory. LIST/HEAD/DELETE are host operations, so putting them on
 * `R2CloudBlobStore` would over-declare a capability no other cloud composition
 * implements.
 */
export declare class R2ObjectMaintenanceStore implements R2ObjectMaintenance {
    #private;
    constructor(options: R2ObjectMaintenanceOptions);
    inspectObject(tenant: TenantId, hash: ContentHash): Promise<BlobObservation | undefined>;
    deleteObject(tenant: TenantId, hash: ContentHash): Promise<R2DeleteResult>;
    listTenantObjects(tenant: TenantId, continuationToken?: string, limit?: number): Promise<R2ObjectPage>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/receipts.d.ts ====
/**
 * Postgres {@link RequestReceiptStore}: the first write is the fact.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` and nothing else. The terminal a device
 * reports is a fact, and the retry the at-least-once wire guarantees must not
 * overwrite it (§12.6.4: 不覆写第一份事实). `created: false` is how the caller
 * learns it was a replay, which is why an upsert that UPDATED would be wrong in
 * a way no naive "record it twice" test would catch — it would pass, while
 * silently rewriting history and restamping `recorded_at`.
 */
import type { RequestReceipt, RequestReceiptStore } from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
export declare class PostgresRequestReceiptStore implements RequestReceiptStore {
    #private;
    constructor(pool: Pool, clock: Clock);
    record(tenant: TenantId, input: {
        readonly key: string;
        readonly body: string;
    }): Promise<{
        readonly receipt: RequestReceipt;
        readonly created: boolean;
    }>;
    get(tenant: TenantId, key: string): Promise<RequestReceipt | undefined>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/task-attempts.d.ts ====
/**
 * Postgres {@link TaskAttemptStore} — the ownership authority the inbound gate
 * reads (N2).
 *
 * `claim` is a single guarded statement: `UPDATE ... WHERE owner_device_id IS
 * NULL RETURNING ...`. Two devices racing the same offer therefore produce one
 * owner, not a last writer. When the guard rejects, the row is re-read and
 * returned as-is, which makes a losing claim (and the winner's own re-claim)
 * idempotent rather than an error — the caller learns who owns the task either
 * way. Ownership never transfers: reassigning an owner is the one operation
 * that would make the gate's cross-device assertion unfalsifiable.
 *
 * Two deliberate no-ops, both about not letting a guessed id leave a trace:
 * `claim` and `recordStatus` on a task this tenant never offered write nothing
 * and return `undefined`.
 */
import { type AgentMessageAdmission, type AgentRef, type TaskAttempt, type TaskAttemptStatus, type TaskAttemptStore } from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
export interface TaskRow {
    readonly tenant_id: string;
    readonly task_id: string;
    readonly device_id: string;
    readonly agent_id: string | null;
    readonly agent_profile_revision: string | null;
    readonly owner_device_id: string | null;
    readonly status: string;
    readonly terminal_cause: string | null;
    readonly cancel_requested_at: Date | null;
    readonly cancel_reason: string | null;
    readonly cancel_message_id: string | null;
    readonly updated_at: Date;
}
export declare const TASK_SELECT_COLUMNS = "tenant_id, task_id, device_id, agent_id, agent_profile_revision, owner_device_id, status, terminal_cause, cancel_requested_at, cancel_reason, cancel_message_id, updated_at";
export declare function taskRowToAttempt(row: TaskRow): TaskAttempt;
export declare class PostgresTaskAttemptStore implements TaskAttemptStore {
    #private;
    constructor(pool: Pool, clock: Clock);
    open(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly agentRef?: AgentRef;
    }): Promise<TaskAttempt>;
    reserveAgentOffer(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly agentRef: AgentRef;
    }): Promise<{
        readonly attempt: TaskAttempt;
        readonly created: boolean;
    }>;
    reserveAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
    }): Promise<'reserved' | 'pending' | 'rejected'>;
    readAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
    }): Promise<AgentMessageAdmission | undefined>;
    finalizeAgentMessage(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
        readonly messageId: string;
        readonly payloadBody: string;
        readonly terminalBody: string;
    }): Promise<AgentMessageAdmission | undefined>;
    get(tenant: TenantId, taskId: string): Promise<TaskAttempt | undefined>;
    getMany(tenant: TenantId, taskIds: readonly string[]): Promise<readonly TaskAttempt[]>;
    claim(tenant: TenantId, input: {
        readonly taskId: string;
        readonly deviceId: string;
    }): Promise<TaskAttempt | undefined>;
    recordStatus(tenant: TenantId, input: {
        readonly taskId: string;
        readonly status: TaskAttemptStatus;
        readonly agentRef?: AgentRef;
        readonly terminalCause?: string;
    }): Promise<TaskAttempt | undefined>;
}
// ==== @byok-sdk/cloud-dataplane dist/stores/task-cancellations.d.ts ====
import type { TaskCancellationMutation, TaskCancellationRequest, TaskCancellationStore } from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
/** PostgreSQL atomic authority for host cancellation state plus mailbox delivery. */
export declare class PostgresTaskCancellationStore implements TaskCancellationStore {
    #private;
    constructor(pool: Pool, clock: Clock);
    request(tenant: TenantId, input: TaskCancellationRequest): Promise<TaskCancellationMutation | undefined>;
}
// ==== @byok-sdk/cloud-dataplane dist/tenant-erasure.d.ts ====
import { type Clock, type TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
import { type R2BlobStoreOptions, type R2ObjectMaintenance } from './stores/r2-blobs';
/** Every tenant-owned table as of 0017, in child-before-parent deletion order. */
export declare const TENANT_ERASURE_TABLES: readonly ['object_reference', 'object_manifest', 'storage_reservation', 'storage_usage', 'storage_entitlement', 'gc_cursor', 'cleanup_job', 'tenant_retention_policy', 'skill_pack_file', 'skill_pack', 'approval_timeline_tail', 'activity_tail', 'attested_record', 'board_item', 'tenant_stream', 'outbox', 'agent_memory_projection_metering_receipt', 'agent_memory_projection_head', 'agent_memory_projection_erase_fence', 'agent_egress_event', 'device_request_receipts', 'proof_request_receipt', 'agent_message_admission', 'task', 'device_presence', 'device_assertion_replay', 'device_stream', 'inbound_dedup', 'auth_nonce', 'pairing_code', 'device'];
export declare const TENANT_ERASURE_ERROR_CODES: {
    readonly tenant_erasure_invalid_input: 'tenant_erasure_invalid_input';
    readonly tenant_erasure_schema_drift: 'tenant_erasure_schema_drift';
    readonly tenant_erasure_object_key_invalid: 'tenant_erasure_object_key_invalid';
    readonly tenant_erasure_storage_failure: 'tenant_erasure_storage_failure';
    readonly tenant_erasure_database_failure: 'tenant_erasure_database_failure';
    readonly tenant_erasure_cas_lost: 'tenant_erasure_cas_lost';
};
export type TenantErasureErrorCode = (typeof TENANT_ERASURE_ERROR_CODES)[keyof typeof TENANT_ERASURE_ERROR_CODES];
export declare class TenantErasureError extends Error {
    readonly code: TenantErasureErrorCode;
    constructor(code: TenantErasureErrorCode, message: string, options?: ErrorOptions);
}
export type TenantErasureStatus = 'outstanding' | 'partial' | 'completed';
export interface TenantErasureReadback {
    readonly status: TenantErasureStatus;
    readonly tenantId: TenantId;
    readonly operationId: string;
    readonly startedAt: string;
    readonly updatedAt: string;
    readonly completedAt?: string;
    readonly r2Complete: boolean;
    readonly sqlTableIndex: number;
    readonly r2ObjectsDeleted: bigint;
    readonly sqlRowsDeleted: bigint;
    /** A closed, audit-safe class. Remote messages and object names are never retained. */
    readonly errorCode?: TenantErasureErrorCode;
}
export interface TenantErasureConflict {
    readonly status: 'conflict';
    readonly tenantId: TenantId;
    readonly operationId: string;
    readonly activeOperationId: string;
}
export type TenantErasureResult = TenantErasureReadback | TenantErasureConflict;
export interface PostgresTenantErasureOptions {
    /** A Node direct-DSN pool. The host owns pool lifetime and write quiescence. */
    readonly pool: Pool;
    readonly clock: Clock;
    readonly objectStorage: R2ObjectMaintenance;
    /** ListObjectsV2 and one SQL DELETE use this bound; valid range is 1..1000. */
    readonly batchSize?: number;
    /** Maximum R2/SQL pages one operator invocation may advance; valid range is 1..100. */
    readonly maxPagesPerRun?: number;
    /** Crash-recovery lease; a retry may take an expired lease using the operation CAS. */
    readonly leaseMs?: number;
}
export interface PostgresTenantErasureCompositionOptions {
    readonly pool: Pool;
    readonly clock: Clock;
    readonly objectStorage: Omit<R2BlobStoreOptions, 'objects'>;
    readonly batchSize?: number;
    readonly maxPagesPerRun?: number;
    readonly leaseMs?: number;
}
/**
 * The Node-only erasure authority. It has no raw-table or raw-key API: the
 * static inventory and canonical R2 adapter are the only deletion authority.
 */
export declare class PostgresTenantErasure {
    #private;
    constructor(options: PostgresTenantErasureOptions);
    /** Read a durable operation receipt without advancing it. */
    readTenantErasure(tenant: TenantId, operationId: string): Promise<TenantErasureReadback | undefined>;
    /**
     * Advance one bounded operation slice. Calls with a completed id replay its
     * receipt; another running id for the same tenant gets a typed conflict.
     */
    eraseTenant(tenant: TenantId, operationId: string): Promise<TenantErasureResult>;
}
/** Build the Node maintenance composition against the same direct Postgres/R2 authorities. */
export declare function createPostgresTenantErasure(options: PostgresTenantErasureCompositionOptions): PostgresTenantErasure;
// ==== @byok-sdk/cloud-dataplane dist/truth-committer.d.ts ====
import { type CloudCrypto, type TruthCommitInput, type TruthCommitResult, type TruthCommitter } from '@byok-sdk/cloud';
import { type Clock, type TenantId, type TruthRecord } from '@byok-sdk/core';
import type { Pool } from 'pg';
export interface PostgresTruthCommitterOptions {
    readonly pool: Pool;
    readonly clock: Clock;
    readonly crypto: Pick<CloudCrypto, 'sha256'>;
}
export declare class PostgresTruthCommitter implements TruthCommitter {
    #private;
    constructor(options: PostgresTruthCommitterOptions);
    getRecord(tenant: TenantId, selector: Parameters<TruthCommitter['getRecord']>[1]): Promise<TruthRecord | undefined>;
    listManifest(tenant: TenantId, query: Parameters<TruthCommitter['listManifest']>[1]): Promise<readonly import("@byok-sdk/core").TruthManifestEntry[]>;
    commit(tenant: TenantId, input: TruthCommitInput): Promise<TruthCommitResult>;
}
