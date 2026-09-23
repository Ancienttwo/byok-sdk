import { AGENT_INPUT_PREPARATION_CAPABILITY, decodeEnvelope } from '@byok-sdk/protocol';
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

const AGENT_REF = { agentId: 'agent-prepared-1', profileRevision: 'profile-r1' } as const;

function preparedPayload() {
  return {
    policy: { mode: 'auto' as const },
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

  it('refuses a device that declares only the retired unversioned token, before any mailbox or task row', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY, 'agent-input-preparation'],
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
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY, AGENT_INPUT_PREPARATION_CAPABILITY],
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
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY, AGENT_INPUT_PREPARATION_CAPABILITY],
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
