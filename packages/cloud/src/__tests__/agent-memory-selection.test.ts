import {
  AGENT_MEMORY_READ_IF_ADMITTED_CAPABILITY,
  AGENT_MEMORY_READ_WRITE_IF_ADMITTED_CAPABILITY,
  AGENT_MEMORY_SELECTION_CAPABILITY,
  decodeEnvelope,
  type AgentEgressPolicy,
  type AgentMemorySelection,
} from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { TENANT_A, createHarness, type CloudHarness } from './support/harness';

/**
 * #614: an ordinary Agent offer that selects its own `agentMemory` reaches only
 * a device that advertises `agent-memory-selection`. The Agent offers are
 * strict, so an older daemon could not accept the field; the kernel refuses
 * before it creates the task or appends to the mailbox.
 */

const AGENT_REF = { agentId: 'memory-agent', profileRevision: 'profile-r1' } as const;
const POLICY: AgentEgressPolicy = {
  policyRevision: 'policy-r1',
  activity: { delivery: 'latest-value' as const, maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
  transfers: { workspace: 'disabled' as const, transcript: 'disabled' as const, artifact: 'disabled' as const },
};
const BASE_CAPABILITIES = [
  'agent-home-contract',
  'agent-egress-policy',
  'agent-egress-reliable-ack',
  'agent-egress-fresh-session',
  'terminal-projection-selection',
];

type MemoryOffer = (harness: CloudHarness, deviceId: string, taskId: string) => Promise<unknown>;

const memoryOffersWith = (agentMemory: AgentMemorySelection): ReadonlyArray<readonly [string, MemoryOffer]> => [
  ['enqueueAgentOffer', (harness, deviceId, taskId) => harness.cloud.enqueueAgentOffer(TENANT_A, deviceId, {
    taskId,
    payload: { instruction: 'plan only', agentRef: AGENT_REF, session: { mode: 'resume', sessionRef: 'memory-session' }, agentMemory },
  })],
  ['enqueueAgentEgressOffer', (harness, deviceId, taskId) => harness.cloud.enqueueAgentEgressOffer(TENANT_A, deviceId, {
    taskId,
    payload: { instruction: 'plan only', agentRef: AGENT_REF, session: { mode: 'resume', sessionRef: 'memory-session' }, egressPolicy: POLICY, agentMemory },
  })],
  ['submitAgentExecution', (harness, deviceId, taskId) => harness.cloud.submitAgentExecution(TENANT_A, { deviceId,
    taskId,
    payload: { instruction: 'plan only', runtime: 'codex', terminalProjection: { mode: 'none' }, agentRef: AGENT_REF, session: { mode: 'fresh' }, egressPolicy: POLICY, agentMemory },
  })],
];
const memoryOffers = memoryOffersWith('none');

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

describe('hosted per-task Agent memory selection (#614)', () => {
  it.each(memoryOffers)('%s refuses agentMemory to a device without agent-memory-selection before task or mailbox state', async (_name, enqueue) => {
    const { harness, deviceId } = await deviceWith(BASE_CAPABILITIES);

    await expect(enqueue(harness, deviceId, 'memory-refused')).rejects.toMatchObject({
      code: 'agent_capability_missing',
      message: expect.stringContaining(AGENT_MEMORY_SELECTION_CAPABILITY),
    });
    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'memory-refused')).toBeUndefined();
    expect(await mailboxTypes(harness, deviceId)).toEqual([]);
  });

  it.each(memoryOffers)('%s delivers agentMemory to a device that advertises agent-memory-selection', async (_name, enqueue) => {
    const { harness, deviceId } = await deviceWith([...BASE_CAPABILITIES, AGENT_MEMORY_SELECTION_CAPABILITY]);

    await enqueue(harness, deviceId, 'memory-admitted');
    const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId, afterSeq: 0, limit: 10 });
    expect(page.messages).toHaveLength(1);
    expect(decodeEnvelope(page.messages[0]!.body).payload).toMatchObject({ agentMemory: 'none' });
  });

  it('still admits an Agent offer without agentMemory to a device without agent-memory-selection', async () => {
    const { harness, deviceId } = await deviceWith(['agent-home-contract']);

    await harness.cloud.enqueueAgentOffer(TENANT_A, deviceId, {
      taskId: 'memory-absent',
      payload: { instruction: 'continue', agentRef: AGENT_REF, session: { mode: 'resume', sessionRef: 'memory-session' } },
    });
    expect(await mailboxTypes(harness, deviceId)).toEqual(['task.offer']);
  });
});

describe('hosted agentMemory read-if-admitted (#815)', () => {
  const readIfAdmitted = memoryOffersWith('read-if-admitted');
  const selection = [...BASE_CAPABILITIES, AGENT_MEMORY_SELECTION_CAPABILITY];

  it.each(readIfAdmitted)('%s refuses read-if-admitted to a device without agent-memory-read-if-admitted before task or mailbox state', async (_name, enqueue) => {
    const { harness, deviceId } = await deviceWith(selection);

    await expect(enqueue(harness, deviceId, 'memory-refused')).rejects.toMatchObject({
      code: 'agent_capability_missing',
      message: expect.stringContaining(AGENT_MEMORY_READ_IF_ADMITTED_CAPABILITY),
    });
    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'memory-refused')).toBeUndefined();
    expect(await mailboxTypes(harness, deviceId)).toEqual([]);
  });

  it.each(readIfAdmitted)('%s delivers read-if-admitted to a device that advertises both flags', async (_name, enqueue) => {
    const { harness, deviceId } = await deviceWith([...selection, AGENT_MEMORY_READ_IF_ADMITTED_CAPABILITY]);

    await enqueue(harness, deviceId, 'memory-admitted');
    const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId, afterSeq: 0, limit: 10 });
    expect(page.messages).toHaveLength(1);
    expect(decodeEnvelope(page.messages[0]!.body).payload).toMatchObject({ agentMemory: 'read-if-admitted' });
  });
});

describe('hosted agentMemory read-write-if-admitted (#833)', () => {
  const readWriteIfAdmitted = memoryOffersWith('read-write-if-admitted');
  const selection = [...BASE_CAPABILITIES, AGENT_MEMORY_SELECTION_CAPABILITY];

  it.each(readWriteIfAdmitted)('%s refuses read-write-if-admitted to a device without agent-memory-read-write-if-admitted before task or mailbox state', async (_name, enqueue) => {
    // The read-if-admitted flag does not stand in for this one.
    const { harness, deviceId } = await deviceWith([...selection, AGENT_MEMORY_READ_IF_ADMITTED_CAPABILITY]);

    await expect(enqueue(harness, deviceId, 'memory-refused')).rejects.toMatchObject({
      code: 'agent_capability_missing',
      message: expect.stringContaining(AGENT_MEMORY_READ_WRITE_IF_ADMITTED_CAPABILITY),
    });
    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'memory-refused')).toBeUndefined();
    expect(await mailboxTypes(harness, deviceId)).toEqual([]);
  });

  it.each(readWriteIfAdmitted)('%s delivers read-write-if-admitted to a device that advertises both flags', async (_name, enqueue) => {
    const { harness, deviceId } = await deviceWith([...selection, AGENT_MEMORY_READ_WRITE_IF_ADMITTED_CAPABILITY]);

    await enqueue(harness, deviceId, 'memory-admitted');
    const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId, afterSeq: 0, limit: 10 });
    expect(page.messages).toHaveLength(1);
    expect(decodeEnvelope(page.messages[0]!.body).payload).toMatchObject({ agentMemory: 'read-write-if-admitted' });
  });
});
