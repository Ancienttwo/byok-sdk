import { InMemoryAgentMessageDraftStore, deleteAgentMessageDraft } from './agent-message-draft';
export { InMemoryAgentMessageDraftStore } from './agent-message-draft';
export { InMemoryE2eeMemberStore } from './e2ee-member';
/**
 * The in-memory reference implementation of every cloud-local port.
 *
 * Same posture as `@byok-sdk/core`'s: a reference, not a production store. What it
 * guarantees is that the behavior the handler suites assert is achievable
 * without a database — which is what makes those same assertions meaningful
 * when a durable composition (S3b's journal, S4A's schema) runs them later.
 */
import type { Clock, MailboxStore, ObjectStore, TenantId } from '@byok-sdk/core';
import type { CloudCrypto } from '../../crypto/port';
import type { ProofReceiptRetentionAuthority } from '../../maintenance';
import type { TaskArchiveStore } from '../../task-archive';
import type { BlobContentProxy, CloudStores } from '../ports';
import { AllowAllRateLimiter } from './rate-limiter';
import { createInMemoryBlobs, type InMemoryBlobBytes } from './blobs';
import { InMemoryDeviceDirectory } from './device-directory';
import { InMemoryInboundDedupStore } from './dedup';
import { InMemoryNonceStore } from './nonces';
import { InMemoryPairingCodeStore } from './pairing-codes';
import { InMemoryRequestReceiptStore } from './receipts';
import { InMemoryProofReceiptRetentionAuthority, InMemoryProofRequestReceiptStore } from './proof-receipts';
import { InMemoryTaskArchiveStore } from './task-archive';
import { archiveAccessOf, type InMemoryMailboxArchiveAccess, type InMemoryObjectArchiveAccess } from './core-access';
import { InMemoryTaskAttemptState, InMemoryTaskAttemptStore } from './task-attempts';
import { InMemoryTaskCancellationStore } from './task-cancellations';
import { InMemoryActivityStore, closeActivityLog, deleteActivityTail } from './activity';
import { InMemoryApprovalTimelineStore, closeApprovalTimeline, deleteApprovalTimelineTail } from './approval-timeline';
import { InMemoryAgentEgressStore } from './agent-egress';

export { AllowAllRateLimiter } from './rate-limiter';
export {
  BLOB_URL_TTL_MS,
  InMemoryBlobContentProxy,
  InMemoryCloudBlobStore,
  createInMemoryBlobs,
  createInMemoryBlobBytes,
  InMemoryBlobBytes,
} from './blobs';
export type { InMemoryBlobs, InMemoryBlobStoreOptions } from './blobs';
export { DEDUP_RING_CAPACITY, InMemoryInboundDedupStore } from './dedup';
export { InMemoryDeviceDirectory } from './device-directory';
export { InMemoryNonceStore, NONCE_TTL_MS } from './nonces';
export { InMemoryPairingCodeStore } from './pairing-codes';
export { InMemoryRequestReceiptStore } from './receipts';
export { InMemoryProofRequestReceiptStore } from './proof-receipts';
export { InMemoryTaskAttemptStore } from './task-attempts';
export { InMemoryTaskCancellationStore } from './task-cancellations';
export { InMemoryActivityStore } from './activity';
export { InMemoryApprovalTimelineStore } from './approval-timeline';
export { InMemoryAgentEgressStore } from './agent-egress';

/**
 * The port bundle plus the byte proxy, in the shape `createInMemoryCoreStores`
 * already uses: the composition is an object with a `stores` field, not the
 * bundle itself.
 *
 * `blobContentProxy` sits BESIDE `stores` rather than inside it because it is
 * not a port — `createByokCloud` takes it as its own optional input, and a
 * composition that cannot carry bytes simply has none to hand over.
 */
