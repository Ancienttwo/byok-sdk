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
import { AllowAllRateLimiter, type CloudStores } from '@byok-sdk/cloud';
import type { CloudCrypto } from '@byok-sdk/cloud';
import type { Clock } from '@byok-sdk/core';
import type { Pool } from 'pg';
import { PostgresObjectStore } from './core/objects';
import { R2CloudBlobStore, type R2BlobStoreOptions } from './r2-blobs';
import { PostgresDeviceDirectory } from './devices';
import { PostgresInboundDedupStore } from './dedup';
import { PostgresNonceStore } from './nonces';
import { PostgresPairingCodeStore } from './pairing-codes';
import { PostgresRequestReceiptStore } from './receipts';
import { PostgresProofRequestReceiptStore } from './proof-receipts';
import { PostgresTaskAttemptStore } from './task-attempts';
import { PostgresActivityStore } from './activity';
import { PostgresApprovalTimelineStore } from './approval-timeline';

export { PostgresDeviceDirectory } from './devices';
export { PostgresInboundDedupStore } from './dedup';
export { PostgresNonceStore } from './nonces';
export { PostgresPairingCodeStore } from './pairing-codes';
export { PostgresRequestReceiptStore } from './receipts';
export { PostgresProofRequestReceiptStore } from './proof-receipts';
export { PostgresTaskAttemptStore } from './task-attempts';
export { PostgresActivityStore } from './activity';
export { PostgresApprovalTimelineStore } from './approval-timeline';
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
} from './r2-blobs';
export type { ObjectStoreFetch, R2BlobErrorCode, R2BlobStoreOptions } from './r2-blobs';
export type {
  R2DeleteResult,
  R2ListedObject,
  R2ObjectMaintenance,
  R2ObjectMaintenanceOptions,
  R2ObjectPage,
} from './r2-blobs';

/** Every cloud-local port. All eleven, or it is not a composition. */
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

export function createPostgresCloudStores(
  options: PostgresCloudStoreOptions,
): PostgresCloudStores {
  const { pool, clock, crypto } = options;
  return {
    activity: new PostgresActivityStore(pool, clock),
    approvals: new PostgresApprovalTimelineStore(pool, clock),
    devices: new PostgresDeviceDirectory(pool),
    pairingCodes: new PostgresPairingCodeStore(pool, clock),
    nonces: new PostgresNonceStore(pool, clock, crypto),
    dedup: new PostgresInboundDedupStore(pool),
    tasks: new PostgresTaskAttemptStore(pool, clock),
    receipts: new PostgresRequestReceiptStore(pool, clock),
    proofReceipts: new PostgresProofRequestReceiptStore(pool, clock),
    // A second `PostgresObjectStore` instance, not a shared one: it is a
    // stateless wrapper over the pool, so the two read and write the same rows
    // under the same locks, and requiring the caller to build the core
    // composition first would be an ordering dependency bought for nothing.
    blobs: new R2CloudBlobStore({
      ...options.objectStorage,
      objects: new PostgresObjectStore(pool, clock),
    }),
    rateLimiter: new AllowAllRateLimiter(),
  };
}
