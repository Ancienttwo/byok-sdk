import {
  createInMemoryCoreStores,
  tenantId,
  type Clock,
  type CoreStores,
  type MailboxStore,
  type TenantId,
} from '@byok-sdk/core';
import {
  createInMemoryCloudStores,
  createWebCrypto,
  type BlobContentProxy,
  type CloudCrypto,
  type CloudStores,
  type InboundDedupStore,
} from '@byok-sdk/cloud';
import { RateLimiter, createCountingInboundRateLimiter, type RateLimiterOptions } from './rate-limiter';
import type { DeviceConnections } from './connections';
import { createSqliteEmbeddedStores } from './stores/sqlite';
import type { ByokServerStorage } from './types';

/**
 * The store composition this façade hands the cloud kernel.
 *
 * Same parts as `@byok-sdk/cloud`'s own in-memory composition, with three
 * decorators layered on ports the kernel already calls, and nothing else:
 *
 * - `rateLimiter` becomes this package's token bucket, which is also where
 *   `envelopesIn` and `rateLimitEvents` are counted (the kernel debits it at
 *   gate step 0, for every envelope, before any other decision — the exact
 *   choke point `ConnectionHub.handleInbound` used to be);
 * - `dedup` counts the already-seen answers that back `dedupDrops`;
 * - `mailbox` reports each device-scoped read, which is how a device that only
 *   ever long-polls still counts as present.
 *
 * Decorators rather than kernel changes, deliberately: each counter is a fact
 * about a call this composition already makes, so it is observable from the
 * outside, and the kernel keeps no observability surface it would then have to
 * keep honest for every other deployment.
 */

/** Per-product blob size ceiling (§7): 100MB unless overridden. */
export const DEFAULT_MAX_BLOB_SIZE_BYTES = 100 * 1024 * 1024;

/**
 * Real time, deliberately — the same choice `@byok-sdk/cloud`'s in-memory
 * composition makes and for the same reason: a daemon compares the `expiresAt`
 * it is handed against its own wall clock, so a frozen clock would make every
 * minted token look expired.
 */
function systemClock(): Clock {
  return { now: () => new Date() };
}

/**
 * The one tenant an embedded server serves.
 *
 * An embedded `createByokServer` is a single product's coordinator, not a
 * multi-tenant control plane: there is no surface on it that could name a
 * second tenant and no request that could carry one. Deriving the id from
 * `productId` keeps that visible — one product, one tenant, and a device paired
 * into this instance can only ever land in it.
 */
export function serverTenantId(productId: string): TenantId {
  return tenantId(`product:${productId}`);
}

/** Live counter reads; every field is derived from a call the kernel already makes. */
export interface FacadeCounters {
  /** Every envelope the kernel's inbound gate was handed, whatever it decided. */
  readonly envelopesIn: number;
  /** Inbound envelopes recognized as an already-seen `(device, envelope id)` pair. */
  readonly dedupDrops: number;
  /** Inbound envelopes the bucket refused — one per envelope, never coalesced. */
  readonly rateLimitEvents: number;
}

export interface FacadeStoreComposition {
  readonly core: CoreStores;
  readonly cloud: CloudStores;
  readonly blobContentProxy: BlobContentProxy;
  readonly clock: Clock;
  readonly crypto: CloudCrypto;
  readonly counters: FacadeCounters;
  close(): Promise<void>;
}

export interface FacadeStoreOptions {
  readonly tenant: TenantId;
  readonly maxBlobSizeBytes: number;
  readonly storage?: ByokServerStorage;
  readonly rateLimit?: RateLimiterOptions;
  /** Where a device's own liveness observations are recorded. */
  readonly connections: DeviceConnections;
  /** Fired once per rate-limit EPISODE, not per refused envelope. */
  readonly onRateLimited: (deviceId: string, at: string) => void;
}

