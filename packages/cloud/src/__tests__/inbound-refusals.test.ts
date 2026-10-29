/**
 * `ByokCloudObserver.onInboundRefused` — the refusal half of the observer.
 *
 * `rejected` used to be a bare count: a size overrun, an identity mismatch and
 * a wrong-direction type all looked identical to the host. These tests pin the
 * three properties that make the new hook safe to rely on:
 *
 * - **every `rejected` carries a closed reason** (the type system enforces that
 *   a rejection path names one; the table below proves the names are the ones
 *   operators will see);
 * - **it observes, it does not decide** — a throwing observer changes nothing,
 *   and `accepted` / `duplicate` / `rate_limited` never reach it;
 * - **the wire reports the same authoritative result** — `POST /byok/messages` still answers
 *   `{ accepted, rejected }` and nothing about the reason.
 */
import { createEnvelope, PROTOCOL_VERSION, type Envelope } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import {
  handleInboundEnvelope,
  INBOUND_REFUSAL_REASONS,
  type ByokCloudObserver,
  type InboundRefusalReason,
  type InboundRefused,
} from '../inbound';
import type { InboundRateLimiter } from '../stores/ports';
import { tenantStoresFor, type TenantStores } from '../tenant-stores';
import { TENANT_A, TEST_AGENT_REF, createHarness, grantAgentHome, offerPayload, type CloudHarness } from './support/harness';

const KIB = 1024;

function storesFor(harness: CloudHarness, deviceId: string): TenantStores {
  return tenantStoresFor(
    { kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId },
    { core: harness.core, cloud: harness.stores, mailboxWake: harness.mailboxWake },
  );
}

function refusalRecorder(): { readonly refused: InboundRefused[]; readonly observer: ByokCloudObserver } {
  const refused: InboundRefused[] = [];
  return {
    refused,
    observer: {
      onInboundCommitted() {},
      onInboundRefused(input) {
        refused.push(input);
      },
    },
  };
}

/** Two events of ~40 KiB each: individually fine, together over the 64 KiB batch bound. */
function oversizedProgress(taskId: string): Envelope {
  const blob = 'x'.repeat(40 * KIB);
  return createEnvelope(
    'task.progress',
    { seq: 1, events: [{ type: 'x-bulk', blob }, { type: 'x-bulk', blob }] },
    { taskId },
  );
}

