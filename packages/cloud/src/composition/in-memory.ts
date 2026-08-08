/**
 * The in-memory composition: core's reference stores plus cloud's, wired into
 * a working {@link ByokCloud}.
 *
 * This is what the handler suites and the client-side end-to-end test run
 * against, and it is the honest demonstration of the S3 claim — the daemon
 * cannot tell this from `@byok/server`, and nothing in the path needs a
 * database to prove it.
 */
import { createInMemoryCoreStores, type Clock, type CapabilityDeclaration, type CoreStores } from '@byok/core';
import { createHmacTokenSigner, type TokenSigner } from '../auth/tokens';
import { fullCapabilityDeclaration } from '../capabilities';
import { createWebCrypto } from '../crypto/web-crypto';
import type { CloudCrypto } from '../crypto/port';
import { createByokCloud, type ByokCloud } from '../cloud';
import { createInMemoryCloudStores } from '../stores/in-memory/index';
import type { BlobContentProxy, CloudStores } from '../stores/ports';

const TOKEN_SECRET_BYTES = 32;

/**
 * Real time by default, deliberately.
 *
 * Core's in-memory reference defaults to a FROZEN clock so TTL conformance is
 * deterministic. A composition serving a real daemon cannot: the daemon
 * compares the `expiresAt` it is handed against its own wall clock and would
 * treat every token from a clock stuck in the past as already expired. A test
 * that needs deterministic TTLs injects a mutable clock here instead.
 */
function systemClock(): Clock {
  return { now: () => new Date() };
}

export interface InMemoryByokCloudOptions {
  readonly clock?: Clock;
  readonly crypto?: CloudCrypto;
  readonly tokenSigner?: TokenSigner;
  readonly capabilities?: CapabilityDeclaration;
  readonly operatorId?: string;
  readonly maxBlobSizeBytes?: number;
  readonly longPollHoldMs?: number;
  readonly longPollIntervalMs?: number;
  readonly eventsPageLimit?: number;
  readonly accessTokenTtlSeconds?: number;
}

export interface InMemoryByokCloud {
  readonly cloud: ByokCloud;
  /** The naked stores, for a host that wants to inspect or seed state directly. */
  readonly core: CoreStores;
  readonly stores: CloudStores;
  /** The byte proxy the two `/content` routes were mounted on. */
  readonly blobContentProxy: BlobContentProxy;
  readonly clock: Clock;
  readonly crypto: CloudCrypto;
}

export function createInMemoryByokCloud(options: InMemoryByokCloudOptions = {}): InMemoryByokCloud {
  const clock = options.clock ?? systemClock();
  const crypto = options.crypto ?? createWebCrypto();
  const core = createInMemoryCoreStores({ clock }).stores;
  const { stores, blobContentProxy } = createInMemoryCloudStores(clock, crypto);
  const tokenSigner =
    options.tokenSigner ??
    createHmacTokenSigner(globalThis.crypto.getRandomValues(new Uint8Array(TOKEN_SECRET_BYTES)), clock);

  const cloud = createByokCloud({
    core,
    cloud: stores,
    // This composition has nowhere else to put bytes, so it supplies the proxy
    // and `fullCapabilityDeclaration()` declares `blobs.contentProxy`. That
    // pairing is what keeps hosted-in-memory behavior identical to what it was
    // before the port narrowed.
    blobContentProxy,
    crypto,
    tokenSigner,
    clock,
    capabilities: options.capabilities ?? fullCapabilityDeclaration(),
    ...(options.operatorId !== undefined ? { operatorId: options.operatorId } : {}),
    ...(options.maxBlobSizeBytes !== undefined ? { maxBlobSizeBytes: options.maxBlobSizeBytes } : {}),
    ...(options.longPollHoldMs !== undefined ? { longPollHoldMs: options.longPollHoldMs } : {}),
    ...(options.longPollIntervalMs !== undefined ? { longPollIntervalMs: options.longPollIntervalMs } : {}),
    ...(options.eventsPageLimit !== undefined ? { eventsPageLimit: options.eventsPageLimit } : {}),
    ...(options.accessTokenTtlSeconds !== undefined
      ? { accessTokenTtlSeconds: options.accessTokenTtlSeconds }
      : {}),
  });

  return { cloud, core, stores, blobContentProxy, clock, crypto };
}
