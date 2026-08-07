/**
 * The device surface at the HTTP level: what a daemon actually sends and what
 * it gets back. Response SHAPES are as much a part of the frozen contract as
 * the envelopes — `{ accepted }` without a `rejected` key, a 429 for the whole
 * batch, a relative presigned URL — so they are asserted against the protocol
 * package's own schemas rather than by eye.
 */
import { createMutableClock } from '@byok/core';
import {
  MAX_MESSAGES_PER_BATCH,
  MessagesSendResponseSchema,
  createEnvelope,
  type CreateBlobResponse,
  type Envelope,
} from '@byok/protocol';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fullCapabilityDeclaration } from '../capabilities';
import { BLOB_URL_TTL_MS } from '../stores/in-memory/blobs';
import type { InboundRateLimiter } from '../stores/ports';
import { TENANT_A, TENANT_B, createHarness, offerPayload } from './support/harness';

function send(
  harness: ReturnType<typeof createHarness>,
  authorization: { authorization: string },
  messages: unknown,
): Promise<Response> {
  return harness.request('/byok/messages', {
    method: 'POST',
    headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ messages }),
  });
}

function sha256(data: Uint8Array): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

describe('POST /byok/messages', () => {
  it('counts accepted envelopes and omits `rejected` entirely when nothing was rejected', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload() });

    const response = await send(harness, device.authorization, [
      createEnvelope('task.claim', { deviceId: device.deviceId }, { taskId }),
      createEnvelope('task.started', {}, { taskId }),
    ]);

    expect(response.status).toBe(200);
    const body = MessagesSendResponseSchema.parse(await response.json());
    expect(body).toEqual({ accepted: 2 });
  });

  it('counts a duplicate as accepted and a gate rejection separately', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    const claim = createEnvelope('task.claim', { deviceId: device.deviceId }, { taskId });

    await send(harness, device.authorization, [claim]);
    const response = await send(harness, device.authorization, [
      claim,
      createEnvelope('task.cancel', {}, { taskId, seq: 1 }),
    ]);

    const body = MessagesSendResponseSchema.parse(await response.json());
    expect(body).toEqual({ accepted: 1, rejected: 1 });
  });

  it('answers the WHOLE request 429 the moment one envelope is rate limited', async () => {
    let budget = 1;
    const limiter: InboundRateLimiter = {
      async consume() {
        budget -= 1;
        return budget >= 0;
      },
    };
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    // Swap the limiter on the store bundle the running cloud reads.
    Object.assign(harness.stores, { rateLimiter: limiter });

    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    const response = await send(harness, device.authorization, [
      createEnvelope('task.claim', { deviceId: device.deviceId }, { taskId }),
      createEnvelope('task.started', {}, { taskId }),
    ]);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: 'rate limit exceeded' });
    // The envelope processed before the limit hit still took effect — there
    // are no rollback semantics, and every task.* type is idempotent.
    expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.ownerDeviceId).toBe(device.deviceId);
  });

  it('400s a structurally invalid batch and an oversized one', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);

    expect((await send(harness, device.authorization, 'not-an-array')).status).toBe(400);
    expect((await send(harness, device.authorization, [{ nonsense: true }])).status).toBe(400);

    const oversized: Envelope[] = Array.from({ length: MAX_MESSAGES_PER_BATCH + 1 }, () =>
      createEnvelope('task.started', {}, { taskId: 'task-1' }),
    );
    expect((await send(harness, device.authorization, oversized)).status).toBe(400);
  });

  it('accepts a full-sized batch', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const batch: Envelope[] = Array.from({ length: MAX_MESSAGES_PER_BATCH }, () =>
      createEnvelope('task.progress', { seq: 1, events: [] }, { taskId: 'task-1' }),
    );

    const response = await send(harness, device.authorization, batch);
    expect(response.status).toBe(200);
    expect(MessagesSendResponseSchema.parse(await response.json())).toEqual({ accepted: MAX_MESSAGES_PER_BATCH });
  });

  it('401s without a bearer token', async () => {
    const harness = createHarness();
    const response = await harness.request('/byok/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    expect(response.status).toBe(401);
  });
});

