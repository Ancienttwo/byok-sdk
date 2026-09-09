import { createEnvelope } from '@byok-sdk/protocol';
import { describe, expect, it, vi } from 'vitest';
import { TENANT_A, TENANT_B, createHarness } from './support/harness';

// Salesko needs the SDK decision after its own consumer transaction committed.
// The Host must not decode TaskAttemptStore.terminalBody to recover that fact.
describe('Host exact Agent message disposition readback', () => {
  describe.each(['fresh', 'resume'] as const)('%s execution', (mode) => {
  it.each(['accepted', 'held', 'refused'] as const)('reads durable %s through the public cloud API', async (outcome) => {
    let consumed = 0;
    const harness = createHarness({ agentMessage: { consume: async () => { consumed++; return { outcome }; } } });
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: ['agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-message-egress', 'terminal-projection-selection', 'agent-egress-fresh-session'],
    });
    const agentRef = { agentId: 'readback-agent', profileRevision: 'profile-v1' };
    const taskId = `readback-${outcome}`;
    const input = {
      taskId,
      payload: {
        instruction: 'reply', policy: { mode: 'auto' }, agentRef,
        egressPolicy: {
          policyRevision: 'policy-v1', activity: { mode: 'metadata-status', delivery: 'latest-value' },
          reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
          transfers: { workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] as string[] }, transcript: 'disabled', artifact: 'disabled' },
        },
        messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 },
        terminalProjection: { mode: 'none' },
      },
      agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'turn' },
    } as const;
    if (mode === 'fresh') await harness.cloud.enqueueFreshAgentEgressOffer(TENANT_A, device.deviceId, input);
    else await harness.cloud.enqueueAgentEgressOffer(TENANT_A, device.deviceId, { ...input, payload: { ...input.payload, sessionRef: 'native-session' } });
    const message = createEnvelope('agent.message.publish', {
      agentRef, sessionRef: 'native-session', contract: 'conversation-turn/v1',
      messageId: '10000000-0000-4000-8000-000000000099', cursor: 1,
      contentType: 'text/markdown', body: 'hello', byteCount: 5,
      contentHash: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    }, { taskId });
    const publish = () => harness.request('/byok/messages', {
      method: 'POST', headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [message] }),
    });
    const read = () => harness.cloud.readAgentMessageDisposition(TENANT_A, device.deviceId, taskId, message.payload);
    expect(await read()).toBeUndefined();
    const finalize = vi.spyOn(harness.stores.tasks, 'finalizeAgentMessage');
    finalize.mockRejectedValueOnce(new Error('injected finalize outage'));
    expect((await publish()).status).toBeGreaterThanOrEqual(500);
    expect(consumed).toBe(1);
    expect(await read()).toBeUndefined();
    expect(await (await publish()).json()).toEqual({ accepted: 1 });
    expect(consumed).toBe(2);
    finalize.mockRestore();
    const receipt = await harness.cloud.readAgentMessageDisposition(TENANT_A, device.deviceId, taskId, message.payload);
    expect(receipt).toMatchObject({ outcome, agentRef, messageId: message.payload.messageId, sessionRef: 'native-session' });
    expect(await (await publish()).json()).toEqual({ accepted: 1 });
    expect(consumed).toBe(2);
    expect(await harness.cloud.readAgentMessageDisposition(TENANT_A, device.deviceId, taskId, message.payload)).toEqual(receipt);
    expect(await harness.cloud.readAgentMessageDisposition(TENANT_B, device.deviceId, taskId, message.payload)).toBeUndefined();
    expect(await harness.cloud.readAgentMessageDisposition(TENANT_A, 'other-device', taskId, message.payload)).toBeUndefined();
    expect(await harness.cloud.readAgentMessageDisposition(TENANT_A, device.deviceId, 'other-task', message.payload)).toBeUndefined();
    expect(await harness.cloud.readAgentMessageDisposition(TENANT_A, device.deviceId, taskId, { ...message.payload, body: 'other' })).toBeUndefined();
    const stored = await harness.stores.tasks.readAgentMessage(TENANT_A, {
      taskId, deviceId: device.deviceId, messageId: message.payload.messageId, payloadBody: JSON.stringify(message.payload),
    });
    expect(stored).toBeDefined();
    const lookup = vi.spyOn(harness.stores.tasks, 'readAgentMessage');
    for (const terminalBody of [
      '{',
      JSON.stringify({ payload: message.payload, disposition: { ...receipt, outcome: 'invented' } }),
      JSON.stringify({ payload: message.payload, disposition: { ...receipt, sessionRef: 'other-session' } }),
      JSON.stringify({ payload: { ...message.payload, body: 'other' }, disposition: receipt }),
    ]) {
      lookup.mockResolvedValueOnce({ ...stored!, terminalBody });
      await expect(read()).rejects.toThrow('Invalid persisted Agent message disposition');
    }
    lookup.mockRestore();
    expect(await read()).toEqual(receipt);
    await harness.cloud.cancelTask(TENANT_A, taskId, 'stop remaining');
    expect(await read()).toEqual(receipt);

  });
});

});
