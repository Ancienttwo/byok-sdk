import { AGENT_EGRESS_POLICY_CAPABILITY, AGENT_EGRESS_RELIABLE_ACK_CAPABILITY, AGENT_EGRESS_FRESH_SESSION_CAPABILITY, AGENT_MESSAGE_EGRESS_CAPABILITY, AGENT_INPUT_PREPARATION_CAPABILITY, decodeEnvelope } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { AGENT_HOME_CONTRACT_CAPABILITY } from '..';
import { TENANT_A, createHarness } from './support/harness';

/**
 * The hosted half of `task.offer_prepared`.
 *
 * Two properties, both of which the distinct message type exists for:
 *
 * - A device that cannot prepare never receives an offer naming a preparation.
 *   Capability admission is read from the durable device row BEFORE a mailbox
 *   row or a task attempt is allocated, exactly as every other strict offer
 *   does it, so a refused dispatch leaves nothing behind.
 * - The payload is strict. A caller that tried to reach the ordinary
 *   instruction lane through this message — by adding an `instruction`, or a
 *   `sessionRef` a prepared Execution can never resume — is rejected rather
 *   than silently stripped.
 */

const EGRESS_POLICY = { policyRevision: 'metadata-status-v1', activity: { mode: 'metadata-status', delivery: 'latest-value' }, reliable: { maxPendingEventsPerAgent: 256, maxPendingBytesPerAgent: 4194304, maxPendingBytesPerTenant: 16777216 }, transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' } } as const;
const CAPABILITIES = [AGENT_HOME_CONTRACT_CAPABILITY, AGENT_INPUT_PREPARATION_CAPABILITY, AGENT_EGRESS_POLICY_CAPABILITY, AGENT_EGRESS_RELIABLE_ACK_CAPABILITY, AGENT_EGRESS_FRESH_SESSION_CAPABILITY];
const AGENT_REF = { agentId: 'agent-prepared-1', profileRevision: 'profile-r1' } as const;

function preparedPayload() {
  return {
    policy: { mode: 'auto' as const, allowTools: [] },
    egressPolicy: EGRESS_POLICY,
    agentRef: AGENT_REF,
    requiredToolsets: ['team'],
    preparation: {
      reference: 'prep-record-1',
      requestDigest: 'request-digest-1',
      artifactDigest: 'envelope-digest-1',
    },
  };
}

describe('hosted prepared-Execution dispatch', () => {
  it('refuses a device that advertises the Agent-home contract but cannot prepare, before any mailbox or task row', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY],
    });

    await expect(
      harness.cloud.enqueuePreparedOffer(TENANT_A, device.deviceId, {
        taskId: 'prepared-task-refused',
        payload: preparedPayload(),
      }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });

    expect(
      (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 })).messages,
    ).toHaveLength(0);
    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'prepared-task-refused')).toBeUndefined();
  });

  it('refuses a device that declares only v5 input preparation, before any mailbox or task row', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [...CAPABILITIES.filter(c => c !== AGENT_INPUT_PREPARATION_CAPABILITY), 'agent-input-preparation-v5'],
    });

    await expect(
      harness.cloud.enqueuePreparedOffer(TENANT_A, device.deviceId, {
        taskId: 'prepared-task-skewed',
        payload: preparedPayload(),
      }),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect(
      (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 })).messages,
    ).toHaveLength(0);
    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'prepared-task-skewed')).toBeUndefined();
  });

  it('enqueues one envelope carrying the preparation verbatim, and binds the task attempt to the Agent', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: CAPABILITIES,
    });

    const offered = await harness.cloud.enqueuePreparedOffer(TENANT_A, device.deviceId, {
      taskId: 'prepared-task-1',
      payload: preparedPayload(),
    });

    const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 });
    expect(page.messages).toHaveLength(1);
    const decoded = decodeEnvelope(page.messages[0]!.body);
    expect(decoded).toEqual(offered.envelope);
    expect(decoded.type).toBe('task.offer_prepared');
    if (decoded.type !== 'task.offer_prepared') throw new Error('unreachable');
    expect(decoded.payload.preparation).toEqual({
      reference: 'prep-record-1',
      requestDigest: 'request-digest-1',
      artifactDigest: 'envelope-digest-1',
    });
    // The two omissions are structural, and survive the round trip as omissions.
    expect('instruction' in decoded.payload).toBe(false);
    expect('sessionRef' in decoded.payload).toBe(false);
    expect(offered.attempt.agentRef).toEqual(AGENT_REF);
    expect((await harness.cloud.readTaskAttempt(TENANT_A, 'prepared-task-1'))?.agentRef).toEqual(AGENT_REF);
  });

  it('rejects an instruction or a sessionRef smuggled onto the prepared lane instead of stripping it', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: CAPABILITIES,
    });

    for (const [taskId, extra] of [
      ['prepared-task-instruction', { instruction: 'compile something else' }],
      ['prepared-task-session', { sessionRef: 'session-from-an-earlier-turn' }],
    ] as const) {
      await expect(
        harness.cloud.enqueuePreparedOffer(TENANT_A, device.deviceId, {
          taskId,
          payload: { ...preparedPayload(), ...extra } as never,
        }),
      ).rejects.toThrow();
      expect(await harness.cloud.readTaskAttempt(TENANT_A, taskId)).toBeUndefined();
    }
    expect(
      (await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 })).messages,
    ).toHaveLength(0);
  });
});


