import { createEnvelope } from '@byok-sdk/protocol';
import { describe, expect, it, vi } from 'vitest';
import { TENANT_A, createHarness } from './support/harness';

// #687: a daemon batch can carry task.started together with the first Agent
// message. A failure at the message must not undo the lifecycle before it.
describe('POST /byok/messages with a failing Agent message', () => {
  it('keeps task.started committed when the publish fails before admission', async () => {
    let consumed = 0;
    const harness = createHarness({ agentMessage: { consume: async () => { consumed++; return { outcome: 'accepted' }; } } });
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: ['agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-message-egress', 'terminal-projection-selection', 'agent-egress-fresh-session'],
    });
    const agentRef = { agentId: 'batch-agent', profileRevision: 'profile-v1' };
    const taskId = 'batch-failure';
    await harness.cloud.submitAgentExecution(TENANT_A, {
      taskId,
      deviceId: device.deviceId,
      payload: {
        instruction: 'reply', agentRef, runtime: 'codex', session: { mode: 'fresh' },
        egressPolicy: {
          policyRevision: 'policy-v1', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
          reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
          transfers: { workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] }, transcript: 'disabled', artifact: 'disabled' },
        },
        messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 },
        terminalProjection: { mode: 'none' },
      },
      agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'turn' },
    });
    const message = createEnvelope('agent.message.publish', {
      agentRef, sessionRef: 'native-session', contract: 'conversation-turn/v1',
      messageId: '10000000-0000-4000-8000-000000000687', cursor: 1,
      contentType: 'text/markdown', body: 'hello', byteCount: 5,
      contentHash: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    }, { taskId });
    const batch = [
      createEnvelope('task.claim', { deviceId: device.deviceId, agentRef, runtime: 'codex' }, { taskId }),
      createEnvelope('task.started', {}, { taskId }),
      message,
    ];
    const post = () => harness.request('/byok/messages', {
      method: 'POST', headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: batch }),
    });

    const reserve = vi.spyOn(harness.stores.tasks, 'reserveAgentMessage');
    reserve.mockRejectedValueOnce(new Error('injected admission outage'));
    expect((await post()).status).toBeGreaterThanOrEqual(500);
    reserve.mockRestore();
    expect(consumed).toBe(0);
    expect(await harness.cloud.readTaskAgentMessage(TENANT_A, device.deviceId, taskId, agentRef)).toBeUndefined();
    expect(await harness.cloud.readTaskAttempt(TENANT_A, taskId)).toMatchObject({ status: 'running', ownerDeviceId: device.deviceId });

    // The daemon resends the same batch: the lifecycle is a duplicate, the message lands once.
    expect(await (await post()).json()).toMatchObject({ accepted: 3 });
    expect(consumed).toBe(1);
    expect(await harness.cloud.readTaskAttempt(TENANT_A, taskId)).toMatchObject({ status: 'running', ownerDeviceId: device.deviceId });
  });
});
