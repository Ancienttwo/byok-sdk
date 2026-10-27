import { describe, expect, it, vi } from 'vitest';
import { RESULT_SCHEMA_MAX_BYTES, checkResultSchema } from '@byok-sdk/protocol';
import { AgentExecutionInputSchema } from '../agent-execution';
import { TENANT_A, createHarness } from './support/harness';

/** A subset-valid frozen outcome schema (wire v3 `terminalProjection.schema`). */
const RESULT_SCHEMA = {
  type: 'object', properties: { answer: { type: 'string', maxLength: 200 } }, required: ['answer'], additionalProperties: false,
} as const;
const RESULT_CAPABILITIES = [
  'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'terminal-projection-selection',
];

const input = {
  taskId: 'turn-execution-1', deviceId: 'device',
  payload: { instruction: 'context plus current input', runtime: 'codex',
    agentRef: { agentId: 'agent', profileRevision: 'revision' },
    session: { mode: 'fresh' },
    egressPolicy: { policyRevision: 'policy', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
      reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
      transfers: { workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] }, transcript: 'disabled', artifact: 'disabled' } },
    messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 },
    terminalProjection: { mode: 'none' } },
  agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'turn' },
};

describe('fresh Agent execution submission', () => {
  it.each(['taskId', 'deviceId', 'runtime', 'agentRef', 'egressPolicy', 'terminalProjection', 'session', 'resumeSession', 'sessionRef', 'unknownField'])('rejects invalid %s before any attempt or mailbox write', async (field) => {
    const harness = createHarness();
    const candidate = structuredClone(input) as any;
    if (field === 'sessionRef') candidate.payload.sessionRef = 'old-session';
    else if (field === 'resumeSession') candidate.payload.session = { mode: 'resume', sessionRef: 'old-session' };
    else if (field === 'unknownField') candidate.payload.unknownField = 'undeclared';
    else if (field in candidate) delete candidate[field];
    else delete candidate.payload[field];
    expect(AgentExecutionInputSchema.safeParse(candidate).success).toBe(false);
    await expect(harness.cloud.submitAgentExecution(TENANT_A, candidate)).rejects.toThrow();
    expect(await harness.cloud.readTaskAttempt(TENANT_A, input.taskId)).toBeUndefined();
    expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: input.deviceId, afterSeq: 0 })).messages).toEqual([]);
  });

  it.each(['context', 'messageEgress'])('rejects an unmatched %s before any durable admission', async (field) => {
    const harness = createHarness({ agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
    const record = vi.spyOn(harness.stores.receipts, 'record');
    const candidate = structuredClone(input) as any;
    if (field === 'context') delete candidate.agentMessageContext;
    else delete candidate.payload.messageEgress;
    await expect(harness.cloud.submitAgentExecution(TENANT_A, candidate)).rejects.toThrow();
    expect(record).not.toHaveBeenCalled();
    expect(await harness.cloud.readTaskAttempt(TENANT_A, input.taskId)).toBeUndefined();
    expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: input.deviceId, afterSeq: 0 })).messages).toEqual([]);
  });

  it('refuses a missing consumer before any durable admission', async () => {
    const harness = createHarness();
    const record = vi.spyOn(harness.stores.receipts, 'record');
    await expect(harness.cloud.submitAgentExecution(TENANT_A, AgentExecutionInputSchema.parse(input)))
      .rejects.toThrow('Agent execution with messageEgress requires a registered Agent message consumer');
    expect(record).not.toHaveBeenCalled();
    expect(await harness.cloud.readTaskAttempt(TENANT_A, input.taskId)).toBeUndefined();
    expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: input.deviceId, afterSeq: 0 })).messages).toEqual([]);
  });

  it('accepts a result-document execution without messageEgress or a registered consumer', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: [
      'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'terminal-projection-selection',
    ] });
    const { messageEgress: _messageEgress, ...payload } = input.payload;
    const persisted = AgentExecutionInputSchema.parse({ taskId: input.taskId, deviceId: device.deviceId,
      payload: { ...payload, terminalProjection: { mode: 'result-document', contract: 'test.result.v1', schema: RESULT_SCHEMA } } });
    const offered = await harness.cloud.submitAgentExecution(TENANT_A, persisted);
    expect(offered.taskId).toBe(input.taskId);
    expect(offered.envelope).toMatchObject({ type: 'task.offer',
      payload: { terminalProjection: persisted.payload.terminalProjection } });
    expect(offered.envelope.payload).not.toHaveProperty('messageEgress');
    expect(await harness.cloud.readTaskOffer(TENANT_A, input.taskId)).toMatchObject({ delivered: true, payload: persisted.payload });
    expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 })).messages).toHaveLength(1);
  });

  it('refuses a result-document terminalProjection without a frozen schema before any durable admission', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: RESULT_CAPABILITIES });
    const { messageEgress: _messageEgress, ...payload } = input.payload;
    const candidate = { taskId: input.taskId, deviceId: device.deviceId,
      payload: { ...payload, terminalProjection: { mode: 'result-document', contract: 'test.result.v1' } } };
    expect(AgentExecutionInputSchema.safeParse(candidate).success).toBe(false);
    await expect(harness.cloud.submitAgentExecution(TENANT_A, candidate as never)).rejects.toThrow();
    expect(await harness.cloud.readTaskAttempt(TENANT_A, input.taskId)).toBeUndefined();
    expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 })).messages).toEqual([]);
  });

  it.each([
    ['a keyword outside the subset', { ...RESULT_SCHEMA, properties: { answer: { type: 'string', pattern: '^a' } } }],
    ['a non-object root', { type: 'array', items: { type: 'string' } }],
    ['additionalProperties other than false', { ...RESULT_SCHEMA, additionalProperties: true }],
    ['a schema over 16 KiB', { ...RESULT_SCHEMA, description: 'x'.repeat(RESULT_SCHEMA_MAX_BYTES) }],
  ])('refuses a result-document schema with %s before any durable admission', async (_label, schema) => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: RESULT_CAPABILITIES });
    const record = vi.spyOn(harness.stores.receipts, 'record');
    expect(checkResultSchema(schema).ok).toBe(false);
    const { messageEgress: _messageEgress, ...payload } = input.payload;
    const candidate = { taskId: input.taskId, deviceId: device.deviceId,
      payload: { ...payload, terminalProjection: { mode: 'result-document', contract: 'test.result.v1', schema } } };
    expect(AgentExecutionInputSchema.safeParse(candidate).success).toBe(false);
    await expect(harness.cloud.submitAgentExecution(TENANT_A, candidate as never)).rejects.toThrow(/result schema/);
    expect(record).not.toHaveBeenCalled();
    expect(await harness.cloud.readTaskAttempt(TENANT_A, input.taskId)).toBeUndefined();
    expect(await harness.cloud.readTaskOffer(TENANT_A, input.taskId)).toBeUndefined();
    expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 })).messages).toEqual([]);
  });

  it('dispatches the persisted shape as fresh and retains original task identity', async () => {
    const harness = createHarness({ agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: [
      'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'agent-message-egress', 'terminal-projection-selection',
    ] });
    const prepared = AgentExecutionInputSchema.parse({ ...input, deviceId: device.deviceId });
    const persisted = JSON.parse(JSON.stringify(prepared));
    const offered = await harness.cloud.submitAgentExecution(TENANT_A, persisted);
    expect(offered.taskId).toBe(input.taskId);
    expect(offered.envelope.type).toBe('task.offer');
    expect(offered.envelope.payload).toMatchObject({ session: { mode: 'fresh' } });
    expect(offered.envelope.payload).not.toHaveProperty('sessionRef');
    expect(offered.envelope.payload).not.toHaveProperty('agentMessageContext');
    expect(await harness.cloud.readTaskOffer(TENANT_A, input.taskId)).toMatchObject({ delivered: true, payload: prepared.payload });
    await expect(harness.cloud.submitAgentExecution(TENANT_A, persisted)).rejects.toMatchObject({ code: 'agent_task_already_exists' });
    expect(await harness.cloud.readTaskOffer(TENANT_A, input.taskId)).toMatchObject({ delivered: true, payload: prepared.payload });
    expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 })).messages).toHaveLength(1);
  });

  it('accepts a harnessId-only fresh payload without runtime', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [
        'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session',
        'terminal-projection-selection', 'toolset-selection', 'custom-harness',
      ],
      harnesses: [{ id: 'acme-harness', version: '1.0.0', capabilities: { steer: true, resume: true, approvalInteractive: false } }],
    });
    const { messageEgress: _messageEgress, runtime: _runtime, ...payload } = input.payload;
    const persisted = AgentExecutionInputSchema.parse({
      taskId: input.taskId,
      deviceId: device.deviceId,
      payload: { ...payload, harnessId: 'acme-harness', requiredToolsets: ['example.tools'], terminalProjection: { mode: 'none' } },
    });
    expect(persisted.payload).not.toHaveProperty('runtime');
    expect(persisted.payload.harnessId).toBe('acme-harness');
    const offered = await harness.cloud.submitAgentExecution(TENANT_A, persisted);
    expect(offered.envelope.payload).toMatchObject({ harnessId: 'acme-harness', requiredToolsets: ['example.tools'] });
    expect(offered.envelope.payload).not.toHaveProperty('runtime');
    expect(offered.envelope.payload).not.toHaveProperty('dispatchSelection');
  });

  it('rejects harnessId together with runtime or dispatchSelection', () => {
    const { messageEgress: _messageEgress, runtime: _runtime, ...payload } = input.payload;
    expect(AgentExecutionInputSchema.safeParse({
      taskId: input.taskId, deviceId: 'device',
      payload: { ...payload, runtime: 'codex', harnessId: 'acme-harness', terminalProjection: { mode: 'none' } },
    }).success).toBe(false);
    expect(AgentExecutionInputSchema.safeParse({
      taskId: input.taskId, deviceId: 'device',
      payload: {
        ...payload, harnessId: 'acme-harness',
        dispatchSelection: { lane: 'subscription', runtimeId: 'codex', providerId: null, modelId: 'gpt-5' },
        terminalProjection: { mode: 'none' },
      },
    }).success).toBe(false);
  });

  describe('selection admission', () => {
    const BASE_CAPABILITIES = [
      'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'terminal-projection-selection',
    ];
    const SELECTION = { lane: 'subscription', runtimeId: 'codex', providerId: null, modelId: 'gpt-5' } as const;
    async function setup(capabilities: string[]) {
      const harness = createHarness();
      const device = await harness.pairDevice(TENANT_A);
      await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities });
      const { messageEgress: _messageEgress, ...payload } = input.payload;
      return { harness, device, payload };
    }
    async function expectNothingWritten(harness: Awaited<ReturnType<typeof setup>>['harness'], deviceId: string) {
      expect(await harness.cloud.readTaskAttempt(TENANT_A, input.taskId)).toBeUndefined();
      expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId, afterSeq: 0 })).messages).toEqual([]);
    }

    it('refuses dispatchSelection without the dispatch-selection capability', async () => {
      const { harness, device, payload } = await setup(BASE_CAPABILITIES);
      const candidate = AgentExecutionInputSchema.parse({ taskId: input.taskId, deviceId: device.deviceId,
        payload: { ...payload, dispatchSelection: SELECTION, terminalProjection: { mode: 'none' } } });
      await expect(harness.cloud.submitAgentExecution(TENANT_A, candidate))
        .rejects.toMatchObject({ code: 'agent_capability_missing', message: expect.stringContaining('dispatch-selection') });
      await expectNothingWritten(harness, device.deviceId);
    });

    it('refuses requiredToolsets without the toolset-selection capability', async () => {
      const { harness, device, payload } = await setup(BASE_CAPABILITIES);
      const candidate = AgentExecutionInputSchema.parse({ taskId: input.taskId, deviceId: device.deviceId,
        payload: { ...payload, requiredToolsets: ['example.tools'], terminalProjection: { mode: 'none' } } });
      await expect(harness.cloud.submitAgentExecution(TENANT_A, candidate))
        .rejects.toMatchObject({ code: 'agent_capability_missing', message: expect.stringContaining('toolset-selection') });
      await expectNothingWritten(harness, device.deviceId);
    });

    it('refuses a runtime that differs from dispatchSelection.runtimeId', async () => {
      const { harness, device, payload } = await setup([...BASE_CAPABILITIES, 'dispatch-selection', 'toolset-selection']);
      const candidate = AgentExecutionInputSchema.parse({ taskId: input.taskId, deviceId: device.deviceId,
        payload: { ...payload, runtime: 'claude', dispatchSelection: SELECTION, terminalProjection: { mode: 'none' } } });
      await expect(harness.cloud.submitAgentExecution(TENANT_A, candidate))
        .rejects.toMatchObject({ code: 'coordination_input_invalid', message: expect.stringMatching(/claude.*codex/) });
      await expectNothingWritten(harness, device.deviceId);
    });

    it('accepts a matching runtime when the device advertises both capabilities', async () => {
      const { harness, device, payload } = await setup([...BASE_CAPABILITIES, 'dispatch-selection', 'toolset-selection']);
      const candidate = AgentExecutionInputSchema.parse({ taskId: input.taskId, deviceId: device.deviceId,
        payload: { ...payload, dispatchSelection: SELECTION, requiredToolsets: ['example.tools'], terminalProjection: { mode: 'none' } } });
      const offered = await harness.cloud.submitAgentExecution(TENANT_A, candidate);
      expect(offered.taskId).toBe(input.taskId);
      expect(offered.envelope.payload).toMatchObject({ dispatchSelection: SELECTION, requiredToolsets: ['example.tools'] });
      expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 })).messages).toHaveLength(1);
    });
  });
});