describe('observer.onInboundRefused', () => {
  it('publishes a unique runtime vocabulary for its closed reason type', () => {
    expect(new Set(INBOUND_REFUSAL_REASONS).size).toBe(INBOUND_REFUSAL_REASONS.length);
  });
  it('reports activity_batch_too_large for a task.progress with two ~40 KiB events', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const stores = storesFor(harness, device.deviceId);
    const { refused, observer } = refusalRecorder();
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    const { taskId } = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
      payload: offerPayload(),
    });
    const envelope = oversizedProgress(taskId);

    expect(await handleInboundEnvelope(stores, device.deviceId, envelope, undefined, undefined, observer).then((result) => result.outcome)).toBe(
      'rejected',
    );
    expect(refused).toEqual([
      {
        tenantId: TENANT_A,
        deviceId: device.deviceId,
        envelopeId: envelope.id,
        type: 'task.progress',
        reason: 'activity_batch_too_large',
      },
    ]);
  });

  it('names a closed reason for each distinct refusal path it is shown', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const deviceId = device.deviceId;
    const stores = storesFor(harness, deviceId);
    await grantAgentHome(harness, TENANT_A, deviceId);
    const { taskId } = await harness.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: offerPayload() });
    // Claimed without a harness, so a terminal echoing one is a mismatch.
    expect(await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF }, { taskId })).then((result) => result.outcome)).toBe(
      'accepted',
    );
    const unclaimed = await harness.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: offerPayload('second') });
    const hello = (payload: Record<string, unknown>): Envelope =>
      createEnvelope('conn.hello', {
        deviceId,
        productId: 'test-product',
        protocolVersions: [PROTOCOL_VERSION],
        capabilities: [],
        runtimes: [],
        ...payload,
      } as never);

    const cases: ReadonlyArray<readonly [InboundRefusalReason, Envelope]> = [
      ['protocol_version_unsupported', { ...createEnvelope('task.started', {}, { taskId }), v: 99 } as unknown as Envelope],
      ['type_not_allowed', createEnvelope('task.cancel', {}, { taskId, seq: 1 })],
      ['task_not_found_for_device', createEnvelope('task.started', {}, { taskId: 'task-nobody-offered' })],
      ['hello_device_mismatch', hello({ deviceId: 'someone-else' })],
      ['hello_harnesses_without_capability', hello({ harnesses: [] })],
      ['hello_protocol_version_unsupported', hello({ protocolVersions: [PROTOCOL_VERSION + 1] })],
      ['claim_device_mismatch', createEnvelope('task.claim', { deviceId: 'someone-else' }, { taskId })],
      ['claim_harness_mismatch', createEnvelope('task.claim', { deviceId, harnessId: 'ghost' }, { taskId })],
      ['claim_harness_unavailable', createEnvelope('task.claim', { deviceId, harnessId: 'ghost' }, { taskId: unclaimed.taskId })],
      ['terminal_harness_mismatch', createEnvelope('task.complete', { summary: 'done', sessionRef: 's', harnessId: 'ghost' }, { taskId })],
      ['activity_batch_too_large', oversizedProgress(taskId)],
      ['activity_batch_invalid', createEnvelope('task.progress', { seq: -1, events: [{ type: 'turn_end' }] }, { taskId })],
    ];

    for (const [reason, envelope] of cases) {
      expect(INBOUND_REFUSAL_REASONS).toContain(reason);
      const { refused, observer } = refusalRecorder();
      expect(
        await handleInboundEnvelope(stores, deviceId, envelope, undefined, undefined, observer).then((result) => result.outcome),
        reason,
      ).toBe('rejected');
      expect(refused.map((entry) => entry.reason), reason).toEqual([reason]);
      expect(refused[0]).toMatchObject({
        tenantId: TENANT_A,
        deviceId,
        envelopeId: envelope.id,
        type: envelope.type,
      });
    }
  });

  it('is not told about accepted, duplicate or rate_limited envelopes', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const stores = storesFor(harness, device.deviceId);
    const { refused, observer } = refusalRecorder();
    await grantAgentHome(harness, TENANT_A, device.deviceId);
    const { taskId } = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
    const claim = createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: TEST_AGENT_REF }, { taskId });

    expect(await handleInboundEnvelope(stores, device.deviceId, claim, undefined, undefined, observer).then((result) => result.outcome)).toBe('accepted');
    expect(await handleInboundEnvelope(stores, device.deviceId, claim, undefined, undefined, observer).then((result) => result.outcome)).toBe('duplicate');
    const limiter: InboundRateLimiter = { async consume() { return { allowed: false, retryAfterMs: 1_000 }; } };
    const limited = tenantStoresFor(
      { kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId: device.deviceId },
      { core: harness.core, mailboxWake: harness.mailboxWake, cloud: { ...harness.stores, rateLimiter: limiter } },
    );
    expect(await handleInboundEnvelope(limited, device.deviceId, claim, undefined, undefined, observer).then((result) => result.outcome)).toBe(
      'rate_limited',
    );

    expect(refused).toEqual([]);
  });

  it('swallows a throwing observer and leaves the outcome untouched', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const stores = storesFor(harness, device.deviceId);
    let calls = 0;
    const thrower: ByokCloudObserver = {
      onInboundCommitted() {},
      onInboundRefused() {
        calls += 1;
        throw new Error('observer blew up');
      },
    };
    const wrongDirection = createEnvelope('task.cancel', {}, { taskId: 'task-1', seq: 1 });

    expect(await handleInboundEnvelope(stores, device.deviceId, wrongDirection, undefined, undefined, thrower).then((result) => result.outcome)).toBe(
      'rejected',
    );
    expect(calls).toBe(1);
  });

  it('is optional: an observer with only onInboundCommitted still sees the same outcome', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const stores = storesFor(harness, device.deviceId);
    const commitOnly: ByokCloudObserver = { onInboundCommitted() {} };
    const wrongDirection = createEnvelope('task.cancel', {}, { taskId: 'task-1', seq: 1 });

    expect(await handleInboundEnvelope(stores, device.deviceId, wrongDirection, undefined, undefined, commitOnly).then((result) => result.outcome)).toBe(
      'rejected',
    );
  });

  it('reports counts and coarse outcomes, independently of a throwing refusal observer', async () => {
    const thrower: ByokCloudObserver = {
      onInboundCommitted() {},
      onInboundRefused() {
        throw new Error('observer blew up');
      },
    };
    const { refused, observer } = refusalRecorder();
    const answers: unknown[] = [];
    for (const candidate of [undefined, thrower, observer]) {
      const harness = createHarness(candidate === undefined ? {} : { observer: candidate });
      const device = await harness.pairDevice(TENANT_A);
      await grantAgentHome(harness, TENANT_A, device.deviceId);
      const { taskId } = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: offerPayload() });
      const messages = [oversizedProgress(taskId), createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: TEST_AGENT_REF }, { taskId })];
      const response = await harness.request('/byok/messages', {
        method: 'POST',
        headers: { ...device.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({
          messages,
        }),
      });
      expect(response.status).toBe(200);
      const answer = await response.json();
      expect(answer).toEqual({ accepted: 1, rejected: 1, outcomes: [
        { id: messages[0]!.id, outcome: 'rejected', reason: 'limit_exceeded' },
        { id: messages[1]!.id, outcome: 'accepted' },
      ] });
      answers.push(answer);
    }

    expect(answers).toHaveLength(3);
    expect(refused.map((entry) => entry.reason)).toEqual(['activity_batch_too_large']);
  });
});


it('hides missing tasks and another device target behind not_permitted and advertises deployed ingress', async () => {
  const harness = createHarness({ activityMaxEvents: 7, activityMaxBytes: 4096 });
  const device = await harness.pairDevice(TENANT_A);
  const other = await harness.pairDevice(TENANT_A);
  await grantAgentHome(harness, TENANT_A, other.deviceId);
  const foreign = await harness.cloud.enqueueAgentOffer(TENANT_A, other.deviceId, { payload: offerPayload() });
  const messages = [createEnvelope('task.started', {}, { taskId: 'missing' }), createEnvelope('task.started', {}, { taskId: foreign.taskId })];
  const response = await harness.request('/byok/messages', { method: 'POST', headers: { ...device.authorization, 'content-type': 'application/json' }, body: JSON.stringify({ messages }) });
  expect(await response.json()).toEqual({ accepted: 0, rejected: 2, outcomes: messages.map((message) => ({ id: message.id, outcome: 'rejected', reason: 'not_permitted' })) });
  const poll = await harness.request('/byok/events?cursor=0', { headers: device.authorization });
  expect(await poll.json()).toMatchObject({ ingress: { activityMaxEvents: 7, activityMaxBytes: 4096 } });
});
