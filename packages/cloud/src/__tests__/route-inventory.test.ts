/**
 * I1: the route inventory, closed in both directions, plus tenant B driven
 * against every one of tenant A's resources.
 *
 * The claim this file has to make falsifiable is *structural*, not
 * enumerative: it is not "these ten routes are isolated", it is "a route that
 * exists at all is in this table". So the comparison runs against Hono's own
 * mounted-route list rather than against a hand-written list of paths — an
 * eleventh route added tomorrow either goes through the registry (and appears
 * in the inventory) or fails this suite.
 */
import { createInMemoryCoreStores, createMutableClock, type CapabilityDeclaration } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { createHmacTokenSigner } from '../auth/tokens';
import { CLOUD_CAPABILITIES, fullCapabilityDeclaration, type CloudCapability } from '../capabilities';
import { createByokCloud } from '../cloud';
import { createWebCrypto } from '../crypto/web-crypto';
import { CloudRouteRegistry, ROUTE_CLASSES, routeKey, type RouteClass } from '../router/registry';
import { createInMemoryCloudStores } from '../stores/in-memory/index';
import { CLOUD_ORIGIN, createHarness, offerPayload, TENANT_A, TENANT_B, type CloudHarness, type PairedDevice } from './support/harness';

/** The inventory as of S3a. Kept here so a route ADDED without a decision fails a review, not just a diff. */
const EXPECTED_INVENTORY: Record<string, RouteClass> = {
  'POST /byok/pair': 'public',
  'POST /byok/challenge': 'public',
  'POST /byok/token': 'public',
  'GET /byok/capabilities': 'public',
  'GET /byok/events': 'device',
  'POST /byok/messages': 'device',
  'GET /byok/board': 'device',
  'POST /byok/board/:id/claim': 'device',
  'POST /byok/board/:id/unclaim': 'device',
  'POST /byok/board/:id/status': 'device',
  'GET /byok/board/stream': 'device',
  'PUT /byok/presence': 'device',
  'POST /byok/activity': 'device',
  'POST /byok/blobs': 'device',
  'POST /byok/blobs/:id/finalize': 'device',
  'GET /byok/blobs/:id/url': 'device',
  'PUT /byok/blobs/:id/content': 'presigned',
  'GET /byok/blobs/:id/content': 'presigned',
};

describe('route inventory (I1)', () => {
  const harness = createHarness();

  it('every route the ROUTER holds is in the inventory', () => {
    const inventoried = new Set(harness.cloud.routes.map(routeKey));
    const mounted = mountedOf(harness);

    expect(mounted.length).toBeGreaterThan(0);
    for (const route of mounted) {
      expect(inventoried, `mounted but not inventoried: ${route}`).toContain(route);
    }
  });

  it('every inventoried route is one the ROUTER actually holds', () => {
    const mounted = new Set(mountedOf(harness));
    for (const route of harness.cloud.routes) {
      expect(mounted, `inventoried but not mounted: ${routeKey(route)}`).toContain(routeKey(route));
    }
    // Same count both ways: neither side may carry an extra.
    expect(mounted.size).toBe(harness.cloud.routes.length);
  });

  it('every route carries a known isolation class, and the set matches the reviewed inventory', () => {
    const actual = Object.fromEntries(harness.cloud.routes.map((route) => [routeKey(route), route.class]));
    for (const route of harness.cloud.routes) {
      expect(ROUTE_CLASSES, `unclassified route: ${routeKey(route)}`).toContain(route.class);
    }
    expect(actual).toEqual(EXPECTED_INVENTORY);
  });

  it('does not expose an approval route on the device surface', () => {
    // A device-bearer-authed approval route would let any validly paired
    // device approve any task in its tenant. The reference server refuses to
    // mount one; so does this.
    expect(harness.cloud.routes.some((route) => route.path.includes('approve'))).toBe(false);
    expect(harness.cloud.routes.some((route) => route.path.includes('reject'))).toBe(false);
  });

  /**
   * S3a gate, P2-3. `cloud.fetch` is documented as "the router" — mount it on
   * `@hono/node-server`, a Worker, or Deno and every route reachable is a
   * route the registry holds. That claim dies quietly the day someone wraps
   * it (a tenant resolver, an error mapper, a CORS shim, a "just for the
   * demo" auth bypass): the inventory tests above would still pass, because
   * they compare the registry against itself and never look at what the
   * exported handler actually does.
   *
   * The registry is module-private, so this is a BEHAVIOR guard rather than a
   * reference comparison — nothing is exported to make it possible. A bare
   * `CloudRouteRegistry` with no routes at all is the reference object: for a
   * path neither router holds, the mounted cloud must answer EXACTLY what the
   * bare router answers, headers included. Any wrapper worth adding changes
   * at least one of those bytes on the miss path.
   */
  it('exposes the registry router itself as `fetch`, not a wrapper around it', async () => {
    const bare = new CloudRouteRegistry();
    const miss = new Request(`${CLOUD_ORIGIN}/byok/not-a-route`);

    const throughCloud = await harness.cloud.fetch(miss.clone());
    const throughBareRouter = await bare.fetch(miss.clone());

    expect(throughCloud.status).toBe(throughBareRouter.status);
    expect(await throughCloud.text()).toBe(await throughBareRouter.text());
    expect([...throughCloud.headers].sort()).toEqual([...throughBareRouter.headers].sort());

    // The other direction: a path the registry DOES hold is answered by its
    // handler, so "everything 404s identically" is not how this passes.
    const hit = await harness.cloud.fetch(new Request(`${CLOUD_ORIGIN}/byok/capabilities`));
    expect(hit.status).toBe(200);
  });

  it('refuses to register an unclassified route, an unsupported method, or a duplicate', () => {
    const registry = new CloudRouteRegistry();
    const handler = () => new Response(null, { status: 204 });

    expect(() =>
      registry.register({ method: 'GET', path: '/x', class: 'admin' as RouteClass }, handler),
    ).toThrow(/isolation class/);
    expect(() =>
      registry.register({ method: 'DELETE' as 'GET', path: '/x', class: 'public' }, handler),
    ).toThrow(/unsupported method/);

    registry.register({ method: 'GET', path: '/x', class: 'public' }, handler);
    expect(() => registry.register({ method: 'GET', path: '/x', class: 'device' }, handler)).toThrow(
      /already registered/,
    );
    expect(registry.routes.map(routeKey)).toEqual(['GET /x']);
    expect(registry.mounted.map(routeKey)).toEqual(['GET /x']);
  });
});

