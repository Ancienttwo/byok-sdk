/**
 * #1118: every Host route is bounded and every device route is rate-admitted.
 *
 * The checks walk the router's own inventory (`cloud.routes`) of a composition
 * that supplies every port-bound capability, so an optional route (truth
 * records, E2EE members, skill packs, Agent-memory projection) is covered the
 * same way as a default one, and a route added tomorrow is covered without
 * editing this file. Body reads are detected by what a route actually pulls
 * from its request stream: `c.req.json()`, `c.req.raw.arrayBuffer()` and every
 * other read API drain the same stream, so no API escapes the measurement.
 */
import { createHash } from 'node:crypto';
import { InMemorySkillPackStore, type TenantId } from '@byok-sdk/core';
import { createEnvelope, PROTOCOL_VERSION, type CreateBlobResponse, type Envelope, type MessagesSendResponse, type PairResponse } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { createHmacTokenSigner } from '../auth/tokens';
import { CAPABILITY_PORTS, capabilityDeclarationForPorts, type CapabilityPorts } from '../capabilities';
import { createByokCloud, type ByokCloud } from '../cloud';
import { createInMemoryByokCloud } from '../composition/in-memory';
import { createInProcessMailboxWake } from '@byok-sdk/cloud';
import { routeKey } from '../router/registry';
import { InMemoryAgentMemoryProjectionAuthorizer, InMemoryAgentMemoryProjectionStore } from '../stores/in-memory/agent-memory-projection';
import { InMemoryE2eeMemberStore } from '../stores/in-memory/e2ee-member';
import type { CloudStores, InboundRateLimiter, RateLimitUnit } from '../stores/ports';
import type { TruthCommitter, TruthObjectDownloads } from '../truth/contract';
import { CLOUD_ORIGIN, PRODUCT_ID, TENANT_A, createDeviceKeys } from './support/harness';

const MESSAGES_ROUTE = 'POST /byok/messages';

/** Far above every route's own ceiling (the largest is a few MiB), far below what an unbounded read pulls. */
const PULL_ALLOWANCE_BYTES = 8 * 1024 * 1024;
const OVERSIZED_TOTAL_BYTES = 48 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

/** Mounts the truth routes; every request in this file is refused before it reaches truth. */
const UNREACHED_TRUTH: TruthCommitter & TruthObjectDownloads = {
  commit: () => Promise.reject(new Error('truth unreached')),
  getRecord: () => Promise.reject(new Error('truth unreached')),
  listManifest: () => Promise.reject(new Error('truth unreached')),
  getDownloadUrl: () => Promise.reject(new Error('truth unreached')),
};

interface PairedDevice {
  readonly deviceId: string;
  readonly authorization: { readonly authorization: string };
}

interface FullHarness {
  readonly cloud: ByokCloud;
  readonly stores: CloudStores;
  request(path: string, init?: RequestInit): Promise<Response>;
  pairDevice(tenant: TenantId): Promise<PairedDevice>;
}

/**
 * Every port in `CAPABILITY_PORTS` is supplied — `Required<CapabilityPorts>`
 * stops this file compiling when a new port-bound capability is added — and
 * the declaration is derived from those ports, so every optional route mounts.
 */
