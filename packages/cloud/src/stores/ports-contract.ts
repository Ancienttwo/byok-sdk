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
import type { CloudStoreName } from './ports.js';

export const CLOUD_PORT_METHODS: Readonly<Record<CloudStoreName, readonly string[]>> = {
  activity: ['append', 'read', 'settle', 'collectExpired'],
  agentMessageDraft: ['apply', 'read', 'delete', 'sweepExpired'],
  approvals: ['append', 'read', 'resolvePending', 'collectExpired'],
  devices: ['register', 'get', 'revoke', 'list', 'readiness', 'recordCapabilities', 'resolveByDeviceId'],
  pairingCodes: ['issue', 'collectExpired'],
  pairing: ['redeemAndRegister'],
  nonces: ['issue', 'consumeIfValid', 'collectExpired', 'deleteDevice'],
  dedup: ['checkAndRecord', 'checkAndRecordAgent', 'deleteDevice'],
  tasks: [
    'reserveAgentOffer',
    'reserveAgentMessage',
    'recordFirstOutput',
    'readAgentMessage',
    'readTaskAgentMessage',
    'finalizeAgentMessage',
    'get',
    'getMany',
    'list',
    'countByStatus',
    'claim',
    'recordStatus',
  ],
  cancellations: ['request', 'abandon'],
  receipts: ['record', 'get', 'collectExpired'],
  steerRefusals: ['record', 'get', 'list'],
  egress: ['record', 'get'],
  proofReceipts: ['record', 'get'],
  // Three methods, not six: the byte-proxy trio moved to `BlobContentProxy`,
  // which is a composition input rather than a port and therefore has no row
  // in this table (docs/researches/s4a-dataplane-design.md §6).
  blobs: ['createUpload', 'observeUpload', 'getDownloadUrl'],
  rateLimiter: ['consume'],
  taskArchive: ['listWork', 'archive', 'settle'],
};
