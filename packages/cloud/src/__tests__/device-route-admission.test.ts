/**
 * #1118: every Host route is bounded and every device route is rate-admitted.
 *
 * Both checks walk the router's own inventory (`cloud.routes`), so a route
 * added tomorrow is covered without editing this file: it either reads its
 * body under a ceiling and admits through the device budget, or this suite
 * fails.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnvelope, type CreateBlobResponse } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { routeKey } from '../router/registry';
import type { InboundRateLimiter, RateLimitUnit } from '../stores/ports';
import { CLOUD_ORIGIN, TENANT_A, createHarness, type CloudHarness, type PairedDevice } from './support/harness';

const MESSAGES_ROUTE = 'POST /byok/messages';

/** Far above every route's own ceiling (the largest is a few MiB), far below what an unbounded read pulls. */
const PULL_ALLOWANCE_BYTES = 8 * 1024 * 1024;
const OVERSIZED_TOTAL_BYTES = 48 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

function concretePath(route: string): string {
  return route.replace(/:(\w+)/gu, (_, name: string) => `${name}-1`);
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function createBlob(harness: CloudHarness, device: PairedDevice, bytes: Uint8Array, key: string): Promise<CreateBlobResponse> {
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
  it('every device route except POST /byok/messages spends exactly one request unit and answers 429 + Retry-After', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const debits: RateLimitUnit[] = [];
    const deny: InboundRateLimiter = {
      async consume(_tenant, deviceId, unit) {
        expect(deviceId).toBe(device.deviceId);
        debits.push(unit);
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
      const body = isMessages
        ? JSON.stringify({ messages: [createEnvelope('task.started', {}, { taskId: 'task-1' })] })
        : route.method === 'GET' ? undefined : '{}';
      const response = await harness.request(concretePath(route.path), {
        method: route.method,
        headers: { ...device.authorization, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body }),
      });
      expect(response.status, key).toBe(429);
      expect(response.headers.get('retry-after'), key).toBe('2');
      expect(await response.json(), key).toEqual({ error: 'rate limit exceeded' });
      expect(debits, key).toEqual([isMessages ? 'envelope' : 'request']);
    }
  });

  it('an unauthenticated device request spends nothing', async () => {
    const harness = createHarness();
    const debits: RateLimitUnit[] = [];
    Object.assign(harness.stores, {
      rateLimiter: { async consume(_t: unknown, _d: unknown, unit: RateLimitUnit) { debits.push(unit); return { allowed: true }; } },
    });
    const response = await harness.request('/byok/events');
    expect(response.status).toBe(401);
    expect(debits).toEqual([]);
  });
});

describe('Host request bodies are bounded (#1118)', () => {
  it('no route pulls an oversized streamed body past its own ceiling', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    // The presigned route verifies its signature before the body, so it needs a real grant.
    const grant = await createBlob(harness, device, new Uint8Array(16), 'drift-blob');

    const bodyRoutes = harness.cloud.routes.filter((route) => route.method !== 'GET');
    expect(bodyRoutes.length).toBeGreaterThan(0);
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
    const harness = createHarness();
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

  it('no handler source reads a request body without a ceiling', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const unbounded = /\.req\.(json|text|arrayBuffer|blob|formData|parseBody)\(/u;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name !== '__tests__') walk(full);
        } else if (name.endsWith('.ts') && unbounded.test(readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});

describe('presigned upload claims (#1118)', () => {
  async function slowUpload(harness: CloudHarness, uploadUrl: string, bytes: Uint8Array, end: Promise<'close' | 'abort'>) {
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
    const harness = createHarness();
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
    const harness = createHarness();
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

  it('releases the claim when the request is aborted while its body is pending', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const bytes = new TextEncoder().encode('aborted by its signal');
    const grant = await createBlob(harness, device, bytes, 'claim-signal-abort');

    // A peer that sends a few bytes and then goes silent: the body never
    // errors or closes on its own, only the request's signal ends it.
    const silent = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.subarray(0, 4)); },
    });
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
});
