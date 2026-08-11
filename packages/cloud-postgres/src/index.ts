/**
 * `@byok-sdk/cloud-postgres` — the durable data plane.
 *
 * `cloud-postgres → core + cloud + pg`, and never the reverse. The two
 * platform-neutral packages stay loadable on Workers precisely because the
 * database driver lives here (design §4): `@byok-sdk/cloud` is a stateless handler
 * package, and a `hono` user must not be made to install `pg` to use it.
 *
 * The naming family is `@byok-sdk/cloud-<transaction authority>`; a future optional
 * D1 adapter would be `@byok-sdk/cloud-d1`.
 */

// The pool factory (int8 parsing configured per-pool, never globally)
export { createByokPool } from './pool';
export type { ByokPoolOptions } from './pool';

// The forward-only migration runner
export { MigrationChecksumMismatchError, MigrationFilenameError, migrate, readMigrationFiles } from './migrate';
export type { MigrationFile, MigrationResult } from './migrate';

// The cloud-local port implementations, and the composition that bundles them
export {
  PostgresDeviceDirectory,
  PostgresDeviceSequenceStore,
  PostgresInboundDedupStore,
  PostgresNonceStore,
  PostgresPairingCodeStore,
  PostgresRequestReceiptStore,
  PostgresTaskAttemptStore,
  createPostgresCloudStores,
} from './stores/index';
export type {
  PostgresCloudStoreOptions,
  PostgresCloudStores,
  PostgresObjectStorageOptions,
} from './stores/index';

// The object-storage half of blobs. Grants only: this composition supplies no
// `BlobContentProxy`, because a device uploading straight to R2 is exactly what
// having no byte-proxy path means.
export {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PRESIGN_TTL_SECONDS,
  DEFAULT_RETRY_DELAY_MS,
  MAX_PRESIGN_TTL_SECONDS,
  MIN_PRESIGN_TTL_SECONDS,
  ObjectStoreRequestError,
  R2_BLOB_ERROR_CODES,
  R2BlobStoreError,
  R2CloudBlobStore,
  R2ObjectMaintenanceStore,
} from './stores/index';
export type { ObjectStoreFetch, R2BlobErrorCode, R2BlobStoreOptions } from './stores/index';
export type {
  R2DeleteResult,
  R2ListedObject,
  R2ObjectMaintenance,
  R2ObjectMaintenanceOptions,
  R2ObjectPage,
} from './stores/index';

// The seven core port implementations, and the composition that bundles them.
// All seven ship together because `runCoreConformance` certifies a composition
// as a whole — a partial `CoreStores` is not something the suite can run.
export {
  PostgresActivityStore,
  PostgresBoardStore,
  PostgresMailboxStore,
  PostgresObjectStore,
  PostgresPresenceStore,
  PostgresQuotaStore,
  PostgresTruthStore,
  createPostgresCoreStores,
} from './stores/core/index';
export type { PostgresCoreStoreOptions } from './stores/core/index';

// Host-owned retention/dead-letter/R2 GC and reconciliation. This is separate
// from CoreStores because it coordinates one concrete SQL authority with one
// concrete byte store; it is not a domain port every composition must fake.
export {
  CLOUD_CLEANUP_ERROR_CODES,
  CloudCleanupError,
  PostgresCloudCleanup,
  createPostgresCloudMaintenance,
} from './cleanup';

export { PostgresTruthCommitter } from './truth-committer';
export type { PostgresTruthCommitterOptions } from './truth-committer';
export type {
  CleanupJobState,
  CloudCleanupErrorCode,
  CloudCleanupResult,
  DeadLetterPage,
  DeadLetterQuery,
  DeadLetterRef,
  DeadLetterReplayInput,
  ObjectUsageRebuildResult,
  PostgresCloudCleanupOptions,
  PostgresCloudMaintenanceOptions,
  TenantRetentionPolicy,
  TenantRetentionPolicyInput,
} from './cleanup';
