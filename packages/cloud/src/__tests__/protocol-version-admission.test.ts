import { readFileSync } from 'node:fs';
import type { Clock } from '@byok-sdk/core';
import {
  BYOK_CHALLENGE_PATH, BYOK_MESSAGES_PATH, BYOK_TOKEN_PATH, createEnvelope, DEVICE_NOT_REGISTERED_CODE, DeviceNotRegisteredResponseSchema,
  PROTOCOL_VERSION, type Envelope, type EventsPollResponse,
} from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { AgentExecutionInputSchema } from '../agent-execution';
import { createHmacTokenSigner } from '../auth/tokens';
import { handleInboundEnvelope, type ByokCloudObserver, type InboundRefused } from '../inbound';
import { tenantStoresFor } from '../tenant-stores';
import { createHarness, grantAgentHome, offerPayload, PRODUCT_ID, TENANT_A, TEST_AGENT_REF } from './support/harness';

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

/** Raw request bodies a v6 daemon (0.41.0–0.43.0) sent, from the frozen v6 HTTP corpus. */
function v6HttpBodies() {
  const lines = readFileSync(new URL('../../../protocol/src/__tests__/golden/v6.http.ndjson', import.meta.url), 'utf8')
    .trimEnd().split('\n').map((line) => JSON.parse(line) as { surface: string; body: string; value: { messages?: { type: string }[] } });
  const body = (match: (line: (typeof lines)[number]) => boolean) => lines.find(match)!.body;
  return {
    challenge: body((line) => line.surface === 'ChallengeRequest'),
    token: body((line) => line.surface === 'TokenRequest'),
    pair: JSON.parse(body((line) => line.surface === 'PairResponse')) as { deviceId: string; tenantId: string },
    hello: body((line) => line.surface === 'MessagesSendRequest' && line.value.messages?.[0]?.type === 'conn.hello'),
  };
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

  // #1757 G1, the half before any hello: a v6 daemon whose enrollment was not
  // paired again into the v7 store. A v6 daemon renews through challenge →
  // token and halts as `device_revoked` on the typed `device_not_registered`
  // 401 (0.43.0 `AuthManager.readUnauthorized`, same schema as today); a 401
  // on any bearer route sends it to that renewal first.
  it('stops a v6 daemon that was not paired again at authentication, before its hello is read', async () => {
    const v6 = v6HttpBodies();
    const clock: Clock = { now: () => new Date() };
    const signer = createHmacTokenSigner(new Uint8Array(32).fill(17), clock);
    const harness = createHarness({ tokenSigner: signer, clock });
    const post = (path: string, body: string, headers: Record<string, string> = {}) =>
      harness.json(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

    // A cold start renews first: both auth steps answer the typed revocation 401.
    for (const [path, body] of [[BYOK_CHALLENGE_PATH, v6.challenge], [BYOK_TOKEN_PATH, v6.token]] as const) {
      const answer = await post(path, body);
      expect(answer.status).toBe(401);
      expect(answer.body).toMatchObject({ code: DEVICE_NOT_REGISTERED_CODE });
      expect(DeviceNotRegisteredResponseSchema.safeParse(answer.body).success).toBe(true);
    }

    // A daemon still running across the upgrade holds a v6 bearer. Even signed
    // with a key the v7 deployment kept, it names no v7 device row, so its v6
    // hello gets the untyped 401 that sends it to the renewal above, never the
    // per-entry protocol_version_unsupported a paired-again daemon reads.
    const v6Bearer = await signer.sign({ deviceId: v6.pair.deviceId, tenantId: v6.pair.tenantId, productId: PRODUCT_ID }, 1800);
    await expect(post(BYOK_MESSAGES_PATH, v6.hello, { authorization: `Bearer ${v6Bearer}` }))
      .resolves.toEqual({ status: 401, body: { error: 'unauthorized' } });
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
