/**
 * The declared method inventory of every cloud-local port.
 *
 * The exact counterpart of `@byok/core`'s `ports-contract.ts`, and it exists
 * for the same reason: the table says what a port IS, so it has to be readable
 * by every enforcer without any of them owning it. `@byok/conformance` asserts
 * live compositions against it; a durable adapter (`@byok/cloud-postgres`) is
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
  devices: ['register', 'get', 'revoke', 'list', 'resolveByDeviceId'],
  pairingCodes: ['issue', 'redeem'],
  nonces: ['issue', 'validate', 'markUsed'],
  dedup: ['checkAndRecord'],
  tasks: ['open', 'get', 'claim', 'recordStatus'],
  receipts: ['record', 'get'],
  sequence: ['next'],
  blobs: ['createUpload', 'getDownloadUrl', 'verifySignedUrl', 'writeContent', 'readContent'],
  rateLimiter: ['consume'],
};

/** The interface each port name is declared as, for a source-side scan. */
export const CLOUD_PORT_INTERFACES: Readonly<Record<CloudStoreName, string>> = {
  devices: 'DeviceDirectory',
  pairingCodes: 'PairingCodeStore',
  nonces: 'NonceStore',
  dedup: 'InboundDedupStore',
  tasks: 'TaskAttemptStore',
  receipts: 'RequestReceiptStore',
  sequence: 'DeviceSequenceStore',
  blobs: 'CloudBlobStore',
  rateLimiter: 'InboundRateLimiter',
};
