import { createEnvelope, decodeEnvelope } from '@byok-sdk/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_HOME_CONTRACT_CAPABILITY,
  handleInboundEnvelope,
  tenantStoresFor,
} from '..';
import { TENANT_A, createHarness, type CloudHarness } from './support/harness';

const AGENT_REF = { agentId: 'agent-1', profileRevision: 'profile-r1' } as const;
const OTHER_AGENT_REF = { agentId: 'agent-2', profileRevision: 'profile-r9' } as const;

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
    await harness.core.presence.publish(TENANT_A, {
      deviceId: device.deviceId,
      level: 'online',
      protocolVersions: [1],
      configuredToolsets: ['agent-home-contract'],
      ttlMs: 60_000,
      minimumIntervalMs: 0,
    });

    await expect(
      harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, { payload: agentPayload() }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });

    expect(
      (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 }))
        .messages,
    ).toHaveLength(0);
    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'task_missing')).toBeUndefined();
    expect((await harness.stores.devices.get(TENANT_A, device.deviceId))?.capabilities).toBeUndefined();
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
        payload: agentPayload(),
      }),
    ).rejects.toMatchObject({ code: 'agent_task_already_exists' });
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

  it('atomically admits only one concurrent enqueue for an exact Agent task id', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY],
    });

    const outcomes = await Promise.allSettled([
      harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
        taskId: 'agent-concurrent-enqueue',
        payload: agentPayload(),
      }),
      harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
        taskId: 'agent-concurrent-enqueue',
        payload: agentPayload(),
      }),
    ]);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: 'agent_task_already_exists' });
    expect(
      (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 }))
        .messages,
    ).toHaveLength(1);
  });

  it('isolates same-device offers, retry receipts, and approval decisions by exact AgentRef', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY],
    });

    const [first, second] = await Promise.all([
      harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
        taskId: 'same-device-agent-one',
        payload: agentPayload(),
      }),
      harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
        taskId: 'same-device-agent-two',
        payload: { ...agentPayload(), instruction: 'second Agent task', agentRef: OTHER_AGENT_REF },
      }),
    ]);
    expect(first.attempt.agentRef).toEqual(AGENT_REF);
    expect(second.attempt.agentRef).toEqual(OTHER_AGENT_REF);

    const stores = deviceStores(harness, device.deviceId);
    for (const [taskId, agentRef, approvalId] of [
      [first.taskId, AGENT_REF, 'approval-agent-one'],
      [second.taskId, OTHER_AGENT_REF, 'approval-agent-two'],
    ] as const) {
      await expect(
        handleInboundEnvelope(
          stores,
          device.deviceId,
          createEnvelope('task.claim', { deviceId: device.deviceId, agentRef }, { taskId }),
        ),
      ).resolves.toBe('accepted');
      await expect(
        handleInboundEnvelope(
          stores,
          device.deviceId,
          createEnvelope('task.await_approval', { summary: 'needs confirmation', approvalId }, { taskId }),
        ),
      ).resolves.toBe('accepted');
    }

    await Promise.all([
      harness.cloud.approveTask(TENANT_A, first.taskId, { approvalId: 'approval-agent-one' }),
      harness.cloud.approveTask(TENANT_A, second.taskId, { approvalId: 'approval-agent-two' }),
    ]);
    await expect(harness.cloud.approveTask(TENANT_A, first.taskId, { approvalId: 'approval-agent-one' }))
      .resolves.toMatchObject({ envelope: { type: 'task.approve' } });

    const page = await harness.core.mailbox.readAfter(TENANT_A, {
      deviceId: device.deviceId,
      afterSeq: 0,
      limit: 10,
    });
    const offers = page.messages.map((message) => decodeEnvelope(message.body)).filter((item) => item.type === 'task.offer_for_agent');
    const decisions = page.messages.map((message) => decodeEnvelope(message.body)).filter((item) => item.type === 'task.approve');
    expect(offers).toHaveLength(2);
    expect(decisions).toHaveLength(2);
    expect(new Set(offers.map((item) => item.id)).size).toBe(2);
    expect(new Set(decisions.map((item) => item.id)).size).toBe(2);
  });

  it('records capability from the authenticated long-poll HTTP handshake, never from presence', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const hello = createEnvelope('conn.hello', {
      protocolVersions: [1],
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY],
      deviceId: device.deviceId,
      productId: 'test-product',
    });
    const response = await harness.request('/byok/messages', {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [hello] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcomes: [{ id: hello.id, outcome: 'accepted' }] });
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

  it('rejects a long-poll hello that does not support the frozen protocol version', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const stores = deviceStores(harness, device.deviceId);
    const incompatibleHello = createEnvelope('conn.hello', {
      protocolVersions: [2],
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY],
      deviceId: device.deviceId,
      productId: 'test-product',
    });

    expect(await handleInboundEnvelope(stores, device.deviceId, incompatibleHello)).toBe('rejected');
    expect((await harness.stores.devices.get(TENANT_A, device.deviceId))?.capabilities).toBeUndefined();
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

  it('keeps a reserved Agent attempt retryable when mailbox append fails', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY],
    });
    vi.spyOn(harness.core.mailbox, 'append').mockRejectedValueOnce(new Error('mailbox unavailable'));

    await expect(
      harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
        taskId: 'agent-mailbox-failure',
        payload: agentPayload(),
      }),
    ).rejects.toThrow('mailbox unavailable');
    await expect(harness.cloud.readTaskAttempt(TENANT_A, 'agent-mailbox-failure')).resolves.toMatchObject({
      status: 'offered',
      agentRef: AGENT_REF,
    });
    await expect(
      harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
        taskId: 'agent-mailbox-failure',
        payload: agentPayload(),
      }),
    ).resolves.toMatchObject({ taskId: 'agent-mailbox-failure' });
    expect(
      (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 }))
        .messages,
    ).toHaveLength(1);
  });

  it('does not let lifecycle callers attach Agent identity to a legacy attempt', async () => {
    const harness = createHarness();
    await harness.stores.tasks.open(TENANT_A, {
      taskId: 'legacy-agent-attachment',
      deviceId: 'legacy-device',
    });

    await harness.stores.tasks.recordStatus(TENANT_A, {
      taskId: 'legacy-agent-attachment',
      status: 'failed',
      agentRef: AGENT_REF,
      terminalCause: 'must not attach identity',
    });
    await expect(harness.stores.tasks.get(TENANT_A, 'legacy-agent-attachment')).resolves.toMatchObject({
      status: 'offered',
    });
    expect((await harness.stores.tasks.get(TENANT_A, 'legacy-agent-attachment'))?.agentRef).toBeUndefined();
  });

  it('does not let a lifecycle caller omit the exact AgentRef from an Agent attempt', async () => {
    const harness = createHarness();
    await harness.stores.tasks.reserveAgentOffer(TENANT_A, {
      taskId: 'agent-ref-omission',
      deviceId: 'agent-device',
      agentRef: AGENT_REF,
    });

    await harness.stores.tasks.recordStatus(TENANT_A, {
      taskId: 'agent-ref-omission',
      status: 'failed',
      terminalCause: 'must not bypass identity matching',
    });
    await expect(harness.stores.tasks.get(TENANT_A, 'agent-ref-omission')).resolves.toMatchObject({
      status: 'offered',
      agentRef: AGENT_REF,
    });
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

    const missingDecline = createEnvelope(
      'task.decline',
      { reason: 'missing AgentRef', retryable: false },
      { taskId },
    );
    expect(await handleInboundEnvelope(stores, device.deviceId, missingDecline)).toBe('rejected');
    const mismatchedDecline = createEnvelope(
      'task.decline',
      {
        reason: 'wrong AgentRef',
        retryable: false,
        agentRef: { agentId: 'agent-other', profileRevision: 'profile-r1' },
      },
      { taskId },
    );
    expect(await handleInboundEnvelope(stores, device.deviceId, mismatchedDecline)).toBe('rejected');

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
