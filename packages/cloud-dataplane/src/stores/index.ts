import { PostgresAgentMessageDraftStore } from './agent-message-draft';
export { PostgresAgentMessageDraftStore } from './agent-message-draft';
/**
 * The Postgres composition of the cloud-local ports.
 *
 * Nine durable stores, one object-storage blob store, one in-process limiter:
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
 * - `rateLimiter` is a per-process token bucket over every inbound envelope
 *   and admitted device route request, configured by the required `rateLimit`
 *   option, with NO table: a per-request Postgres write would cost more than
 *   the flood it refuses (`rate-limiter.ts`).
 */
import type { CloudStores } from '@byok-sdk/cloud';
import type { CloudCrypto } from '@byok-sdk/cloud';
import type { Clock } from '@byok-sdk/core';
import type { ByokPool } from '../pool';
import { assertByokPool } from '../pool-brand';
import { PostgresObjectStore } from './core/objects';
import { R2CloudBlobStore, R2ObjectMaintenanceStore, type R2BlobStoreOptions } from './r2-blobs';
import { PostgresDeviceDirectory } from './devices';
import { PostgresInboundDedupStore } from './dedup';
import { PostgresNonceStore } from './nonces';
import { PostgresPairingCodeStore } from './pairing-codes';
import { PostgresRequestReceiptStore } from './receipts';
import { PostgresTaskArchiveStore } from './task-archive';
import { PostgresProofRequestReceiptStore } from './proof-receipts';
import { PostgresTaskAttemptStore } from './task-attempts';
import { PostgresTaskCancellationStore } from './task-cancellations';
import { PostgresActivityStore } from './activity';
import { PostgresApprovalTimelineStore } from './approval-timeline';
import { PostgresAgentEgressStore } from './agent-egress';
import { assertPendingMailboxProtocol } from './mailbox-protocol';
import { TokenBucketRateLimiter, type PostgresRateLimitOptions } from './rate-limiter';

export { PostgresDeviceDirectory } from './devices';
export { PostgresInboundDedupStore } from './dedup';
export { PostgresNonceStore } from './nonces';
export { PostgresPairingCodeStore } from './pairing-codes';
export { PostgresRequestReceiptStore } from './receipts';
export { PostgresProofReceiptRetentionAuthority, PostgresProofRequestReceiptStore } from './proof-receipts';
export { PostgresTaskAttemptStore } from './task-attempts';
export { PostgresTaskCancellationStore } from './task-cancellations';
export { PostgresActivityStore } from './activity';
export { PostgresApprovalTimelineStore } from './approval-timeline';
export { PostgresAgentEgressStore } from './agent-egress';
export type { PostgresRateLimitOptions } from './rate-limiter';
export {
  POSTGRES_MAILBOX_PROTOCOL_UNSUPPORTED,
  PostgresMailboxProtocolUnsupportedError,
} from './mailbox-protocol';
export {
  PostgresAgentMemoryProjectionStore,
  createPostgresAgentMemoryProjectionStore,
} from './agent-memory-projection';
export type { PostgresAgentMemoryProjectionStoreOptions } from './agent-memory-projection';
export { PostgresTaskRedactionStore, createPostgresTaskRedactionStore } from './task-redaction';
export { PostgresE2eeMemberStore } from './e2ee-member';
export type { PostgresTaskRedactionStoreOptions } from './task-redaction';
export { PostgresDeviceAssertionReplayAuthority } from './device-assertion-replay';
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

/** Every cloud-local port. All twelve, or it is not a composition. */
export type PostgresCloudStores = CloudStores;

/** Everything the blob store needs that is not already a composition-wide input. */
export type PostgresObjectStorageOptions = Omit<R2BlobStoreOptions, 'objects'>;

export interface PostgresCloudStoreOptions {
  readonly pool: ByokPool;
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
  /**
   * Each device's admission budget, per process: every inbound envelope and
   * every authenticated device route request except `POST /byok/messages`
   * spends one token. Required — there is no unlimited composition.
   */
  readonly rateLimit: PostgresRateLimitOptions;
}

/**
 * Compose the cloud-local ports over one pool.
 *
 * Async because it first fences the wire major (PRD §8.3): if any pending
 * mailbox row is not a `PROTOCOL_VERSION` envelope it rejects with
 * {@link PostgresMailboxProtocolUnsupportedError} and returns no stores. The
 * check is read-only — no row is rewritten or deleted — and there is no
 * synchronous variant that skips it.
 *
 * The fence lives here, on the cloud composition, and not on
 * `createPostgresCoreStores`: the core `MailboxStore` port carries opaque
 * bodies (its conformance suite appends non-envelope strings), and only the
 * cloud layer gives those bodies wire-envelope meaning. A hosted cloud is
 * always composed with this factory, so it cannot start over an undrained v2
 * mailbox.
 */
export async function createPostgresCloudStores(
  options: PostgresCloudStoreOptions,
): Promise<PostgresCloudStores> {
  const { pool, clock, crypto } = options;
  assertByokPool(pool, 'createPostgresCloudStores');
  await assertPendingMailboxProtocol(pool);
  const devices = new PostgresDeviceDirectory(pool, clock);
  const pairing = new PostgresPairingCodeStore(pool, clock);
  return {
    activity: new PostgresActivityStore(pool, clock),
    approvals: new PostgresApprovalTimelineStore(pool, clock),
    agentMessageDraft: new PostgresAgentMessageDraftStore(pool, clock),
    devices,
    // One durable code authority, projected into issuance and enrollment ports
    // so consumers cannot reopen the old redeem-then-register sequence.
    pairingCodes: { issue: pairing.issue.bind(pairing), collectExpired: pairing.collectExpired.bind(pairing) },
    pairing: { redeemAndRegister: pairing.redeemAndRegister.bind(pairing) },
    nonces: new PostgresNonceStore(pool, clock, crypto),
    dedup: new PostgresInboundDedupStore(pool),
    tasks: new PostgresTaskAttemptStore(pool, clock),
    cancellations: new PostgresTaskCancellationStore(pool, clock),
    receipts: new PostgresRequestReceiptStore(pool, clock),
    egress: new PostgresAgentEgressStore(pool, clock),
    proofReceipts: new PostgresProofRequestReceiptStore(pool, clock),
    // A second `PostgresObjectStore` instance, not a shared one: it is a
    // stateless wrapper over the pool, so the two read and write the same rows
    // under the same locks, and requiring the caller to build the core
    // composition first would be an ordering dependency bought for nothing.
    blobs: new R2CloudBlobStore({
      ...options.objectStorage,
      objects: new PostgresObjectStore(pool, clock, new R2ObjectMaintenanceStore(options.objectStorage)),
    }),
    rateLimiter: new TokenBucketRateLimiter(options.rateLimit, clock),
    taskArchive: new PostgresTaskArchiveStore(pool, clock),
  };
}