function createFullHarness(): FullHarness {
  const base = createInMemoryByokCloud({ longPollHoldMs: 20, mailboxWake: createInProcessMailboxWake({ fallbackMs: 5 }) });
  const ports: Required<CapabilityPorts> = {
    blobContentProxy: base.blobContentProxy,
    truthCommitter: UNREACHED_TRUTH,
    truthObjectDownloads: UNREACHED_TRUTH,
    skillPacks: new InMemorySkillPackStore(),
    agentMemoryProjectionAuthorizer: new InMemoryAgentMemoryProjectionAuthorizer(),
    agentMemoryProjectionStore: new InMemoryAgentMemoryProjectionStore(base.clock, base.crypto),
    e2eeMemberStore: new InMemoryE2eeMemberStore(base.stores.receipts),
  };
  const cloud = createByokCloud({
    core: base.core,
    cloud: base.stores,
    mailboxWake: base.mailboxWake,
    crypto: base.crypto,
    tokenSigner: createHmacTokenSigner(globalThis.crypto.getRandomValues(new Uint8Array(32)), base.clock),
    clock: base.clock,
    longPollHoldMs: 20,
    capabilities: capabilityDeclarationForPorts(ports),
    ...ports,
  });
  const request = (path: string, init: RequestInit = {}): Promise<Response> =>
    Promise.resolve(cloud.fetch(new Request(`${CLOUD_ORIGIN}${path}`, init)));
  return {
    cloud,
    stores: base.stores,
    request,
    async pairDevice(tenant) {
      if ((await base.core.quota.readEntitlement(tenant)) === undefined) {
        await base.core.quota.writeEntitlement(tenant, {
          version: 1n, hardLimitBytes: 1_000_000_000n, maxObjectBytes: 100_000_000n,
          maxInlineBytes: 1_000_000n, mailboxLimitBytes: 100_000_000n, retentionPolicyId: 'test',
        });
      }
      const keys = createDeviceKeys();
      const pairing = await cloud.createPairingCode(tenant, { productId: PRODUCT_ID });
      const response = await request('/byok/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingCode: pairing.code, deviceName: 'drift-device', devicePublicKey: keys.publicKeyBase64Url }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as PairResponse;
      return { deviceId: body.deviceId, authorization: { authorization: `Bearer ${body.accessToken}` } };
    },
  };
}

function concretePath(route: string): string {
  return route.replace(/:(\w+)/gu, (_, name: string) => `${name}-1`);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function createBlob(harness: FullHarness, device: PairedDevice, bytes: Uint8Array, key: string): Promise<CreateBlobResponse> {
  const created = await harness.request('/byok/blobs', {
    method: 'POST',
    headers: { ...device.authorization, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ size: bytes.length, contentType: 'application/octet-stream', contentHash: sha256(bytes) }),
  });
  expect(created.status).toBe(200);
  return (await created.json()) as CreateBlobResponse;
}

/** A lazily produced body with no Content-Length; reports how many bytes the server pulled. */
function oversizedStream(): { readonly body: ReadableStream<Uint8Array>; pulled(): number } {
  let pulled = 0;
  const chunk = new Uint8Array(CHUNK_BYTES).fill(0x20);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= OVERSIZED_TOTAL_BYTES) {
        controller.close();
        return;
      }
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  return { body, pulled: () => pulled };
}

describe('device route rate admission (#1118)', () => {
  it('every device route spends one admission, POST /byok/messages its whole batch, and answers 429 + Retry-After', async () => {
    const harness = createFullHarness();
    const device = await harness.pairDevice(TENANT_A);
    const debits: string[] = [];
    const deny: InboundRateLimiter = {
      async consume(_tenant, deviceId, unit, count) {
        expect(deviceId).toBe(device.deviceId);
        debits.push(`${unit}:${count}`);
        return { allowed: false, retryAfterMs: 1_500 };
      },
    };
    Object.assign(harness.stores, { rateLimiter: deny });

    const deviceRoutes = harness.cloud.routes.filter((route) => route.class === 'device');
    expect(deviceRoutes.map(routeKey)).toContain(MESSAGES_ROUTE);
    for (const route of deviceRoutes) {
      debits.length = 0;
      const key = routeKey(route);
      const isMessages = key === MESSAGES_ROUTE;
      // A wrong-direction type costs the same as any other envelope.
      const body = isMessages
        ? JSON.stringify({ messages: [
          createEnvelope('task.started', {}, { taskId: 'task-1' }),
          createEnvelope('task.cancel', {}, { taskId: 'task-1', seq: 1 }),
          createEnvelope('task.started', {}, { taskId: 'task-2' }),
        ] })
        : route.method === 'GET' ? undefined : '{}';
      const response = await harness.request(concretePath(route.path), {
        method: route.method,
        headers: { ...device.authorization, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status, key).toBe(429);
      expect(response.headers.get('retry-after'), key).toBe('2');
      expect(await response.json(), key).toEqual({ error: 'rate limit exceeded' });
      expect(debits, key).toEqual([isMessages ? 'envelope:3' : 'request:1']);
    }
  });

  it('a refused message batch applies none of its envelopes', async () => {
    const harness = createFullHarness();
    const device = await harness.pairDevice(TENANT_A);
    let allowed = false;
    Object.assign(harness.stores, {
      rateLimiter: { async consume() { return allowed ? { allowed: true } : { allowed: false, retryAfterMs: 1_000 }; } } satisfies InboundRateLimiter,
    });
    const hello: Envelope = createEnvelope('conn.hello', {
      deviceId: device.deviceId, productId: PRODUCT_ID, clientVersion: '0.0.0-test',
      protocolVersions: [PROTOCOL_VERSION], runtimes: [], capabilities: [],
    });
    const send = () => harness.request('/byok/messages', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [hello] }),
    });

    expect((await send()).status).toBe(429);
    allowed = true;
    const resent = await send();
    expect(resent.status).toBe(200);
    // `accepted`, not `duplicate`: the refused attempt left nothing behind.
    expect(((await resent.json()) as MessagesSendResponse).outcomes).toEqual([{ id: hello.id, outcome: 'accepted' }]);
  });

  it('an unauthenticated device request spends nothing', async () => {
    const harness = createFullHarness();
    const debits: RateLimitUnit[] = [];
    Object.assign(harness.stores, {
      rateLimiter: { async consume(_t: unknown, _d: unknown, unit: RateLimitUnit) { debits.push(unit); return { allowed: true }; } } satisfies InboundRateLimiter,
    });
    const response = await harness.request('/byok/events');
    expect(response.status).toBe(401);
    expect(debits).toEqual([]);
  });
});