describe('tenant isolation across every device-class resource', () => {
  it('gives tenant B nothing of tenant A, and leaves tenant A byte-identical', async () => {
    const harness = createHarness();
    const alice = await harness.pairDevice(TENANT_A);
    const mallory = await harness.pairDevice(TENANT_B);

    // Tenant A's fixtures: a queued offer and an uploaded blob.
    const offer = await harness.cloud.enqueueOffer(TENANT_A, alice.deviceId, { payload: offerPayload('secret work') });
    const blobId = await uploadBlob(harness, alice, 'tenant a bytes');
    const before = await snapshot(harness, alice, offer.taskId, blobId);

    // 1. The mailbox: B polls and sees its own (empty) mailbox, never A's.
    const events = await harness.json('/byok/events', { headers: mallory.authorization });
    expect(events.status).toBe(200);
    expect(events.body).toEqual({ events: [], cursor: 0, capabilities: ['result-document'] });
    expect(JSON.stringify(events.body)).not.toContain('secret work');

    // 2. Inbound: B claims A's task id. Accepted at the wire level (an unowned
    // task in B's own tenant is not a rejection) and yet nothing of A's moved,
    // and B's tenant gained no row for the id it guessed.
    const claimed = await harness.request('/byok/messages', {
      method: 'POST',
      headers: { ...mallory.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            v: 1,
            id: crypto.randomUUID(),
            ts: new Date().toISOString(),
            type: 'task.claim',
            task_id: offer.taskId,
            payload: { deviceId: mallory.deviceId },
          },
        ],
      }),
    });
    expect(claimed.status).toBe(200);
    expect(await harness.cloud.readTaskAttempt(TENANT_B, offer.taskId)).toBeUndefined();

    // 3. Blob url: A's blob is indistinguishable from a blob that never
    // existed.
    const foreignBlob = await harness.json(`/byok/blobs/${blobId}/url`, { headers: mallory.authorization });
    const missingBlob = await harness.json('/byok/blobs/blob_does-not-exist/url', {
      headers: mallory.authorization,
    });
    expect(foreignBlob).toEqual(missingBlob);
    expect(foreignBlob.status).toBe(404);

    // 4. B's own device row, and B's poll cursor, are all B got.
    expect(await harness.cloud.listDevices(TENANT_B)).toHaveLength(1);

    // 5. Tenant A is byte-identical to before B ever called.
    expect(await snapshot(harness, alice, offer.taskId, blobId)).toEqual(before);
  });

  it('refuses a device-class route to an unauthenticated caller uniformly', async () => {
    const harness = createHarness();
    const deviceRoutes = harness.cloud.routes.filter((route) => route.class === 'device');
    expect(deviceRoutes.length).toBeGreaterThan(0);

    for (const route of deviceRoutes) {
      const path = route.path.replace(':id', 'blob_whatever');
      const response = await harness.json(path, {
        method: route.method,
        ...(route.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{}' } : {}),
      });
      expect(response.status, routeKey(route)).toBe(401);
      expect(response.body, routeKey(route)).toEqual({ error: 'unauthorized' });
    }
  });
});

