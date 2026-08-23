/**
 * The declared method inventory of every cloud-local port.
 *
 * The exact counterpart of `@byok-sdk/core`'s `ports-contract.ts`, and it exists
 * for the same reason: the table says what a port IS, so it has to be readable
 * by every enforcer without any of them owning it. `@byok-sdk/conformance` asserts
 * live compositions against it; a durable adapter (`@byok-sdk/cloud-dataplane`) is
 * written against it.
 *
 * This module adds data and nothing else. It does not re-declare, re-shape, or
 * re-interpret a single line of `ports.ts` — that file stays the authority for
 * what the methods mean, and stayed byte-identical through S4A-a.
 *
 * Adding a port method means editing this table, which is the point: a port
 * grows by contract, not by whichever composition needed something.
 */
import type { CloudStoreName } from './ports';

export const CLOUD_PORT_METHODS: Readonly<Record<CloudStoreName, readonly string[]>> = {
  activity: ['append', 'read'],
  approvals: ['append', 'read'],
  devices: ['register', 'get', 'revoke', 'list', 'readiness', 'recordCapabilities', 'resolveByDeviceId'],
  pairingCodes: ['issue', 'redeem'],
  nonces: ['issue', 'validate', 'markUsed'],
  dedup: ['checkAndRecord'],
  tasks: ['open', 'reserveAgentOffer', 'get', 'getMany', 'claim', 'recordStatus'],
  cancellations: ['request'],
  receipts: ['record', 'get'],
  proofReceipts: ['record', 'get'],
  // Three methods, not six: the byte-proxy trio moved to `BlobContentProxy`,
  // which is a composition input rather than a port and therefore has no row
  // in this table (docs/researches/s4a-dataplane-design.md §6).
  blobs: ['createUpload', 'observeUpload', 'getDownloadUrl'],
  rateLimiter: ['consume'],
};

/** The interface each port name is declared as, for a source-side scan. */
export const CLOUD_PORT_INTERFACES: Readonly<Record<CloudStoreName, string>> = {
  activity: 'ActivityStore',
  approvals: 'ApprovalTimelineStore',
  devices: 'DeviceDirectory',
  pairingCodes: 'PairingCodeStore',
  nonces: 'NonceStore',
  dedup: 'InboundDedupStore',
  tasks: 'TaskAttemptStore',
  cancellations: 'TaskCancellationStore',
  receipts: 'RequestReceiptStore',
  proofReceipts: 'ProofRequestReceiptStore',
  blobs: 'CloudBlobStore',
  rateLimiter: 'InboundRateLimiter',
};
