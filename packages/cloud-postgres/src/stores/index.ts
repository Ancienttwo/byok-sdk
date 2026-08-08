/**
 * The Postgres composition of the cloud-local ports.
 *
 * Seven durable stores, one in-memory limiter, and no blob store yet:
 *
 * - The seven implemented here are the ones with rows in
 *   `deploy/sql/0001_cloud_local.sql`.
 * - `rateLimiter` gets the allow-all reference and NO table, by design
 *   (docs/researches/s4a-dataplane-design.md §5). Persisting an allow-all would
 *   create a table that is always empty, and a real limiter is edge/infra work
 *   whose implementation would not be a per-request Postgres write either.
 * - `blobs` is absent because only half of it is a store: its bytes live in
 *   object storage, and S4A-c lands that adapter together with the capability
 *   split that narrows `CloudStores.blobs`. That is why this function returns
 *   the certified subset rather than a full `CloudStores` — an in-memory blob
 *   stand-in inside a composition calling itself "postgres" is exactly the
 *   silent downgrade this program exists to prevent.
 */
import { AllowAllRateLimiter, type CloudStores } from '@byok/cloud';
import type { CloudCrypto } from '@byok/cloud';
import type { Clock } from '@byok/core';
import type { Pool } from 'pg';
import { PostgresDeviceDirectory } from './devices';
import { PostgresInboundDedupStore } from './dedup';
import { PostgresNonceStore } from './nonces';
import { PostgresPairingCodeStore } from './pairing-codes';
import { PostgresRequestReceiptStore } from './receipts';
import { PostgresDeviceSequenceStore } from './sequence';
import { PostgresTaskAttemptStore } from './task-attempts';

export { PostgresDeviceDirectory } from './devices';
export { PostgresInboundDedupStore } from './dedup';
export { PostgresNonceStore } from './nonces';
export { PostgresPairingCodeStore } from './pairing-codes';
export { PostgresRequestReceiptStore } from './receipts';
export { PostgresDeviceSequenceStore } from './sequence';
export { PostgresTaskAttemptStore } from './task-attempts';
export {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PRESIGN_TTL_SECONDS,
  DEFAULT_RETRY_DELAY_MS,
  ObjectStoreRequestError,
  R2CloudBlobStore,
} from './r2-blobs';
export type { ObjectStoreFetch, R2BlobStoreOptions } from './r2-blobs';

/** The ports this composition supplies today. `blobs` joins in S4A-c. */
export type PostgresCloudStores = Pick<
  CloudStores,
  | 'devices'
  | 'pairingCodes'
  | 'nonces'
  | 'dedup'
  | 'tasks'
  | 'receipts'
  | 'sequence'
  | 'rateLimiter'
>;

export interface PostgresCloudStoreOptions {
  readonly pool: Pool;
  /**
   * The clock every TTL and timestamp in this composition reads. Injected, not
   * the database's `now()`: expiry has to be assertable under a test clock, and
   * a store that asks the server for the time cannot be.
   */
  readonly clock: Clock;
  readonly crypto: CloudCrypto;
}

export function createPostgresCloudStores(
  options: PostgresCloudStoreOptions,
): PostgresCloudStores {
  const { pool, clock, crypto } = options;
  return {
    devices: new PostgresDeviceDirectory(pool),
    pairingCodes: new PostgresPairingCodeStore(pool, clock),
    nonces: new PostgresNonceStore(pool, clock, crypto),
    dedup: new PostgresInboundDedupStore(pool),
    tasks: new PostgresTaskAttemptStore(pool, clock),
    receipts: new PostgresRequestReceiptStore(pool, clock),
    sequence: new PostgresDeviceSequenceStore(pool),
    rateLimiter: new AllowAllRateLimiter(),
  };
}
