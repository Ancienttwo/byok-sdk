/**
 * Wire v7 removed the server capability advertisement (#1757 B2). No answer a
 * daemon reads carries `capabilities`: not the empty or the delivered poll
 * page, and not the handshake answer, which still carries `ingress`.
 */
import { createEnvelope, PROTOCOL_VERSION } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { TENANT_A, createHarness, grantAgentHome, offerPayload } from './support/harness';

describe('no server capability advertisement', () => {
  it('omits capabilities on the empty and the delivered poll page', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const empty = await harness.json('/byok/events?cursor=0', { headers: device.authorization });
    expect(empty.status).toBe(200);
    expect(Object.hasOwn(empty.body as object, 'capabilities')).toBe(false);

    await grantAgentHome(harness, TENANT_A, device.deviceId);
    await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    const delivered = await harness.json('/byok/events?cursor=0', { headers: device.authorization });
    expect((delivered.body as { events: unknown[] }).events).toHaveLength(1);
    expect(Object.hasOwn(delivered.body as object, 'capabilities')).toBe(false);
  });

  it('answers an accepted conn.hello with ingress and no capabilities', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const hello = createEnvelope('conn.hello', {
      protocolVersions: [PROTOCOL_VERSION],
      harnesses: [{ id: 'pi', capabilities: { selectionModes: ['device-default', 'byok-profile'], effort: true } }, { id: 'claude', capabilities: { selectionModes: ['device-default', 'subscription'], effort: true } }, { id: 'codex', capabilities: { selectionModes: ['device-default', 'subscription'], effort: true } }],
      capabilities: [],
      deviceId: device.deviceId,
      productId: 'test-product',
    });

    const handshake = await harness.json('/byok/messages', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [hello] }),
    });
    expect(handshake.status).toBe(200);
    expect(handshake.body).toMatchObject({ accepted: 1, ingress: expect.any(Object) });
    expect(Object.hasOwn(handshake.body as object, 'capabilities')).toBe(false);
  });
});
