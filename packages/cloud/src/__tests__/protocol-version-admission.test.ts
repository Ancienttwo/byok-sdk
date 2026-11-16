import { createEnvelope, PROTOCOL_VERSION, type Envelope, type EventsPollResponse } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { AgentExecutionInputSchema } from '../agent-execution';
import { handleInboundEnvelope, type ByokCloudObserver, type InboundRefused } from '../inbound';
import { tenantStoresFor } from '../tenant-stores';
import { createHarness, grantAgentHome, offerPayload, TENANT_A, TEST_AGENT_REF } from './support/harness';

const PI = { kind: 'runtime', runtimeId: 'pi' } as const;

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
      target: { lane: 'runtime', runtimeId: 'codex' },
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
  it('is wire v7', () => {
    expect(PROTOCOL_VERSION).toBe(7);
  });

  it.each([1, 2, 3, 4, 5, 6])('rejects the retired v:%i at the exported inbound gate before the claim lifecycle mutation', async (v) => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    const offer = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    const retiredClaim = { ...createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: TEST_AGENT_REF, executor: PI }, { taskId: offer.taskId }), v } as unknown as Envelope;
    const { refused, observer } = refusalRecorder();

    await expect(
      handleInboundEnvelope(storesFor(harness, device.deviceId), device.deviceId, retiredClaim, undefined, undefined, observer)
        .then((result) => result.outcome),
    ).resolves.toBe('rejected');
    expect(refused.map((entry) => entry.reason)).toEqual(['protocol_version_unsupported']);
    expect((await harness.cloud.readTaskAttempt(TENANT_A, offer.taskId))?.status).toBe('offered');
  });

  it.each([1, 2, 3, 4, 5, 6])('answers the retired v:%i at POST /byok/messages with a per-entry protocol_version_unsupported', async (v) => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    const offer = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    const retiredClaim = { ...createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: TEST_AGENT_REF, executor: PI }, { taskId: offer.taskId }), v };

    const response = await harness.json('/byok/messages', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [retiredClaim] }),
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ accepted: 0, rejected: 1, outcomes: [{ id: retiredClaim.id, outcome: 'rejected', reason: 'protocol_version_unsupported' }] });
    expect((await harness.cloud.readTaskAttempt(TENANT_A, offer.taskId))?.status).toBe('offered');
  });

  it('keeps the supported v:7 claim path accepted', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    const offer = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    const claim = createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: TEST_AGENT_REF, executor: PI }, { taskId: offer.taskId });
    expect(claim.v).toBe(7);

    await expect(handleInboundEnvelope(storesFor(harness, device.deviceId), device.deviceId, claim).then((result) => result.outcome)).resolves.toBe('accepted');
    expect((await harness.cloud.readTaskAttempt(TENANT_A, offer.taskId))?.status).toBe('claimed');
  });

  it.each([2, 5, 6])('refuses a v%i daemon handshake and delivers no offer to it', async (retired) => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const stores = storesFor(harness, device.deviceId);
    const helloPayload = {
      deviceId: device.deviceId,
      productId: 'test-product',
      protocolVersions: [retired],
      capabilities: ['agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session',
        'terminal-projection-selection'],
      runtimes: [],
    };
    const capabilitiesBefore = (await harness.stores.devices.get(TENANT_A, device.deviceId))?.capabilities;

    // A current envelope that declares only the retired major: the handshake gate.
    const currentHello = createEnvelope('conn.hello', helloPayload as never);
    const helloRefusal = refusalRecorder();
    expect(await handleInboundEnvelope(stores, device.deviceId, currentHello, undefined, undefined, helloRefusal.observer)
      .then((result) => result.outcome)).toBe('rejected');
    expect(helloRefusal.refused.map((entry) => entry.reason)).toEqual(['hello_protocol_version_unsupported']);

    // What a retired daemon actually sends: an envelope of its own major, refused on `v` alone.
    const v2Hello = { ...createEnvelope('conn.hello', helloPayload as never), v: retired } as unknown as Envelope;
    const envelopeRefusal = refusalRecorder();
    expect(await handleInboundEnvelope(stores, device.deviceId, v2Hello, undefined, undefined, envelopeRefusal.observer)
      .then((result) => result.outcome)).toBe('rejected');
    expect(envelopeRefusal.refused.map((entry) => entry.reason)).toEqual(['protocol_version_unsupported']);

    // Over HTTP the same handshake answers with no ingress. The daemon's own
    // envelope gets the frozen cross-version refusal: a 200 whose lone outcome
    // is `protocol_version_unsupported`, which a v6 daemon reads as a refused
    // handshake and halts on (#1757 G1).
    const post = (messages: unknown[]) => harness.json('/byok/messages', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
    });
    const httpHello = await post([createEnvelope('conn.hello', helloPayload as never)]);
    expect(httpHello.status).toBe(200);
    expect(httpHello.body).toMatchObject({ accepted: 0, rejected: 1 });
    expect(Object.hasOwn(httpHello.body as object, 'ingress')).toBe(false);
    const retiredHello = await post([v2Hello]);
    expect(retiredHello.status).toBe(200);
    expect(retiredHello.body).toEqual({ accepted: 0, rejected: 1, outcomes: [{ id: v2Hello.id, outcome: 'rejected', reason: 'protocol_version_unsupported' }] });

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

  it('answers an unknown daemon type type_unsupported per entry and applies the rest of the batch', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    const offer = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    const unknown = { ...createEnvelope('task.started', {}, { taskId: offer.taskId }), type: 'task.later_report' };
    const claim = createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: TEST_AGENT_REF, executor: PI }, { taskId: offer.taskId });

    const response = await harness.json('/byok/messages', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [unknown, claim] }),
    });
    expect(response.body).toEqual({ accepted: 1, rejected: 1, outcomes: [
      { id: unknown.id, outcome: 'rejected', reason: 'type_unsupported' },
      { id: claim.id, outcome: 'accepted' },
    ] });
    expect((await harness.cloud.readTaskAttempt(TENANT_A, offer.taskId))?.status).toBe('claimed');
  });
});
