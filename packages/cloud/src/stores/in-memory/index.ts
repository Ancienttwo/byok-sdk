/**
 * The in-memory reference implementation of every cloud-local port.
 *
 * Same posture as `@byok/core`'s: a reference, not a production store. What it
 * guarantees is that the behavior the handler suites assert is achievable
 * without a database — which is what makes those same assertions meaningful
 * when a durable composition (S3b's journal, S4A's schema) runs them later.
 */
import type { Clock } from '@byok/core';
import type { CloudCrypto } from '../../crypto/port';
import type { CloudStores } from '../ports';
import { AllowAllRateLimiter } from './rate-limiter';
import { InMemoryCloudBlobStore } from './blobs';
import { InMemoryDeviceDirectory } from './device-directory';
import { InMemoryDeviceSequenceStore } from './sequence';
import { InMemoryInboundDedupStore } from './dedup';
import { InMemoryNonceStore } from './nonces';
import { InMemoryPairingCodeStore } from './pairing-codes';
import { InMemoryRequestReceiptStore } from './receipts';
import { InMemoryTaskAttemptStore } from './task-attempts';

export { AllowAllRateLimiter } from './rate-limiter';
export { BLOB_URL_TTL_MS, InMemoryCloudBlobStore } from './blobs';
export { DEDUP_RING_CAPACITY, InMemoryInboundDedupStore } from './dedup';
export { InMemoryDeviceDirectory } from './device-directory';
export { InMemoryDeviceSequenceStore } from './sequence';
export { InMemoryNonceStore, NONCE_TTL_MS } from './nonces';
export { InMemoryPairingCodeStore } from './pairing-codes';
export { InMemoryRequestReceiptStore } from './receipts';
export { InMemoryTaskAttemptStore } from './task-attempts';

export function createInMemoryCloudStores(clock: Clock, crypto: CloudCrypto): CloudStores {
  return {
    devices: new InMemoryDeviceDirectory(),
    pairingCodes: new InMemoryPairingCodeStore(clock),
    nonces: new InMemoryNonceStore(clock, crypto),
    dedup: new InMemoryInboundDedupStore(),
    tasks: new InMemoryTaskAttemptStore(clock),
    receipts: new InMemoryRequestReceiptStore(clock),
    sequence: new InMemoryDeviceSequenceStore(),
    blobs: new InMemoryCloudBlobStore(clock, crypto),
    rateLimiter: new AllowAllRateLimiter(),
  };
}