describe('blob flows (§7)', () => {
  it('round-trips declare -> presigned PUT -> url -> presigned GET', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const bytes = new TextEncoder().encode('hello blob');

    const created = await harness.request('/byok/blobs', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ size: bytes.length, contentType: 'text/plain', contentHash: sha256(bytes) }),
    });
    expect(created.status).toBe(200);
    const { blobId, uploadUrl } = (await created.json()) as CreateBlobResponse;
    expect(uploadUrl.startsWith(`/byok/blobs/${blobId}/content?sig=`)).toBe(true);

    const uploaded = await harness.request(uploadUrl, { method: 'PUT', body: bytes });
    expect(uploaded.status).toBe(204);

    const urlResponse = await harness.request(`/byok/blobs/${blobId}/url`, { headers: device.authorization });
    expect(urlResponse.status).toBe(200);
    const { downloadUrl } = (await urlResponse.json()) as { downloadUrl: string };

    const content = await harness.request(downloadUrl);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe('hello blob');
  });

  it('refuses a tampered signature, an expired one, and a wrong-action one', async () => {
    const clock = createMutableClock();
    const harness = createHarness({ clock });
    const device = await harness.pairDevice(TENANT_A);
    const bytes = new TextEncoder().encode('x');

    const created = await harness.request('/byok/blobs', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ size: bytes.length, contentType: 'text/plain', contentHash: sha256(bytes) }),
    });
    const { uploadUrl } = (await created.json()) as CreateBlobResponse;

    const tampered = uploadUrl.replace('sig=', 'sig=A');
    expect((await harness.request(tampered, { method: 'PUT', body: bytes })).status).toBe(401);

    // A PUT signature is not a GET signature: the same URL, read instead of
    // written, does not verify.
    expect((await harness.request(uploadUrl)).status).toBe(401);

    clock.advance(BLOB_URL_TTL_MS + 1);
    expect((await harness.request(uploadUrl, { method: 'PUT', body: bytes })).status).toBe(401);
  });

  it('rejects a payload that does not match its declaration', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const declared = new TextEncoder().encode('declared');

    const created = await harness.request('/byok/blobs', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ size: declared.length, contentType: 'text/plain', contentHash: sha256(declared) }),
    });
    const { uploadUrl } = (await created.json()) as CreateBlobResponse;

    const wrong = await harness.request(uploadUrl, {
      method: 'PUT',
      body: new TextEncoder().encode('different'),
    });
    expect(wrong.status).toBe(422);
  });

  it('413s a declaration over the deployment ceiling', async () => {
    const harness = createHarness({ maxBlobSizeBytes: 8 });
    const device = await harness.pairDevice(TENANT_A);

    const response = await harness.json('/byok/blobs', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ size: 9, contentType: 'text/plain', contentHash: sha256(new Uint8Array(9)) }),
    });
    expect(response.status).toBe(413);
  });

  it('400s a non-canonical contentHash instead of normalizing it', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);

    const response = await harness.json('/byok/blobs', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ size: 1, contentType: 'text/plain', contentHash: 'SHA256:ABCDEF' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('GET /byok/capabilities', () => {
  it('serves the declaration this deployment was configured with', async () => {
    const harness = createHarness();
    const response = await harness.json('/byok/capabilities');

    expect(response.status).toBe(200);
    expect(response.body).toEqual(fullCapabilityDeclaration());
  });

  it('is public — a client must be able to read it before it holds a credential', async () => {
    const harness = createHarness();
    const anonymous = await harness.request('/byok/capabilities');
    expect(anonymous.status).toBe(200);
  });

  it('carries nothing tenant-scoped', async () => {
    const harness = createHarness();
    await harness.pairDevice(TENANT_A);
    await harness.pairDevice(TENANT_B);

    const body = JSON.stringify((await harness.json('/byok/capabilities')).body);
    expect(body).not.toContain(TENANT_A);
    expect(body).not.toContain(TENANT_B);
  });

  it('selects the surface: an undeclared capability means the route is not mounted at all', async () => {
    const narrow = createHarness({
      capabilities: { schema: 'byok-capabilities-v1', version: 3, capabilities: ['events.longpoll'] },
    });

    const paths = narrow.cloud.routes.map((route) => `${route.method} ${route.path}`);
    expect(paths).toContain('GET /byok/events');
    expect(paths).not.toContain('POST /byok/messages');
    expect(paths.some((path) => path.includes('/byok/blobs'))).toBe(false);

    // And the declaration itself is what says so — no status-code probing.
    const declaration = (await narrow.json('/byok/capabilities')).body as { capabilities: string[] };
    expect(declaration.capabilities).toEqual(['events.longpoll']);
  });
});
