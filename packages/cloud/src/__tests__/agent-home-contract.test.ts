import { createEnvelope, decodeEnvelope, PROTOCOL_VERSION } from '@byok-sdk/protocol';
import { describe, expect, it, vi } from 'vitest';
import {
  AGENT_HOME_CONTRACT_CAPABILITY,
  handleInboundEnvelope,
  tenantStoresFor,
} from '..';
import { CLOUD_PROTOCOL_CAPABILITIES } from '../handlers/events';
import { TENANT_A, createHarness, type CloudHarness } from './support/harness';

const AGENT_REF = { agentId: 'agent-1', profileRevision: 'profile-r1' } as const;
const OTHER_AGENT_REF = { agentId: 'agent-2', profileRevision: 'profile-r9' } as const;

function deviceStores(harness: CloudHarness, deviceId: string) {
  return tenantStoresFor(
    { kind: 'device', tenantId: TENANT_A, productId: 'test-product', deviceId },
    { core: harness.core, cloud: harness.stores, mailboxWake: harness.mailboxWake },
  );
}

function agentPayload() {
  return {
    instruction: 'remember this Agent task',
    agentRef: AGENT_REF,
    session: { mode: 'resume', sessionRef: 'session-resume-1' } as const,
  };
}

describe('hosted Agent-home contract', () => {
  it('fails closed on capability omission before mailbox append or task open', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.core.presence.publish(TENANT_A, {
      deviceId: device.deviceId,
      level: 'online',
      protocolVersions: [2],
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
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY, 'toolset-selection'],
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
      offered.envelope.type === 'task.offer'
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
        ).then((result) => result.outcome),
      ).resolves.toBe('accepted');
      await expect(
        handleInboundEnvelope(
          stores,
          device.deviceId,
          createEnvelope('task.await_approval', { summary: 'needs confirmation', approvalId }, { taskId }),
        ).then((result) => result.outcome),
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
    const offers = page.messages.map((message) => decodeEnvelope(message.body)).filter((item) => item.type === 'task.offer');
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
      protocolVersions: [PROTOCOL_VERSION],
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
    expect(await response.json()).toMatchObject({ accepted: 1, capabilities: [...CLOUD_PROTOCOL_CAPABILITIES] });
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
      protocolVersions: [PROTOCOL_VERSION],
      capabilities: [],
      deviceId: device.deviceId,
      productId: 'test-product',
    });
    expect(await handleInboundEnvelope(stores, device.deviceId, downgradedHello).then((result) => result.outcome)).toBe('accepted');
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
      protocolVersions: [1],
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY],
      deviceId: device.deviceId,
      productId: 'test-product',
    });

    expect(await handleInboundEnvelope(stores, device.deviceId, incompatibleHello).then((result) => result.outcome)).toBe('rejected');
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

  it('refuses a fresh Agent offer on the resume lane before any durable write (#484)', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY],
    });
    // B2: a payload without sessionRef -> a payload whose session.mode is not resume
    const fresh = { ...agentPayload(), session: { mode: 'fresh' } };

    // The required static type refuses this at compile time; a JS caller still meets the runtime guard.
    await expect(
      harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
        taskId: 'agent-fresh-refused',
        // @ts-expect-error a resume session is required on the resume lane (#484)
        payload: fresh,
      }),
    ).rejects.toMatchObject({
      name: 'ByokCloudError',
      code: 'coordination_input_invalid',
      message: 'Agent resume offer requires session.mode resume with an exact sessionRef; use submitAgentExecution for fresh execution',
    });

    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'agent-fresh-refused')).toBeUndefined();
    expect(
      (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 }))
        .messages,
    ).toHaveLength(0);

    // The refusal left nothing behind: the same id still admits a real resume.
    await expect(
      harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
        taskId: 'agent-fresh-refused',
        payload: agentPayload(),
      }),
    ).resolves.toMatchObject({ taskId: 'agent-fresh-refused', seq: 1 });
  });

  it('refuses an empty sessionRef before any durable write (#484)', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY],
    });

    await expect(
      harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
        taskId: 'agent-empty-session',
        payload: { ...agentPayload(), session: { mode: 'resume', sessionRef: '' } },
      }),
    ).rejects.toMatchObject({
      name: 'ByokCloudError',
      code: 'coordination_input_invalid',
      message: 'Agent resume offer requires session.mode resume with an exact sessionRef; use submitAgentExecution for fresh execution',
    });

    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'agent-empty-session')).toBeUndefined();
    expect(
      (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 }))
        .messages,
    ).toHaveLength(0);
  });

  it('refuses a missing session, a fresh session or an empty sessionRef before capability admission (#484)', async () => {
    const harness = createHarness();
    // Paired but has advertised no capabilities, so admission alone would refuse it.
    const bare = await harness.pairDevice(TENANT_A);
    // B2: a payload without sessionRef -> a payload without session, and one with a fresh session
    const { session: _session, ...missing } = agentPayload();
    const fresh = { ...agentPayload(), session: { mode: 'fresh' } };
    const empty = { ...agentPayload(), session: { mode: 'resume', sessionRef: '' } };
    const refused = {
      name: 'ByokCloudError',
      code: 'coordination_input_invalid',
      message: 'Agent resume offer requires session.mode resume with an exact sessionRef; use submitAgentExecution for fresh execution',
    };

    for (const [deviceId, taskId, payload] of [
      ['device-not-registered', 'agent-missing-unknown-device', missing],
      ['device-not-registered', 'agent-fresh-unknown-device', fresh],
      ['device-not-registered', 'agent-empty-unknown-device', empty],
      [bare.deviceId, 'agent-missing-bare-device', missing],
      [bare.deviceId, 'agent-fresh-bare-device', fresh],
      [bare.deviceId, 'agent-empty-bare-device', empty],
    ] as const) {
      await expect(
        // @ts-expect-error a JS caller may omit the resume session on the resume lane (#484)
        harness.cloud.enqueueAgentOffer(TENANT_A, deviceId, { taskId, payload }),
      ).rejects.toMatchObject(refused);
      expect(await harness.cloud.readTaskAttempt(TENANT_A, taskId)).toBeUndefined();
    }
    expect(
      (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: bare.deviceId, afterSeq: 0, limit: 10 })).messages,
    ).toHaveLength(0);

    // The same bare device with a real sessionRef reaches capability admission.
    await expect(
      harness.cloud.enqueueAgentOffer(TENANT_A, bare.deviceId, { taskId: 'agent-resume-bare-device', payload: agentPayload() }),
    ).rejects.toMatchObject({ name: 'ByokCloudError', code: 'agent_capability_missing' });
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
    ).rejects.toMatchObject({
      code: 'task_offer_append_refused',
      taskId: 'agent-mailbox-failure',
      cause: new Error('mailbox unavailable'),
    });
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
      ).then((result) => result.outcome),
    ).toBe('rejected');

    const mismatchedClaim = createEnvelope(
      'task.claim',
      { deviceId: device.deviceId, agentRef: { agentId: 'agent-other', profileRevision: 'profile-r1' } },
      { taskId },
    );
    expect(await handleInboundEnvelope(stores, device.deviceId, mismatchedClaim).then((result) => result.outcome)).toBe('rejected');

    const missingDecline = createEnvelope(
      'task.decline',
      { reason: 'missing AgentRef', retryable: false },
      { taskId },
    );
    expect(await handleInboundEnvelope(stores, device.deviceId, missingDecline).then((result) => result.outcome)).toBe('rejected');
    const mismatchedDecline = createEnvelope(
      'task.decline',
      {
        reason: 'wrong AgentRef',
        retryable: false,
        agentRef: { agentId: 'agent-other', profileRevision: 'profile-r1' },
      },
      { taskId },
    );
    expect(await handleInboundEnvelope(stores, device.deviceId, mismatchedDecline).then((result) => result.outcome)).toBe('rejected');

    const claim = createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: AGENT_REF }, { taskId });
    expect(await handleInboundEnvelope(stores, device.deviceId, claim).then((result) => result.outcome)).toBe('accepted');
    expect(await handleInboundEnvelope(stores, device.deviceId, createEnvelope('task.started', {}, { taskId })).then((result) => result.outcome)).toBe(
      'accepted',
    );
    expect(
      await handleInboundEnvelope(stores, device.deviceId, createEnvelope('task.progress', { seq: 1, events: [] }, { taskId })).then((result) => result.outcome),
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
    expect(await handleInboundEnvelope(stores, device.deviceId, mismatchedTerminal).then((result) => result.outcome)).toBe('rejected');
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
    expect(await handleInboundEnvelope(stores, device.deviceId, first).then((result) => result.outcome)).toBe('accepted');
    expect(await handleInboundEnvelope(stores, device.deviceId, second).then((result) => result.outcome)).toBe('accepted');
    expect((await harness.cloud.readTaskResult(TENANT_A, taskId))?.state).toBe('complete');
    expect((await harness.cloud.readTaskResult(TENANT_A, taskId))?.agentRef).toEqual(AGENT_REF);
  });
});