describe('full-capability inventory (#1118)', () => {
  it('declares every port-bound capability, so every optional route is mounted', async () => {
    const harness = createFullHarness();
    const response = await harness.request('/byok/capabilities');
    const declaration = (await response.json()) as { capabilities: string[] };
    for (const capability of Object.keys(CAPABILITY_PORTS)) {
      expect(declaration.capabilities, capability).toContain(capability);
    }
  });
});

describe('Host request bodies are bounded (#1118)', () => {
  it('no route pulls an oversized streamed body past its own ceiling', async () => {
    const harness = createFullHarness();
    const device = await harness.pairDevice(TENANT_A);
    // The presigned route verifies its signature before the body, so it needs a real grant.
    const grant = await createBlob(harness, device, new Uint8Array(16), 'drift-blob');

    const bodyRoutes = harness.cloud.routes.filter((route) => route.method !== 'GET');
    // Every isolation class that takes a body is in the walk, including the
    // optional proof routes (truth records, E2EE member writes).
    expect(new Set(bodyRoutes.map((route) => route.class))).toEqual(new Set(['public', 'device', 'proof', 'presigned']));
    for (const route of bodyRoutes) {
      const key = routeKey(route);
      const target = route.class === 'presigned' ? grant.uploadUrl : concretePath(route.path);
      const stream = oversizedStream();
      const response = await harness.cloud.fetch(new Request(`${CLOUD_ORIGIN}${target}`, {
        method: route.method,
        headers: { ...(route.class === 'device' ? device.authorization : {}), 'content-type': 'application/json' },
        body: stream.body,
        duplex: 'half',
      } as RequestInit));
      expect(response.status, key).toBeGreaterThanOrEqual(400);
      expect(stream.pulled(), key).toBeLessThanOrEqual(PULL_ALLOWANCE_BYTES);
    }
  });

  it('answers 413 for an over-limit body on every formerly unbounded JSON device route', async () => {
    const harness = createFullHarness();
    const device = await harness.pairDevice(TENANT_A);
    const routes = [
      ['PUT', '/byok/presence'],
      ['POST', '/byok/activity'],
      ['POST', '/byok/board/item-1/claim'],
      ['POST', '/byok/board/item-1/status'],
      ['POST', '/byok/blobs'],
      ['PUT', '/byok/agent-home-projections/request-1/completion'],
      ['PUT', '/byok/input-preparations/request-1/completion'],
    ] as const;
    for (const [method, target] of routes) {
      const stream = oversizedStream();
      const response = await harness.cloud.fetch(new Request(`${CLOUD_ORIGIN}${target}`, {
        method,
        headers: { ...device.authorization, 'content-type': 'application/json', 'idempotency-key': 'k' },
        body: stream.body,
        duplex: 'half',
      } as RequestInit));
      expect(response.status, target).toBe(413);
      expect(await response.json(), target).toEqual({ error: 'request body too large' });
    }
  });
});

