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
import { describe, expect, it } from 'vitest';
import { CloudRouteRegistry, ROUTE_CLASSES, routeKey, type RouteClass } from '../router/registry';
import { createHarness, offerPayload, TENANT_A, TENANT_B, type CloudHarness, type PairedDevice } from './support/harness';

/** The inventory as of S3a. Kept here so a route ADDED without a decision fails a review, not just a diff. */
const EXPECTED_INVENTORY: Record<string, RouteClass> = {
  'POST /byok/pair': 'public',
  'POST /byok/challenge': 'public',
  'POST /byok/token': 'public',
  'GET /byok/capabilities': 'public',
  'GET /byok/events': 'device',
  'POST /byok/messages': 'device',
  'POST /byok/blobs': 'device',
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
    expect(events.body).toEqual({ events: [], cursor: 0 });
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

function mountedOf(harness: CloudHarness): string[] {
  // NOT `cloud.routes` — that is the inventory, which is the thing under test.
  // This is the router's own table, so the two can genuinely disagree.
  return harness.cloud.mountedRoutes.map(routeKey);
}

async function uploadBlob(harness: CloudHarness, device: PairedDevice, text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const created = await harness.request('/byok/blobs', {
    method: 'POST',
    headers: { ...device.authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ size: bytes.length, contentType: 'text/plain', contentHash: `sha256:${hex}` }),
  });
  const { blobId, uploadUrl } = (await created.json()) as { blobId: string; uploadUrl: string };
  await harness.request(uploadUrl, { method: 'PUT', body: bytes });
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
