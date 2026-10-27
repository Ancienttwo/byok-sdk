import { createEnvelope, PROTOCOL_VERSION, type Envelope, type EventsPollResponse } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { AgentExecutionInputSchema } from '../agent-execution';
import { handleInboundEnvelope, type ByokCloudObserver, type InboundRefused } from '../inbound';
import { tenantStoresFor } from '../tenant-stores';
import { createHarness, grantAgentHome, offerPayload, TENANT_A, TEST_AGENT_REF } from './support/harness';

function storesFor(harness: ReturnType<typeof createHarness>, deviceId: string) {
  return tenantStoresFor(
    { kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId },
    { core: harness.core, cloud: harness.stores, mailboxWake: harness.mailboxWake },
  );
}

function refusalRecorder(): { readonly refused: InboundRefused[]; readonly observer: ByokCloudObserver } {
  const refused: InboundRefused[] = [];
  return { refused, observer: { onInboundCommitted() {}, onInboundRefused(input) { refused.push(input); } } };
}

/** A result-document Agent execution with a subset-valid frozen schema and no message egress. */
function resultDocumentExecution(deviceId: string) {
  return AgentExecutionInputSchema.parse({
    taskId: 'v2-daemon-execution',
    deviceId,
    payload: {
      instruction: 'produce a structured result',
      runtime: 'codex',
      agentRef: { agentId: 'agent', profileRevision: 'revision' },
      session: { mode: 'fresh' },
      egressPolicy: { policyRevision: 'policy', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
        reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
        transfers: { workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] }, transcript: 'disabled', artifact: 'disabled' } },
      terminalProjection: { mode: 'result-document', contract: 'test.result.v1',
        schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } },
    },
  });
}

describe('protocol-version admission at cloud lifecycle boundaries', () => {
  it('is wire v4', () => {
    expect(PROTOCOL_VERSION).toBe(4);
  });

  it.each([1, 2, 3])('rejects the retired v:%i at the exported inbound gate before the claim lifecycle mutation', async (v) => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    const offer = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    const retiredClaim = { ...createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: TEST_AGENT_REF }, { taskId: offer.taskId }), v } as unknown as Envelope;
    const { refused, observer } = refusalRecorder();

    await expect(
      handleInboundEnvelope(storesFor(harness, device.deviceId), device.deviceId, retiredClaim, undefined, undefined, observer)
        .then((result) => result.outcome),
    ).resolves.toBe('rejected');
    expect(refused.map((entry) => entry.reason)).toEqual(['protocol_version_unsupported']);
    expect((await harness.cloud.readTaskAttempt(TENANT_A, offer.taskId))?.status).toBe('offered');
  });

  it.each([1, 2, 3])('rejects the retired v:%i at POST /byok/messages before it can be acknowledged as accepted', async (v) => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    const offer = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    const retiredClaim = { ...createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: TEST_AGENT_REF }, { taskId: offer.taskId }), v };

    const response = await harness.request('/byok/messages', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [retiredClaim] }),
    });
    expect(response.status).toBe(400);
    expect((await harness.cloud.readTaskAttempt(TENANT_A, offer.taskId))?.status).toBe('offered');
  });

  it('keeps the supported v:4 claim path accepted', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    const offer = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    const claim = createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: TEST_AGENT_REF }, { taskId: offer.taskId });
    expect(claim.v).toBe(4);

    await expect(handleInboundEnvelope(storesFor(harness, device.deviceId), device.deviceId, claim).then((result) => result.outcome)).resolves.toBe('accepted');
    expect((await harness.cloud.readTaskAttempt(TENANT_A, offer.taskId))?.status).toBe('claimed');
  });

  it('refuses a v2 daemon handshake and delivers no offer to it', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const stores = storesFor(harness, device.deviceId);
    const helloPayload = {
      deviceId: device.deviceId,
      productId: 'test-product',
      protocolVersions: [2],
      capabilities: ['agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session',
        'terminal-projection-selection'],
      runtimes: [],
    };
    const capabilitiesBefore = (await harness.stores.devices.get(TENANT_A, device.deviceId))?.capabilities;

    // A v4 envelope that declares only v2: the handshake gate.
    const v4Hello = createEnvelope('conn.hello', helloPayload as never);
    const helloRefusal = refusalRecorder();
    expect(await handleInboundEnvelope(stores, device.deviceId, v4Hello, undefined, undefined, helloRefusal.observer)
      .then((result) => result.outcome)).toBe('rejected');
    expect(helloRefusal.refused.map((entry) => entry.reason)).toEqual(['hello_protocol_version_unsupported']);

    // What a v2 daemon actually sends: a `v: 2` envelope, refused on `v` alone.
    const v2Hello = { ...createEnvelope('conn.hello', helloPayload as never), v: 2 } as unknown as Envelope;
    const envelopeRefusal = refusalRecorder();
    expect(await handleInboundEnvelope(stores, device.deviceId, v2Hello, undefined, undefined, envelopeRefusal.observer)
      .then((result) => result.outcome)).toBe('rejected');
    expect(envelopeRefusal.refused.map((entry) => entry.reason)).toEqual(['protocol_version_unsupported']);

    // Over HTTP the same handshake answers with no advertisement, and the `v: 2`
    // envelope fails the schema boundary.
    const post = (messages: unknown[]) => harness.json('/byok/messages', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    const httpHello = await post([createEnvelope('conn.hello', helloPayload as never)]);
    expect(httpHello.status).toBe(200);
    expect(httpHello.body).toMatchObject({ accepted: 0, rejected: 1 });
    expect(Object.hasOwn(httpHello.body as object, 'capabilities')).toBe(false);
    expect((await post([v2Hello])).status).toBe(400);

    // No capability snapshot was recorded, so no Agent offer can be admitted for
    // the device and its mailbox stays empty.
    expect((await harness.stores.devices.get(TENANT_A, device.deviceId))?.capabilities).toEqual(capabilitiesBefore);
    await expect(harness.cloud.submitAgentExecution(TENANT_A, resultDocumentExecution(device.deviceId)))
      .rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'v2-daemon-execution')).toBeUndefined();
    expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 })).messages).toEqual([]);
    const poll = await harness.json('/byok/events?cursor=0', { headers: device.authorization });
    expect(poll.status).toBe(200);
    expect((poll.body as EventsPollResponse).events).toEqual([]);
  });
});
