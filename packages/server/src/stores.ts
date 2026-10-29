import {
  createInMemoryCoreStores,
  tenantId,
  type Clock,
  type CoreStores,
  type MailboxStore,
  type PresenceStore,
  type TenantId,
} from '@byok-sdk/core';
import {
  createInMemoryCloudStores,
  createInMemoryBlobBytes,
  createInProcessMailboxWake,
  type MailboxWake,
  createWebCrypto,
  type BlobContentProxy,
  type ProofReceiptRetentionAuthority,
  type CloudCrypto,
  type CloudStores,
  type InboundDedupStore,
} from '@byok-sdk/cloud';
import { RateLimiter, createCountingInboundRateLimiter, type RateLimiterOptions } from './rate-limiter';
import { createSqliteEmbeddedStores } from './stores/sqlite';
import { MemoryWakeStore, type WakeStore } from './wakes/store';
import type { WakeConsumer } from './wakes/types';
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
 *   choke point the old reference server's `ConnectionHub.handleInbound`
 *   used to be);
 * - `dedup` counts the already-seen answers that back `dedupDrops`;
 * - `mailbox` reports each device-scoped read, which is how a device that only
 *   ever long-polls still counts as present;
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
  readonly mailboxWake: MailboxWake;
  readonly core: CoreStores;
  readonly cloud: CloudStores;
  readonly blobContentProxy: BlobContentProxy;
  readonly proofReceiptAuthority: ProofReceiptRetentionAuthority;
  readonly clock: Clock;
  readonly crypto: CloudCrypto;
  readonly counters: FacadeCounters;
  readonly wakes: WakeStore;
  close(): Promise<void>;
}

export interface FacadeStoreOptions {
  readonly tenant: TenantId;
  readonly maxBlobSizeBytes: number;
  readonly storage?: ByokServerStorage;
  readonly rateLimit?: RateLimiterOptions;
  /** One TTL for heartbeat and authenticated transport observations. */
  readonly presenceTtlMs: number;
  readonly wake?: WakeConsumer;
  /** Fired once per rate-limit EPISODE, not per refused envelope. */
  readonly onRateLimited: (deviceId: string, at: string) => void;
}

export function composeFacadeStores(options: FacadeStoreOptions): FacadeStoreComposition {
  const clock = systemClock();
  const crypto = createWebCrypto();
  const sqlite =
    options.storage?.kind === 'sqlite'
      ? createSqliteEmbeddedStores(
          options.storage,
          { clock, crypto, ...(options.wake === undefined ? {} : { wake: options.wake }) },
        )
      : undefined;
  const objectBytes = sqlite === undefined ? createInMemoryBlobBytes(clock, crypto) : undefined;
  const inMemoryCore = objectBytes === undefined ? undefined : createInMemoryCoreStores({ clock, objectBytes }).stores;
  const core = sqlite?.core ?? inMemoryCore!;
  const inMemoryCloud =
    sqlite === undefined ? createInMemoryCloudStores(clock, crypto, core.objects, core.mailbox, objectBytes!) : undefined;
  const stores = sqlite?.cloud ?? inMemoryCloud!.stores;
  const blobContentProxy = sqlite?.blobContentProxy ?? inMemoryCloud!.blobContentProxy;

  const rateLimiter = createCountingInboundRateLimiter(
    new RateLimiter(options.rateLimit),
    options.onRateLimited,
  );
  const presence = serialPresence(core.presence, options.presenceTtlMs);
  const dedup = countingDedup(stores.dedup, presence);

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
    mailboxWake: createInProcessMailboxWake(),
    core: { ...core, presence, mailbox: observingMailbox(core.mailbox, presence) },
    cloud: {
      ...stores,
      rateLimiter: rateLimiter.limiter,
      dedup,
    },
    blobContentProxy,
    proofReceiptAuthority: sqlite?.proofReceiptAuthority ?? inMemoryCloud!.proofReceiptAuthority,
    clock,
    crypto,
    counters,
    wakes: sqlite?.wakes(options.tenant) ?? new MemoryWakeStore(),
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
function countingDedup(inner: InboundDedupStore, presence: LeasedPresence): CountingDedupStore {
  let drops = 0;
  return {
    async checkAndRecord(tenant, deviceId, envelopeId): Promise<boolean> {
      const seen = await inner.checkAndRecord(tenant, deviceId, envelopeId);
      if (seen) drops += 1;
      if (!seen) await presence.renew(tenant, deviceId);
      return seen;
    },
    async checkAndRecordAgent(tenant, deviceId, agentRef, envelopeId): Promise<boolean> {
      const seen = await inner.checkAndRecordAgent(tenant, deviceId, agentRef, envelopeId);
      if (seen) drops += 1;
      if (!seen) await presence.renew(tenant, deviceId);
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
function observingMailbox(inner: MailboxStore, presence: LeasedPresence): MailboxStore {
  return {
    append: (tenant, input) => inner.append(tenant, input),
    readUsage: (tenant) => inner.readUsage(tenant),
    readAfter: (tenant, query) => inner.readAfter(tenant, query),
    recordDelivery: (tenant, input) => inner.recordDelivery(tenant, input),
    advanceCursor: (tenant, input) => inner.advanceCursor(tenant, input),
    readCursor: async (tenant, deviceId) => {
      const cursor = await inner.readCursor(tenant, deviceId);
      await presence.renew(tenant, deviceId);
      return cursor;
    },
    collectExpired: (tenant, input) => inner.collectExpired(tenant, input),
  };
}

interface LeasedPresence extends PresenceStore {
  renew(tenant: TenantId, deviceId: string): Promise<void>;
}

/**
 * One store, with per-device write exclusion shared by heartbeat and transport.
 * A renewal reads and republishes live discovery facts, so that pair must not
 * overwrite a heartbeat that committed between them. Only in-flight barriers
 * live here; the inner core store owns every presence fact and expiry decision.
 */
function serialPresence(inner: PresenceStore, ttlMs: number): LeasedPresence {
  const pending = new Map<string, Promise<void>>();
  async function write<T>(tenant: TenantId, deviceId: string, operation: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([tenant, deviceId]);
    const previous = pending.get(key);
    let release!: () => void;
    const done = new Promise<void>(resolve => { release = resolve; });
    pending.set(key, done);
    if (previous !== undefined) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (pending.get(key) === done) pending.delete(key);
    }
  }
  return {
    read: (tenant, deviceId) => inner.read(tenant, deviceId),
    list: tenant => inner.list(tenant),
    collectExpired: (tenant, input) => inner.collectExpired(tenant, input),
    publish: (tenant, input) => write(tenant, input.deviceId, () => inner.publish(tenant, input)),
    renew: (tenant, deviceId) => write(tenant, deviceId, async () => {
      const current = await inner.read(tenant, deviceId);
      await inner.publish(tenant, {
        ...current, deviceId, level: current?.level ?? 'online', ttlMs, minimumIntervalMs: 0,
      });
    }),
  };
}
