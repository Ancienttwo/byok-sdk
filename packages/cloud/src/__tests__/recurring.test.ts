import { describe, expect, it } from 'vitest';
import { RecurringExecutionInputSchema } from '../recurring';
import { TENANT_A, createHarness } from './support/harness';

const input = {
  taskId: 'turn-execution-1', deviceId: 'device',
  payload: { instruction: 'context plus current input', runtime: 'codex', policy: { mode: 'auto' },
    agentRef: { agentId: 'agent', profileRevision: 'revision' },
    egressPolicy: { policyRevision: 'policy', activity: { mode: 'metadata-status', delivery: 'latest-value' },
      reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
      transfers: { workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] }, transcript: 'disabled', artifact: 'disabled' } },
    messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 },
    terminalProjection: { mode: 'none' } },
  agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'turn' },
};

describe('strict recurring execution submission', () => {
  it.each(['taskId', 'deviceId', 'agentMessageContext', 'runtime', 'messageEgress', 'terminalProjection', 'sessionRef'])('rejects invalid %s before any attempt or mailbox write', async (field) => {
    const harness = createHarness();
    const candidate = structuredClone(input) as any;
    if (field === 'sessionRef') candidate.payload.sessionRef = 'old-session';
    else if (field in candidate) delete candidate[field];
    else delete candidate.payload[field];
    expect(RecurringExecutionInputSchema.safeParse(candidate).success).toBe(false);
    await expect(harness.cloud.submitRecurringExecution(TENANT_A, candidate)).rejects.toThrow();
    expect(await harness.cloud.readTaskAttempt(TENANT_A, input.taskId)).toBeUndefined();
    expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: input.deviceId, afterSeq: 0 })).messages).toEqual([]);
  });

  it('refuses a missing consumer before any durable admission', async () => {
    const harness = createHarness();
    await expect(harness.cloud.submitRecurringExecution(TENANT_A, RecurringExecutionInputSchema.parse(input)))
      .rejects.toThrow('Recurring execution requires a registered Agent message consumer');
    expect(await harness.cloud.readTaskAttempt(TENANT_A, input.taskId)).toBeUndefined();
    expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: input.deviceId, afterSeq: 0 })).messages).toEqual([]);
  });

  it('dispatches the persisted shape as fresh and retains original task identity', async () => {
    const harness = createHarness({ agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: [
      'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'agent-message-egress', 'terminal-projection-selection',
    ] });
    const prepared = RecurringExecutionInputSchema.parse({ ...input, deviceId: device.deviceId });
    const persisted = JSON.parse(JSON.stringify(prepared));
    const offered = await harness.cloud.submitRecurringExecution(TENANT_A, persisted);
    expect(offered.taskId).toBe(input.taskId);
    expect(offered.envelope.type).toBe('task.offer_for_agent_with_egress_fresh');
    expect(offered.envelope.payload).not.toHaveProperty('sessionRef');
    expect(offered.envelope.payload).not.toHaveProperty('agentMessageContext');
    expect(await harness.cloud.readTaskOffer(TENANT_A, input.taskId)).toMatchObject({ delivered: true, payload: prepared.payload });
    await expect(harness.cloud.submitRecurringExecution(TENANT_A, persisted)).rejects.toThrow();
    expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 })).messages).toHaveLength(1);
  });
});
