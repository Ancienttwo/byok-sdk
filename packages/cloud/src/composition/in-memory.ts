/**
 * The in-memory composition: core's reference stores plus cloud's, wired into
 * a working {@link ByokCloud}.
 *
 * This is what the handler suites and the client-side end-to-end test run
 * against, and it is the honest demonstration of the S3 claim — the daemon
 * cannot tell this from `@byok-sdk/server`, and nothing in the path needs a
 * database to prove it.
 */
import {
  createInMemoryCoreStores,
  type CapabilityDeclaration,
  type Clock,
  type CoreStores,
  type SkillPackStore,
} from '@byok-sdk/core';
import { createHmacTokenSigner, type TokenSigner } from '../auth/tokens';
import { fullCapabilityDeclaration } from '../capabilities';
import { createWebCrypto } from '../crypto/web-crypto';
import type { CloudCrypto } from '../crypto/port';
import { createByokCloud, type ByokCloud, type ByokCloudOptions } from '../cloud';
import { createInMemoryCloudStores } from '../stores/in-memory/index';
import type { BlobContentProxy, CloudStores } from '../stores/ports';
import type { TruthCommitter, TruthObjectDownloads } from '../truth/contract';

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
  readonly boardPageLimit?: number;
  readonly boardStreamQueryIntervalMs?: number;
  readonly boardStreamHeartbeatIntervalMs?: number;
  readonly boardStreamReconciliationIntervalMs?: number;
  readonly boardChannelMaxBytes?: number;
  readonly boardTitleMaxBytes?: number;
  readonly presenceTtlMs?: number;
  readonly presenceMinimumIntervalMs?: number;
  readonly presenceDetailMaxBytes?: number;
  readonly activityMaxEvents?: number;
  readonly activityMaxBytes?: number;
  readonly activityCapacity?: number;
  readonly activityTtlMs?: number;
  /** Test/host supplied atomic truth authority; never synthesized from sequential stores. */
  readonly truthCommitter?: TruthCommitter;
  readonly truthObjectDownloads?: TruthObjectDownloads;
  readonly maxTruthRequestBytes?: number;
  /**
   * Host/test supplied skill pack catalogue. Absent by default, and
   * `fullCapabilityDeclaration()` withholds `skills.pack` to match — a
   * composition that declared a channel it has no store for would be refused at
   * construction, which would break every existing in-memory deployment.
   */
  readonly skillPacks?: SkillPackStore;
  readonly skillPackPageLimit?: number;
  readonly agentMessage?: ByokCloudOptions['agentMessage'];
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
  const { stores, blobContentProxy } = createInMemoryCloudStores(
    clock,
    crypto,
    core.objects,
    core.mailbox,
  );
  const tokenSigner =
    options.tokenSigner ??
    createHmacTokenSigner(globalThis.crypto.getRandomValues(new Uint8Array(TOKEN_SECRET_BYTES)), clock);

  const cloud = createByokCloud({
    core,
    cloud: stores,
    // This composition has nowhere else to put bytes, so it supplies the proxy
    // and `fullCapabilityDeclaration()` declares `blobs.contentproxy`. That
    // pairing is what keeps hosted-in-memory behavior identical to what it was
    // before the port narrowed.
    blobContentProxy,
    crypto,
    tokenSigner,
    clock,
    capabilities: options.capabilities ?? fullCapabilityDeclaration(),
    ...(options.truthCommitter === undefined ? {} : { truthCommitter: options.truthCommitter }),
    ...(options.truthObjectDownloads === undefined
      ? {}
      : { truthObjectDownloads: options.truthObjectDownloads }),
    ...(options.operatorId !== undefined ? { operatorId: options.operatorId } : {}),
    ...(options.agentMessage === undefined ? {} : { agentMessage: options.agentMessage }),
    ...(options.maxBlobSizeBytes !== undefined ? { maxBlobSizeBytes: options.maxBlobSizeBytes } : {}),
    ...(options.longPollHoldMs !== undefined ? { longPollHoldMs: options.longPollHoldMs } : {}),
    ...(options.longPollIntervalMs !== undefined ? { longPollIntervalMs: options.longPollIntervalMs } : {}),
    ...(options.eventsPageLimit !== undefined ? { eventsPageLimit: options.eventsPageLimit } : {}),
    ...(options.accessTokenTtlSeconds !== undefined
      ? { accessTokenTtlSeconds: options.accessTokenTtlSeconds }
      : {}),
    ...(options.boardPageLimit === undefined ? {} : { boardPageLimit: options.boardPageLimit }),
    ...(options.boardStreamQueryIntervalMs === undefined
      ? {}
      : { boardStreamQueryIntervalMs: options.boardStreamQueryIntervalMs }),
    ...(options.boardStreamHeartbeatIntervalMs === undefined
      ? {}
      : { boardStreamHeartbeatIntervalMs: options.boardStreamHeartbeatIntervalMs }),
    ...(options.boardStreamReconciliationIntervalMs === undefined
      ? {}
      : { boardStreamReconciliationIntervalMs: options.boardStreamReconciliationIntervalMs }),
    ...(options.boardChannelMaxBytes === undefined
      ? {}
      : { boardChannelMaxBytes: options.boardChannelMaxBytes }),
    ...(options.boardTitleMaxBytes === undefined
      ? {}
      : { boardTitleMaxBytes: options.boardTitleMaxBytes }),
    ...(options.presenceTtlMs === undefined ? {} : { presenceTtlMs: options.presenceTtlMs }),
    ...(options.presenceMinimumIntervalMs === undefined
      ? {}
      : { presenceMinimumIntervalMs: options.presenceMinimumIntervalMs }),
    ...(options.presenceDetailMaxBytes === undefined
      ? {}
      : { presenceDetailMaxBytes: options.presenceDetailMaxBytes }),
    ...(options.activityMaxEvents === undefined ? {} : { activityMaxEvents: options.activityMaxEvents }),
    ...(options.activityMaxBytes === undefined ? {} : { activityMaxBytes: options.activityMaxBytes }),
    ...(options.activityCapacity === undefined ? {} : { activityCapacity: options.activityCapacity }),
    ...(options.activityTtlMs === undefined ? {} : { activityTtlMs: options.activityTtlMs }),
    ...(options.maxTruthRequestBytes === undefined
      ? {}
      : { maxTruthRequestBytes: options.maxTruthRequestBytes }),
    ...(options.skillPacks === undefined ? {} : { skillPacks: options.skillPacks }),
    ...(options.skillPackPageLimit === undefined
      ? {}
      : { skillPackPageLimit: options.skillPackPageLimit }),
  });

  return { cloud, core, stores, blobContentProxy, clock, crypto };
}
