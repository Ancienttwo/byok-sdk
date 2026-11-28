import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { HARNESS_SERVICE_TIER_CAPABILITY, RESULT_SCHEMA_MAX_BYTES, SKILL_SELECTION_CAPABILITY, checkResultSchema } from '@byok-sdk/protocol';
import { AgentExecutionInputSchema } from '../agent-execution';
import { TEST_HARNESSES, TENANT_A, createHarness } from './support/harness';

/** A subset-valid frozen outcome schema (wire v3 `terminalProjection.schema`). */
const RESULT_SCHEMA = {
  type: 'object', properties: { answer: { type: 'string', maxLength: 200 } }, required: ['answer'], additionalProperties: false,
} as const;
const RESULT_CAPABILITIES = [
  'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'terminal-projection-selection',
];

const input = {
  taskId: 'turn-execution-1', deviceId: 'device',
  payload: { instruction: 'context plus current input', target: { lane: 'harness', harnessId: 'codex', selection: { mode: 'device-default' } },
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
  it.each(['taskId', 'deviceId', 'target', 'agentRef', 'egressPolicy', 'terminalProjection', 'session', 'resumeSession', 'sessionRef', 'unknownField'])('rejects invalid %s before any attempt or mailbox write', async (field) => {
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
    if (field === 'messageEgress') {
      await expect(harness.cloud.submitAgentExecution(TENANT_A, candidate))
        .rejects.toMatchObject({ code: 'coordination_input_invalid', message: 'agentMessageContext requires messageEgress' });
    }
    expect(record).not.toHaveBeenCalled();
    expect(await harness.cloud.readTaskAttempt(TENANT_A, input.taskId)).toBeUndefined();
    expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: input.deviceId, afterSeq: 0 })).messages).toEqual([]);
  });

  it('refuses a missing consumer before any durable admission', async () => {
    const harness = createHarness();
    const record = vi.spyOn(harness.stores.receipts, 'record');
    await expect(harness.cloud.submitAgentExecution(TENANT_A, AgentExecutionInputSchema.parse(input)))
      .rejects.toMatchObject({ name: 'ByokCloudError', code: 'agent_message_consumer_missing',
        message: 'Agent execution with messageEgress requires a registered Agent message consumer.' });
    expect(record).not.toHaveBeenCalled();
    expect(await harness.cloud.readTaskAttempt(TENANT_A, input.taskId)).toBeUndefined();
    expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: input.deviceId, afterSeq: 0 })).messages).toEqual([]);
  });

  it('accepts a result-document execution without messageEgress or a registered consumer', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, harnesses: TEST_HARNESSES, capabilities: [
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
    await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, harnesses: TEST_HARNESSES, capabilities: RESULT_CAPABILITIES });
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
    await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, harnesses: TEST_HARNESSES, capabilities: RESULT_CAPABILITIES });
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
    await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, harnesses: TEST_HARNESSES, capabilities: [
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

  it('accepts a harness-target fresh payload', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [
        'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session',
        'terminal-projection-selection', 'toolset-selection', 'custom-harness',
      ],
      harnesses: [{ id: 'acme-harness', version: '1.0.0', capabilities: { steer: true, resume: true, approvalInteractive: false, selectionModes: ['device-default'], effort: false } }],
    });
    const { messageEgress: _messageEgress, ...payload } = input.payload;
    const persisted = AgentExecutionInputSchema.parse({
      taskId: input.taskId,
      deviceId: device.deviceId,
      payload: { ...payload, target: { lane: 'harness', harnessId: 'acme-harness', selection: { mode: 'device-default' } }, requiredToolsets: ['example.tools'], terminalProjection: { mode: 'none' } },
    });
    expect(persisted.payload.target).toEqual({ lane: 'harness', harnessId: 'acme-harness', selection: { mode: 'device-default' } });
    const offered = await harness.cloud.submitAgentExecution(TENANT_A, persisted);
    expect(offered.envelope.payload).toMatchObject({ target: { lane: 'harness', harnessId: 'acme-harness', selection: { mode: 'device-default' } }, requiredToolsets: ['example.tools'] });
  });

  it('rejects a payload without a target or with an unknown lane', () => {
    const { messageEgress: _messageEgress, target: _target, ...payload } = input.payload;
    expect(AgentExecutionInputSchema.safeParse({
      taskId: input.taskId, deviceId: 'device',
      payload: { ...payload, terminalProjection: { mode: 'none' } },
    }).error?.issues).toMatchObject([{ path: ['payload', 'target'] }]);
    expect(AgentExecutionInputSchema.safeParse({
      taskId: input.taskId, deviceId: 'device',
      payload: { ...payload, target: { lane: 'model', harnessId: 'acme-harness' }, terminalProjection: { mode: 'none' } },
    }).error?.issues).toMatchObject([{ path: ['payload', 'target', 'lane'] }]);
  });

  describe('selection admission', () => {
    const BASE_CAPABILITIES = [
      'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'terminal-projection-selection',
    ];
    const SELECTION = { lane: 'harness', harnessId: 'codex', selection: { mode: 'subscription', modelId: 'gpt-5' } } as const;
    async function setup(capabilities: string[], advertiseSubscription = false) {
      const harness = createHarness();
      const device = await harness.pairDevice(TENANT_A);
      await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities, harnesses: advertiseSubscription
        ? [{ id: 'codex', capabilities: { selectionModes: ['subscription'], effort: false } }] : TEST_HARNESSES });
      const { messageEgress: _messageEgress, ...payload } = input.payload;
      return { harness, device, payload };
    }
    async function expectNothingWritten(harness: Awaited<ReturnType<typeof setup>>['harness'], deviceId: string) {
      expect(await harness.cloud.readTaskAttempt(TENANT_A, input.taskId)).toBeUndefined();
      expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId, afterSeq: 0 })).messages).toEqual([]);
    }

    it.each([
      'enqueueAgentOffer', 'enqueuePreparedOffer', 'enqueueAgentEgressOffer', 'submitAgentExecution', 'submitSealedAgentExecution',
    ] as const)('refuses every selection violation on %s before reads or writes, including retries', async lane => {
      const { harness, device, payload } = await setup(BASE_CAPABILITIES);
      const getDevice = vi.spyOn(harness.stores.devices, 'get');
      const record = vi.spyOn(harness.stores.receipts, 'record');
      const submit = lane.startsWith('submit');
      const prepared = lane === 'enqueuePreparedOffer';
      const base: Record<string, unknown> = { ...payload,
        session: submit || prepared ? { mode: 'fresh' } : { mode: 'resume', sessionRef: 'session' } };
      if (lane === 'enqueueAgentOffer') delete base.egressPolicy;
      if (lane.includes('Sealed')) base.sealing = { scopeId: 'scope', epoch: 1, categories: ['task-output'] };
      if (prepared) {
        delete base.instruction;
        base.preparation = { reference: 'prepared', requestDigest: 'digest' };
        base.agentMemory = 'none';
      }
      for (const [path, patch] of [
        ['agentMemory', { homeAccess: 'memory-reader', agentMemory: 'read-write' }],
      ] as const) {
        const candidate = { taskId: input.taskId, deviceId: device.deviceId, payload: { ...base, ...patch } };
        for (let retry = 0; retry < 2; retry++) {
          const call = submit ? harness.cloud[lane as 'submitAgentExecution'](TENANT_A, candidate as never)
            : harness.cloud[lane as 'enqueueAgentOffer'](TENANT_A, device.deviceId, candidate as never);
          await expect(call).rejects.toBeInstanceOf(ZodError);
          await expect(call).rejects.toMatchObject({ issues: [{ code: 'custom', path: submit ? ['payload', path] : [path] }] });
          expect(getDevice).not.toHaveBeenCalled();
          expect(record).not.toHaveBeenCalled();
          await expectNothingWritten(harness, device.deviceId);
        }
      }
    });

    it('refuses subscription selection when the executor advertises only device-default', async () => {
      const { harness, device, payload } = await setup(BASE_CAPABILITIES);
      const candidate = AgentExecutionInputSchema.parse({ taskId: input.taskId, deviceId: device.deviceId,
        payload: { ...payload, target: SELECTION, terminalProjection: { mode: 'none' } } });
      await expect(harness.cloud.submitAgentExecution(TENANT_A, candidate))
        .rejects.toMatchObject({ code: 'agent_capability_missing', message: expect.stringContaining('requested harness, selection mode and effort') });
      await expectNothingWritten(harness, device.deviceId);
    });

    it('names service tier when the harness omits requested fallback support', async () => {
      const capabilities = [...BASE_CAPABILITIES, HARNESS_SERVICE_TIER_CAPABILITY];
      const { harness, device, payload } = await setup(capabilities);
      await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities,
        harnesses: [{ id: 'codex', capabilities: { selectionModes: ['subscription'], effort: true, serviceTier: true } }],
      });
      const candidate = AgentExecutionInputSchema.parse({ taskId: input.taskId, deviceId: device.deviceId, payload: {
        ...payload, target: { ...SELECTION, serviceTier: 'fast', serviceTierFallback: 'default' }, terminalProjection: { mode: 'none' },
      } });
      await expect(harness.cloud.submitAgentExecution(TENANT_A, candidate)).rejects.toMatchObject({
        code: 'agent_capability_missing', message: expect.stringContaining('service tier'),
      });
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

    it('refuses requiredSkills without the skill-selection capability and admits it once advertised', async () => {
      const { harness, device, payload } = await setup(BASE_CAPABILITIES);
      const candidate = AgentExecutionInputSchema.parse({ taskId: input.taskId, deviceId: device.deviceId,
        payload: { ...payload, requiredSkills: ['review'], terminalProjection: { mode: 'none' } } });
      await expect(harness.cloud.submitAgentExecution(TENANT_A, candidate))
        .rejects.toMatchObject({ code: 'agent_capability_missing', message: expect.stringContaining(SKILL_SELECTION_CAPABILITY) });
      await expectNothingWritten(harness, device.deviceId);

      await harness.stores.devices.recordCapabilities(TENANT_A, {
        deviceId: device.deviceId,
        capabilities: [...BASE_CAPABILITIES, SKILL_SELECTION_CAPABILITY],
        harnesses: TEST_HARNESSES,
      });
      const offered = await harness.cloud.submitAgentExecution(TENANT_A, candidate);
      expect(offered.envelope.payload).toMatchObject({ requiredSkills: ['review'] });
    });

    it('refuses requiredSkills on enqueuePreparedOffer via protocol offerRule before reads or writes', async () => {
      const { harness, device, payload } = await setup([...BASE_CAPABILITIES, SKILL_SELECTION_CAPABILITY, 'agent-input-preparation-v9']);
      const getDevice = vi.spyOn(harness.stores.devices, 'get');
      const record = vi.spyOn(harness.stores.receipts, 'record');
      const { instruction: _instruction, ...rest } = payload;
      const call = harness.cloud.enqueuePreparedOffer(TENANT_A, device.deviceId, {
        taskId: input.taskId,
        payload: {
          ...rest,
          session: { mode: 'fresh' },
          preparation: { reference: 'prepared-1', requestDigest: 'digest-1' },
          agentMemory: 'none',
          requiredSkills: ['review'],
        } as never,
      });
      await expect(call).rejects.toBeInstanceOf(ZodError);
      await expect(call).rejects.toMatchObject({
        issues: expect.arrayContaining([
          { code: 'custom', path: ['requiredSkills'], message: 'a prepared offer carries no requiredSkills' },
        ]),
      });
      expect(getDevice).not.toHaveBeenCalled();
      expect(record).not.toHaveBeenCalled();
      await expectNothingWritten(harness, device.deviceId);
    });

    it('refuses an explicit executor that is missing from the inventory', async () => {
      const { harness, device, payload } = await setup(BASE_CAPABILITIES, true);
      const candidate = AgentExecutionInputSchema.parse({ taskId: input.taskId, deviceId: device.deviceId,
        payload: { ...payload, target: { ...SELECTION, harnessId: 'pi' }, terminalProjection: { mode: 'none' } } });
      await expect(harness.cloud.submitAgentExecution(TENANT_A, candidate)).rejects.toMatchObject({ code: 'agent_capability_missing' });
      await expectNothingWritten(harness, device.deviceId);
    });

    it('accepts an advertised subscription selection and toolset capability', async () => {
      const { harness, device, payload } = await setup([...BASE_CAPABILITIES, 'toolset-selection'], true);
      const candidate = AgentExecutionInputSchema.parse({ taskId: input.taskId, deviceId: device.deviceId,
        payload: { ...payload, target: SELECTION, requiredToolsets: ['example.tools'], terminalProjection: { mode: 'none' } } });
      const offered = await harness.cloud.submitAgentExecution(TENANT_A, candidate);
      expect(offered.taskId).toBe(input.taskId);
      expect(offered.envelope.payload).toMatchObject({ target: SELECTION, requiredToolsets: ['example.tools'] });
      expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 })).messages).toHaveLength(1);
    });
  });
});