export function composeFacadeStores(options: FacadeStoreOptions): FacadeStoreComposition {
  const clock = systemClock();
  const crypto = createWebCrypto();
  const sqlite =
    options.storage?.kind === 'sqlite'
      ? createSqliteEmbeddedStores(
          {
            path: options.storage.path,
            ...(options.storage.urlTtlMs === undefined ? {} : { urlTtlMs: options.storage.urlTtlMs }),
          },
          { clock, crypto },
        )
      : undefined;
  const inMemoryCore = sqlite === undefined ? createInMemoryCoreStores({ clock }).stores : undefined;
  const core = sqlite?.core ?? inMemoryCore!;
  const inMemoryCloud =
    sqlite === undefined ? createInMemoryCloudStores(clock, crypto, core.objects, core.mailbox) : undefined;
  const stores = sqlite?.cloud ?? inMemoryCloud!.stores;
  const blobContentProxy = sqlite?.blobContentProxy ?? inMemoryCloud!.blobContentProxy;

  const rateLimiter = createCountingInboundRateLimiter(
    new RateLimiter(options.rateLimit),
    options.onRateLimited,
  );
  const dedup = countingDedup(stores.dedup);

  const counters: FacadeCounters = {
    get envelopesIn(): number {
      return rateLimiter.counters.envelopesIn;
    },
    get dedupDrops(): number {
      return dedup.drops();
    },
    get rateLimitEvents(): number {
      return rateLimiter.counters.rateLimitEvents;
    },
  };

  // Blob uploads reserve against the tenant's storage entitlement (`quota`), so
  // a composition that never writes one has working coordination and 4xx blob
  // routes. The embedded server has exactly one tenant and one configured
  // ceiling, so the entitlement is that ceiling — there is no second party here
  // to negotiate one.
  void core.quota.writeEntitlement(options.tenant, {
    version: 1n,
    hardLimitBytes: BigInt(options.maxBlobSizeBytes) * 1024n,
    maxObjectBytes: BigInt(options.maxBlobSizeBytes),
    maxInlineBytes: BigInt(options.maxBlobSizeBytes),
    mailboxLimitBytes: BigInt(options.maxBlobSizeBytes) * 1024n,
    retentionPolicyId: 'byok-server-embedded',
  });

  return {
    core: { ...core, mailbox: observingMailbox(core.mailbox, options.connections) },
    cloud: { ...stores, rateLimiter: rateLimiter.limiter, dedup },
    blobContentProxy,
    clock,
    crypto,
    counters,
    close: () => sqlite?.close() ?? Promise.resolve(),
  };
}

interface CountingDedupStore extends InboundDedupStore {
  drops(): number;
}

/**
 * Count the dedup hits the kernel resolves. A hit is a wire-level SUCCESS
 * (§8.2) that re-ran nothing, so it is invisible in the response and this
 * counter is the only place an embedder can see it happening at all.
 */
function countingDedup(inner: InboundDedupStore): CountingDedupStore {
  let drops = 0;
  return {
    async checkAndRecord(tenant, deviceId, envelopeId): Promise<boolean> {
      const seen = await inner.checkAndRecord(tenant, deviceId, envelopeId);
      if (seen) drops += 1;
      return seen;
    },
    async checkAndRecordAgent(tenant, deviceId, agentRef, envelopeId): Promise<boolean> {
      const seen = await inner.checkAndRecordAgent(tenant, deviceId, agentRef, envelopeId);
      if (seen) drops += 1;
      return seen;
    },
    drops: () => drops,
  };
}

/**
 * Mark a device present when it reads its mailbox.
 *
 * `GET /byok/events` is the long-poll transport's whole receive half, and a
 * device sitting on it is as connected as a device gets now — a poll is the
 * only sign of life a daemon with nothing to say ever produces. `readCursor` is
 * the one call every poll makes exactly once, before any hold, which makes it
 * the honest place to observe it.
 */
function observingMailbox(inner: MailboxStore, connections: DeviceConnections): MailboxStore {
  return {
    append: (tenant, input) => inner.append(tenant, input),
    readAfter: (tenant, query) => inner.readAfter(tenant, query),
    recordDelivery: (tenant, input) => inner.recordDelivery(tenant, input),
    advanceCursor: (tenant, input) => inner.advanceCursor(tenant, input),
    readCursor: (tenant, deviceId) => {
      connections.touch(deviceId, new Date().toISOString());
      return inner.readCursor(tenant, deviceId);
    },
    collectRetired: (tenant, input) => inner.collectRetired(tenant, input),
  };
}
