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

// The pool factory (int8 parsing configured per-pool, never globally)
export { createByokPool } from './pool';
export type { ByokPoolOptions } from './pool';

// The cloud-local port implementations, and the composition that bundles them
export {
  PostgresDeviceDirectory,
  PostgresInboundDedupStore,
  PostgresNonceStore,
  PostgresPairingCodeStore,
  PostgresProofRequestReceiptStore,
  PostgresRequestReceiptStore,
  PostgresTaskAttemptStore,
  PostgresTaskCancellationStore,
  PostgresActivityStore,
  PostgresApprovalTimelineStore,
  PostgresDeviceAssertionReplayAuthority,
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

// The core port implementations, and the composition that bundles them. All
// seven ship together because `runCoreConformance` certifies a composition as
// a whole — a partial `CoreStores` is not something the suite can run.
export {
  PostgresBoardStore,
  PostgresMailboxStore,
  PostgresObjectStore,
  PostgresPresenceStore,
  PostgresQuotaStore,
  PostgresSkillPackStore,
  PostgresTruthStore,
  createPostgresCoreStores,
} from './stores/core/index';
export type { PostgresCoreStoreOptions } from './stores/core/index';

export { PostgresTruthCommitter } from './truth-committer';
export type { PostgresTruthCommitterOptions } from './truth-committer';
