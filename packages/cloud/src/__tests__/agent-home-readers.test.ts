import { AGENT_HOME_READERS_CAPABILITY, decodeEnvelope, type AgentEgressPolicy } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { TENANT_A, createHarness, type CloudHarness } from './support/harness';

/**
 * #317: a `homeAccess: 'memory-reader'` Agent offer reaches only a device that
 * advertises `agent-home-readers`. The Agent offers are strict, so an older
 * daemon could not accept the field; the kernel refuses before it creates the
 * task or appends to the mailbox, as it does for every other Agent capability.
 */

const AGENT_REF = { agentId: 'reader-agent', profileRevision: 'profile-r1' } as const;
const POLICY: AgentEgressPolicy = {
  policyRevision: 'policy-r1',
  activity: { delivery: 'latest-value' as const, maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
  transfers: {
    workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] },
    transcript: 'disabled' as const,
    artifact: 'disabled' as const,
  },
};
const BASE_CAPABILITIES = [
  'agent-home-contract',
  'agent-egress-policy',
  'agent-egress-reliable-ack',
  'agent-egress-fresh-session',
];

type ReaderOffer = (harness: CloudHarness, deviceId: string, taskId: string) => Promise<unknown>;

const readerOffers: ReadonlyArray<readonly [string, ReaderOffer]> = [
  ['enqueueAgentOffer', (harness, deviceId, taskId) => harness.cloud.enqueueAgentOffer(TENANT_A, deviceId, {
    taskId,
    payload: { instruction: 'read memory', agentRef: AGENT_REF, homeAccess: 'memory-reader' },
  })],
  ['enqueueAgentEgressOffer', (harness, deviceId, taskId) => harness.cloud.enqueueAgentEgressOffer(TENANT_A, deviceId, {
    taskId,
    payload: {
      instruction: 'read memory', agentRef: AGENT_REF, sessionRef: 'reader-session', egressPolicy: POLICY, homeAccess: 'memory-reader',
    },
  })],
  ['enqueueFreshAgentEgressOffer', (harness, deviceId, taskId) => harness.cloud.enqueueFreshAgentEgressOffer(TENANT_A, deviceId, {
    taskId,
    payload: { instruction: 'read memory', agentRef: AGENT_REF, egressPolicy: POLICY, homeAccess: 'memory-reader' },
  })],
];

async function deviceWith(capabilities: readonly string[]): Promise<{ harness: CloudHarness; deviceId: string }> {
  const harness = createHarness();
  const device = await harness.pairDevice(TENANT_A);
  await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: [...capabilities] });
  return { harness, deviceId: device.deviceId };
}

async function mailboxTypes(harness: CloudHarness, deviceId: string): Promise<string[]> {
  const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId, afterSeq: 0, limit: 10 });
  return page.messages.map((row) => decodeEnvelope(row.body).type);
}

describe('hosted memory-reader Agent offers (#317)', () => {
  it.each(readerOffers)('%s refuses a reader offer to a device without agent-home-readers before task or mailbox state', async (_name, enqueue) => {
    const { harness, deviceId } = await deviceWith(BASE_CAPABILITIES);

    await expect(enqueue(harness, deviceId, 'reader-refused')).rejects.toMatchObject({
      code: 'agent_capability_missing',
      message: expect.stringContaining(AGENT_HOME_READERS_CAPABILITY),
    });
    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'reader-refused')).toBeUndefined();
    expect(await mailboxTypes(harness, deviceId)).toEqual([]);
  });

  it.each(readerOffers)('%s delivers homeAccess to a device that advertises agent-home-readers', async (_name, enqueue) => {
    const { harness, deviceId } = await deviceWith([...BASE_CAPABILITIES, AGENT_HOME_READERS_CAPABILITY]);

    await enqueue(harness, deviceId, 'reader-admitted');
    const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId, afterSeq: 0, limit: 10 });
    expect(page.messages).toHaveLength(1);
    expect(decodeEnvelope(page.messages[0]!.body).payload).toMatchObject({ homeAccess: 'memory-reader' });
  });

  it('still admits a writer Agent offer to a device without agent-home-readers', async () => {
    const { harness, deviceId } = await deviceWith(['agent-home-contract']);

    await harness.cloud.enqueueAgentOffer(TENANT_A, deviceId, {
      taskId: 'writer-admitted',
      payload: { instruction: 'write memory', agentRef: AGENT_REF },
    });
    expect(await mailboxTypes(harness, deviceId)).toEqual(['task.offer_for_agent']);
  });
});