describe('presigned upload claims (#1118)', () => {
  async function slowUpload(harness: FullHarness, uploadUrl: string, bytes: Uint8Array, end: Promise<'close' | 'abort'>) {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(bytes.subarray(0, 4));
        if ((await end) === 'abort') controller.error(new Error('client disconnected'));
        else {
          controller.enqueue(bytes.subarray(4));
          controller.close();
        }
      },
    });
    return Promise.resolve(harness.cloud.fetch(new Request(`${CLOUD_ORIGIN}${uploadUrl}`, {
      method: 'PUT', body, duplex: 'half',
    } as RequestInit))).catch(() => undefined);
  }

  it('holds at most one in-flight upload per blob and releases it on success', async () => {
    const harness = createFullHarness();
    const device = await harness.pairDevice(TENANT_A);
    const bytes = new TextEncoder().encode('one upload at a time');
    const grant = await createBlob(harness, device, bytes, 'claim-success');

    let finish!: (how: 'close' | 'abort') => void;
    const first = slowUpload(harness, grant.uploadUrl, bytes, new Promise((resolve) => { finish = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await harness.request(grant.uploadUrl, { method: 'PUT', body: bytes });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ error: 'upload_in_progress' });

    finish('close');
    expect((await first)?.status).toBe(204);
    const again = await harness.request(grant.uploadUrl, { method: 'PUT', body: bytes });
    expect(again.status).not.toBe(409);
  });

  it('releases the claim when the uploading client disconnects', async () => {
    const harness = createFullHarness();
    const device = await harness.pairDevice(TENANT_A);
    const bytes = new TextEncoder().encode('aborted then retried');
    const grant = await createBlob(harness, device, bytes, 'claim-abort');

    let finish!: (how: 'close' | 'abort') => void;
    const aborted = slowUpload(harness, grant.uploadUrl, bytes, new Promise((resolve) => { finish = resolve; }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await harness.request(grant.uploadUrl, { method: 'PUT', body: bytes })).status).toBe(409);

    finish('abort');
    expect((await aborted)?.status ?? 500).toBeGreaterThanOrEqual(400);
    expect((await harness.request(grant.uploadUrl, { method: 'PUT', body: bytes })).status).toBe(204);
  });

  it.each([
    ['after its first bytes', 4],
    ['before any byte', 0],
  ] as const)('releases the claim when the request is aborted while its body is pending (%s)', async (_label, sent) => {
    const harness = createFullHarness();
    const device = await harness.pairDevice(TENANT_A);
    const bytes = new TextEncoder().encode('aborted by its signal');
    const grant = await createBlob(harness, device, bytes, `claim-signal-abort-${sent}`);

    // A peer that goes silent: the body never errors or closes on its own,
    // only the request's signal ends it.
    const silent = new ReadableStream<Uint8Array>({
      start(controller) { if (sent > 0) controller.enqueue(bytes.subarray(0, sent)); },
    }, { highWaterMark: 0 });
    const controller = new AbortController();
    const pending = Promise.resolve(harness.cloud.fetch(new Request(`${CLOUD_ORIGIN}${grant.uploadUrl}`, {
      method: 'PUT', body: silent, duplex: 'half', signal: controller.signal,
    } as RequestInit))).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await harness.request(grant.uploadUrl, { method: 'PUT', body: bytes })).status).toBe(409);

    controller.abort();
    // Let the aborted request unwind, then retry; never wait on the aborted
    // response itself, which a stuck read would never produce.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await harness.request(grant.uploadUrl, { method: 'PUT', body: bytes })).status).toBe(204);
    expect((await pending)?.status ?? 400).toBeGreaterThanOrEqual(400);
  });

  it('releases the claim of a request that was aborted before the handler read it', async () => {
    const harness = createFullHarness();
    const device = await harness.pairDevice(TENANT_A);
    const bytes = new TextEncoder().encode('already aborted');
    const grant = await createBlob(harness, device, bytes, 'claim-pre-aborted');

    const controller = new AbortController();
    controller.abort();
    const aborted = await Promise.resolve(harness.cloud.fetch(new Request(`${CLOUD_ORIGIN}${grant.uploadUrl}`, {
      method: 'PUT', body: new ReadableStream<Uint8Array>(), duplex: 'half', signal: controller.signal,
    } as RequestInit))).catch(() => undefined);
    expect(aborted?.status ?? 400).toBeGreaterThanOrEqual(400);
    expect((await harness.request(grant.uploadUrl, { method: 'PUT', body: bytes })).status).toBe(204);
  });
});