describe('prepared egress admission and server context', () => {
  const requirement = { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 10_000 } as const;
  it.each([AGENT_EGRESS_POLICY_CAPABILITY, AGENT_EGRESS_RELIABLE_ACK_CAPABILITY, AGENT_EGRESS_FRESH_SESSION_CAPABILITY, AGENT_MESSAGE_EGRESS_CAPABILITY])('refuses missing %s without an attempt or mailbox row', async missing => {
    const h = createHarness();
    const d = await h.pairDevice(TENANT_A);
    await h.stores.devices.recordCapabilities(TENANT_A, { deviceId: d.deviceId, capabilities: [...CAPABILITIES, AGENT_MESSAGE_EGRESS_CAPABILITY].filter(c => c !== missing) });
    await expect(h.cloud.enqueuePreparedOffer(TENANT_A, d.deviceId, {
      taskId: 'missing-cap', payload: { ...preparedPayload(), messageEgress: requirement },
      agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'turn' },
    })).rejects.toMatchObject({ code: 'agent_capability_missing' });
    expect((await h.core.mailbox.readAfter(TENANT_A, { deviceId: d.deviceId, afterSeq: 0, limit: 10 })).messages).toHaveLength(0);
    expect(await h.cloud.readTaskAttempt(TENANT_A, 'missing-cap')).toBeUndefined();
  });

  it('persists immutable message context server-side, keeping it out of the prepared wire', async () => {
    const h = createHarness();
    const d = await h.pairDevice(TENANT_A);
    await h.stores.devices.recordCapabilities(TENANT_A, { deviceId: d.deviceId, capabilities: [...CAPABILITIES, AGENT_MESSAGE_EGRESS_CAPABILITY] });
    const input = { taskId: 'prepared-message', payload: { ...preparedPayload(), messageEgress: requirement }, agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'turn' } };
    const offered = await h.cloud.enqueuePreparedOffer(TENANT_A, d.deviceId, input);
    expect(offered.envelope.payload).toMatchObject({ egressPolicy: EGRESS_POLICY, messageEgress: requirement });
    expect(offered.envelope.payload).not.toHaveProperty('agentMessageContext');
    const receipt = await h.stores.receipts.get(TENANT_A, `agent-message-offer:${d.deviceId}:${input.taskId}`);
    expect(JSON.parse(receipt!.body)).toEqual({ agentRef: AGENT_REF, requirement, context: input.agentMessageContext });
    await expect(h.cloud.enqueuePreparedOffer(TENANT_A, d.deviceId, { ...input, agentMessageContext: { destinationBinding: 'different' } })).rejects.toMatchObject({ code: 'agent_task_already_exists' });
    expect((await h.core.mailbox.readAfter(TENANT_A, { deviceId: d.deviceId, afterSeq: 0, limit: 10 })).messages).toHaveLength(1);
  });

  it('rejects absent required egress policy and incoherent message context before any mailbox write', async () => {
    const h = createHarness();
    const d = await h.pairDevice(TENANT_A);
    await h.stores.devices.recordCapabilities(TENANT_A, { deviceId: d.deviceId, capabilities: [...CAPABILITIES, AGENT_MESSAGE_EGRESS_CAPABILITY] });
    for (const input of [
      { payload: { ...preparedPayload(), egressPolicy: undefined } },
      { payload: preparedPayload(), agentMessageContext: { destinationBinding: 'conversation' } },
      { payload: { ...preparedPayload(), messageEgress: requirement } },
    ]) await expect(h.cloud.enqueuePreparedOffer(TENANT_A, d.deviceId, input as never)).rejects.toThrow();
    expect((await h.core.mailbox.readAfter(TENANT_A, { deviceId: d.deviceId, afterSeq: 0, limit: 10 })).messages).toHaveLength(0);
  });
});