/**
 * The capability matrix, closed over the axis S4A-c added.
 *
 * `blobs.presigned` used to gate all four blob routes at once, which made a
 * composition that mints grants but cannot carry bytes inexpressible. Now the
 * grant pair and the `/content` pair have one capability each, and the
 * `/content` pair additionally needs a proxy to have been supplied — the
 * declaration says what a deployment serves, and the composition says what it
 * physically can serve, and BOTH have to agree before a route exists.
 *
 * Enumerated rather than spot-checked: the point of an inventory is that it is
 * exhaustive, so every CONSTRUCTIBLE combination on the new axis is a row here,
 * including the one that must produce no `/content` routes (a proxy supplied
 * but not declared).
 *
 * The opposite combination — declared but unsupplied — is not a row, because it
 * is not a deployment: `createByokCloud` refuses it, and the two assertions
 * below the matrix are what pin that. Leaving it as a "mounts nothing" row was
 * the bug: `GET /byok/capabilities` publishes the declaration whether or not a
 * route backs it, so "mounts nothing" described the router while the client was
 * still being told the capability was there.
 */
const ALWAYS_MOUNTED = [
  'POST /byok/pair',
  'POST /byok/challenge',
  'POST /byok/token',
  'GET /byok/capabilities',
] as const;

const GRANT_ROUTES = [
  'POST /byok/blobs',
  'POST /byok/blobs/:id/finalize',
  'GET /byok/blobs/:id/url',
] as const;
const CONTENT_ROUTES = ['PUT /byok/blobs/:id/content', 'GET /byok/blobs/:id/content'] as const;

function declaration(...capabilities: CloudCapability[]): CapabilityDeclaration {
  return { schema: 'byok-capabilities-v1', version: 1, capabilities };
}

/** A cloud built straight from the parts, so "no proxy supplied" is expressible. */
function cloudWith(options: { readonly capabilities: CapabilityDeclaration; readonly withProxy: boolean }) {
  const clock = createMutableClock();
  const crypto = createWebCrypto();
  const core = createInMemoryCoreStores({ clock }).stores;
  const composition = createInMemoryCloudStores(
    clock,
    crypto,
    core.objects,
    core.mailbox,
  );
  return createByokCloud({
    core,
    cloud: composition.stores,
    ...(options.withProxy ? { blobContentProxy: composition.blobContentProxy } : {}),
    crypto,
    tokenSigner: createHmacTokenSigner(globalThis.crypto.getRandomValues(new Uint8Array(32)), clock),
    clock,
    capabilities: options.capabilities,
  });
}

