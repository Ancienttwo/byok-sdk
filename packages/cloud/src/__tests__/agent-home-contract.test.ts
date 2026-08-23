import { createEnvelope, decodeEnvelope } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import {
  AGENT_HOME_CONTRACT_CAPABILITY,
  handleInboundEnvelope,
  tenantStoresFor,
} from '..';
import { TENANT_A, createHarness, type CloudHarness } from './support/harness';

const AGENT_REF = { agentId: 'agent-1', profileRevision: 'profile-r1' } as const;

function deviceStores(harness: CloudHarness, deviceId: string) {
  return tenantStoresFor(
    { kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId },
    { core: harness.core, cloud: harness.stores },
  );
}

function agentPayload() {
  return {
    instruction: 'remember this Agent task',
    policy: { mode: 'auto' as const },
    agentRef: AGENT_REF,
  };
}

describe('hosted Agent-home contract', () => {
  it('fails closed on capability omission before mailbox append or task open', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);

    await expect(
      harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: agentPayload() }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });

    expect(
      (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 }))
        .messages,
    ).toHaveLength(0);
    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'task_missing')).toBeUndefined();
  });

  it('persists the exact AgentRef through mailbox decode and task-attempt readback', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY],
    });

    const offered = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
      taskId: 'agent-task-1',
      payload: { ...agentPayload(), requiredToolsets: ['search', 'browser'] },
    });
    const page = await harness.core.mailbox.readAfter(TENANT_A, {
      deviceId: device.deviceId,
      afterSeq: 0,
      limit: 10,
    });
    expect(page.messages).toHaveLength(1);
    expect(decodeEnvelope(page.messages[0]!.body)).toEqual(offered.envelope);
    expect(
      offered.envelope.type === 'task.offer_for_agent'
        ? offered.envelope.payload.requiredToolsets
        : undefined,
    ).toEqual(['search', 'browser']);
    expect(offered.attempt.agentRef).toEqual(AGENT_REF);
    expect((await harness.cloud.readTaskAttempt(TENANT_A, 'agent-task-1'))?.agentRef).toEqual(AGENT_REF);
    await expect(
      harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
        taskId: 'agent-task-1',
        payload: { ...agentPayload(), agentRef: { agentId: 'agent-other', profileRevision: 'profile-r1' } },
      }),
    ).rejects.toMatchObject({ code: 'agent_ref_mismatch' });
    expect(
      (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 }))
        .messages,
    ).toHaveLength(1);
  });

  it('records capability from the authenticated long-poll handshake, never from presence', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const stores = deviceStores(harness, device.deviceId);
    const hello = createEnvelope('conn.hello', {
      protocolVersions: [1],
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY],
      deviceId: device.deviceId,
      productId: 'test-product',
    });
    expect(await handleInboundEnvelope(stores, device.deviceId, hello)).toBe('accepted');
    expect((await harness.stores.devices.get(TENANT_A, device.deviceId))?.capabilities).toEqual([
      AGENT_HOME_CONTRACT_CAPABILITY,
    ]);
    await expect(
      harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
        taskId: 'agent-authenticated-capability',
        payload: agentPayload(),
      }),
    ).resolves.toMatchObject({ taskId: 'agent-authenticated-capability' });
  });

  it('removes stale support when a later authenticated hello omits the capability', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const stores = deviceStores(harness, device.deviceId);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY],
    });
    const downgradedHello = createEnvelope('conn.hello', {
      protocolVersions: [1],
      capabilities: [],
      deviceId: device.deviceId,
      productId: 'test-product',
    });
    expect(await handleInboundEnvelope(stores, device.deviceId, downgradedHello)).toBe('accepted');
    expect((await harness.stores.devices.get(TENANT_A, device.deviceId))?.capabilities).toEqual([]);
    await expect(
      harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
        taskId: 'agent-stale-capability',
        payload: agentPayload(),
      }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect(
      (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 }))
        .messages,
    ).toHaveLength(0);
  });

  it('rejects malformed or oversized AgentRef before reserving mailbox state', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY],
    });

    await expect(
      harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
        taskId: 'agent-malformed',
        payload: { ...agentPayload(), agentRef: { agentId: '../escape', profileRevision: 'r1' } },
      }),
    ).rejects.toThrow();
    await expect(
      harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
        taskId: 'agent-oversized',
        payload: {
          ...agentPayload(),
          agentRef: { agentId: 'agent-1', profileRevision: 'r'.repeat(161) },
        },
      }),
    ).rejects.toThrow();

    expect(
      (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 }))
        .messages,
    ).toHaveLength(0);
    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'agent-malformed')).toBeUndefined();
    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'agent-oversized')).toBeUndefined();
  });

  it('rejects claim/terminal AgentRef mismatches and protects the first terminal fact', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY],
    });
    const { taskId } = await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
      taskId: 'agent-task-2',
      payload: agentPayload(),
    });
    const stores = deviceStores(harness, device.deviceId);
    const other = await harness.pairDevice(TENANT_A);
    const otherStores = deviceStores(harness, other.deviceId);
    expect(
      await handleInboundEnvelope(
        otherStores,
        other.deviceId,
        createEnvelope(
          'task.claim',
          { deviceId: other.deviceId, agentRef: AGENT_REF },
          { taskId },
        ),
      ),
    ).toBe('rejected');

    const mismatchedClaim = createEnvelope(
      'task.claim',
      { deviceId: device.deviceId, agentRef: { agentId: 'agent-other', profileRevision: 'profile-r1' } },
      { taskId },
    );
    expect(await handleInboundEnvelope(stores, device.deviceId, mismatchedClaim)).toBe('rejected');

    const claim = createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: AGENT_REF }, { taskId });
    expect(await handleInboundEnvelope(stores, device.deviceId, claim)).toBe('accepted');
    expect(await handleInboundEnvelope(stores, device.deviceId, createEnvelope('task.started', {}, { taskId }))).toBe(
      'accepted',
    );
    expect(
      await handleInboundEnvelope(stores, device.deviceId, createEnvelope('task.progress', { seq: 1, events: [] }, { taskId })),
    ).toBe('accepted');

    const mismatchedTerminal = createEnvelope(
      'task.complete',
      {
        summary: 'wrong Agent',
        sessionRef: 'session-wrong',
        agentRef: { agentId: 'agent-other', profileRevision: 'profile-r1' },
      },
      { taskId },
    );
    expect(await handleInboundEnvelope(stores, device.deviceId, mismatchedTerminal)).toBe('rejected');
    expect(await harness.cloud.readTerminalReceipt(TENANT_A, taskId)).toBeUndefined();

    const first = createEnvelope(
      'task.complete',
      { summary: 'first', sessionRef: 'session-1', agentRef: AGENT_REF },
      { taskId },
    );
    const second = createEnvelope(
      'task.fail',
      { reason: 'second', agentRef: AGENT_REF },
      { taskId },
    );
    expect(await handleInboundEnvelope(stores, device.deviceId, first)).toBe('accepted');
    expect(await handleInboundEnvelope(stores, device.deviceId, second)).toBe('accepted');
    expect((await harness.cloud.readTaskResult(TENANT_A, taskId))?.state).toBe('complete');
    expect((await harness.cloud.readTaskResult(TENANT_A, taskId))?.agentRef).toEqual(AGENT_REF);
  });
});