export interface InMemoryCloudComposition {
  readonly stores: CloudStores;
  readonly blobContentProxy: BlobContentProxy;
  /** The owner of the used proof `requestId`s in `stores.proofReceipts`, for `proofReceiptRetention`. */
  readonly proofReceiptAuthority: ProofReceiptRetentionAuthority;
}

/** Deletes a task's ephemeral rows from the in-memory stores that `createInMemoryCloudStores` built; each returns the rows removed. */
export interface InMemoryEphemeralTaskRows {
  deleteActivity(tenant: TenantId, taskId: string): number;
  deleteApprovals(tenant: TenantId, taskId: string): number;
  deleteAgentMessageDraft(tenant: TenantId, taskId: string): number;
}

/** Builds the Host task archive for a core that is not the in-memory one. */
export type InMemoryTaskArchiveFactory = (rows: InMemoryEphemeralTaskRows) => TaskArchiveStore;

export function createInMemoryCloudStores(
  clock: Clock,
  crypto: CloudCrypto,
  objects: ObjectStore,
  mailbox: MailboxStore,
  objectBytes: InMemoryBlobBytes,
  /**
   * Absent, the archive rewrites the in-memory core `mailbox` and `objects`,
   * and construction throws when they are another core's. A host with another
   * core supplies the archive that owns its rows.
   */
  taskArchive?: InMemoryTaskArchiveFactory,
): InMemoryCloudComposition {
  const blobs = createInMemoryBlobs(objects, objectBytes);
  const activity = new InMemoryActivityStore(clock);
  const approvals = new InMemoryApprovalTimelineStore(clock);
  const taskState = new InMemoryTaskAttemptState(clock, (tenant, taskId, at) => {
    closeActivityLog(activity, tenant, taskId, at);
    closeApprovalTimeline(approvals, tenant, taskId, at);
  });
  const tasks = new InMemoryTaskAttemptStore(clock, taskState);
  const devices = new InMemoryDeviceDirectory(taskState, mailbox);
  const pairing = new InMemoryPairingCodeStore(clock, devices);
  const agentMessageDraft = new InMemoryAgentMessageDraftStore(clock);
  const receipts = new InMemoryRequestReceiptStore(clock);
  const proofReceipts = new InMemoryProofRequestReceiptStore(clock);
  return {
    stores: {
      activity,
      approvals,
      agentMessageDraft,
      devices,
      // One code/device authority, projected into issuance and consumption
      // ports so neither side exposes the other's methods.
      pairingCodes: { issue: pairing.issue.bind(pairing), collectExpired: pairing.collectExpired.bind(pairing) },
      pairing: { redeemAndRegister: pairing.redeemAndRegister.bind(pairing) },
      nonces: new InMemoryNonceStore(clock, crypto),
      dedup: new InMemoryInboundDedupStore(),
      tasks,
      cancellations: new InMemoryTaskCancellationStore(taskState, mailbox, devices),
      receipts,
      egress: new InMemoryAgentEgressStore(clock),
      proofReceipts,
      blobs: blobs.blobs,
      rateLimiter: new AllowAllRateLimiter(),
      taskArchive: taskArchive === undefined
        ? new InMemoryTaskArchiveStore({
            state: taskState,
            receipts,
            activity,
            approvals,
            drafts: agentMessageDraft,
            mailbox: archiveAccessOf<InMemoryMailboxArchiveAccess>(mailbox, 'mailbox'),
            objects: archiveAccessOf<InMemoryObjectArchiveAccess>(objects, 'object'),
          })
        : taskArchive({
            deleteActivity: (tenant, taskId) => deleteActivityTail(activity, tenant, taskId),
            deleteApprovals: (tenant, taskId) => deleteApprovalTimelineTail(approvals, tenant, taskId),
            deleteAgentMessageDraft: (tenant, taskId) => deleteAgentMessageDraft(agentMessageDraft, tenant, taskId),
          }),
    },
    blobContentProxy: blobs.contentProxy,
    proofReceiptAuthority: new InMemoryProofReceiptRetentionAuthority(proofReceipts),
  };
}