describe('capability x composition route matrix', () => {
  const rows: {
    readonly name: string;
    readonly capabilities: CapabilityDeclaration;
    readonly withProxy: boolean;
    readonly expected: readonly string[];
  }[] = [
    {
      name: 'no blob capability, no proxy',
      capabilities: declaration(),
      withProxy: false,
      expected: [],
    },
    {
      name: 'no blob capability, proxy supplied — a proxy is not a declaration',
      capabilities: declaration(),
      withProxy: true,
      expected: [],
    },
    {
      name: 'grants only, no proxy — the object-storage composition',
      capabilities: declaration(CLOUD_CAPABILITIES.blobsPresigned),
      withProxy: false,
      expected: GRANT_ROUTES,
    },
    {
      name: 'grants only, proxy supplied but undeclared',
      capabilities: declaration(CLOUD_CAPABILITIES.blobsPresigned),
      withProxy: true,
      expected: GRANT_ROUTES,
    },
    {
      name: 'content proxy declared and supplied, no grants',
      capabilities: declaration(CLOUD_CAPABILITIES.blobsContentProxy),
      withProxy: true,
      expected: CONTENT_ROUTES,
    },
    {
      name: 'both declared and supplied — the in-memory composition',
      capabilities: declaration(CLOUD_CAPABILITIES.blobsPresigned, CLOUD_CAPABILITIES.blobsContentProxy),
      withProxy: true,
      expected: [...GRANT_ROUTES, ...CONTENT_ROUTES],
    },
  ];

  for (const row of rows) {
    it(`mounts exactly the blob routes it can serve: ${row.name}`, () => {
      const cloud = cloudWith(row);
      const mounted = cloud.mountedRoutes.map(routeKey);

      expect(mounted.sort()).toEqual([...ALWAYS_MOUNTED, ...row.expected].sort());
      // Both directions, per row: the inventory and the router agree here too,
      // not just for the fully-declared harness above.
      expect(cloud.routes.map(routeKey).sort()).toEqual(mounted.sort());
    });
  }

  it('refuses to construct a deployment that declares a byte proxy it was not given', () => {
    // Fail closed at construction, both with and without the grant capability
    // beside it: the fault is the declaration out-running the parts, and it
    // does not become smaller when the deployment serves other routes well.
    for (const capabilities of [
      declaration(CLOUD_CAPABILITIES.blobsContentProxy),
      declaration(CLOUD_CAPABILITIES.blobsPresigned, CLOUD_CAPABILITIES.blobsContentProxy),
      fullCapabilityDeclaration(),
    ]) {
      expect(() => cloudWith({ capabilities, withProxy: false })).toThrowError(
        expect.objectContaining({ code: 'capability_over_declared' }),
      );
    }
  });

  it('refuses SSE without the polling/reconciliation capability it depends on', () => {
    expect(() =>
      cloudWith({ capabilities: declaration(CLOUD_CAPABILITIES.boardSse), withProxy: true }),
    ).toThrowError(expect.objectContaining({ code: 'capability_over_declared' }));
  });

  it('accepts a proxy that the declaration does not name, and mounts nothing for it', () => {
    // The other direction, and deliberately not symmetric. Declaring more than
    // the composition can serve tells a client something false; supplying more
    // than the declaration names tells it less than the whole truth, which is
    // what withholding a capability IS.
    const cloud = cloudWith({ capabilities: declaration(CLOUD_CAPABILITIES.blobsPresigned), withProxy: true });
    const mounted = new Set(cloud.mountedRoutes.map(routeKey));
    expect(CONTENT_ROUTES.some((route) => mounted.has(route))).toBe(false);
  });

  it('serves every route in the reviewed inventory when everything is declared and supplied', () => {
    // `fullCapabilityDeclaration()` is what a host gets by default, so it has
    // to name `blobs.contentproxy` — otherwise the split would have silently
    // dropped two routes from every existing deployment.
    expect(fullCapabilityDeclaration().capabilities).toContain(CLOUD_CAPABILITIES.blobsContentProxy);
    const cloud = cloudWith({ capabilities: fullCapabilityDeclaration(), withProxy: true });
    expect(cloud.mountedRoutes.map(routeKey).sort()).toEqual(Object.keys(EXPECTED_INVENTORY).sort());
  });

  it('never produces a third state: the /content pair is all-or-nothing', () => {
    for (const row of rows) {
      const mounted = new Set(cloudWith(row).mountedRoutes.map(routeKey));
      const present = CONTENT_ROUTES.filter((route) => mounted.has(route));
      expect(present.length === 0 || present.length === CONTENT_ROUTES.length, row.name).toBe(true);
    }
  });
});

function mountedOf(harness: CloudHarness): string[] {
  // NOT `cloud.routes` — that is the inventory, which is the thing under test.
  // This is the router's own table, so the two can genuinely disagree.
  return harness.cloud.mountedRoutes.map(routeKey);
}

async function uploadBlob(harness: CloudHarness, device: PairedDevice, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const reservationId = `inventory-${hex}`;
  const created = await harness.request('/byok/blobs', {
    method: 'POST',
    headers: {
      ...device.authorization,
      'content-type': 'application/json',
      'idempotency-key': reservationId,
    },
    body: JSON.stringify({ size: bytes.length, contentType: 'text/plain', contentHash: `sha256:${hex}` }),
  });
  const { blobId, uploadUrl } = (await created.json()) as { blobId: string; uploadUrl: string };
  await harness.request(uploadUrl, { method: 'PUT', body: bytes });
  await harness.request(`/byok/blobs/${blobId}/finalize`, {
    method: 'POST',
    headers: { ...device.authorization, 'idempotency-key': reservationId },
  });
  return blobId;
}

async function snapshot(
  harness: CloudHarness,
  device: PairedDevice,
  taskId: string,
  blobId: string,
): Promise<unknown> {
  const events = await harness.json('/byok/events?cursor=0', { headers: device.authorization });
  const blobUrl = await harness.json(`/byok/blobs/${blobId}/url`, { headers: device.authorization });
  return {
    events: events.body,
    blobReachable: blobUrl.status,
    attempt: await harness.cloud.readTaskAttempt(TENANT_A, taskId),
    receipt: await harness.cloud.readTerminalReceipt(TENANT_A, taskId),
    cursor: await harness.core.mailbox.readCursor(TENANT_A, device.deviceId),
  };
}
