import assert from 'node:assert/strict';
import { tenantId } from '@byok-sdk/core';
import { createInMemoryByokCloud, RecurringExecutionInputSchema } from '@byok-sdk/cloud';
import { createByokServer } from '@byok-sdk/server';

const tenant = tenantId('packed-recurring');
const deviceId = 'packed-device';
const { cloud, stores } = createInMemoryByokCloud({ agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
await stores.devices.register(tenant, { deviceId, productId: 'packed', deviceName: 'fixture', devicePublicKey: 'fixture-key', proofKeyId: 'fixture-proof', proofKeyEpoch: 1 });
await stores.devices.recordCapabilities(tenant, { deviceId, capabilities: [
  'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'agent-message-egress', 'terminal-projection-selection',
] });
const input = RecurringExecutionInputSchema.parse({
  taskId: 'packed-execution', deviceId,
  payload: { instruction: 'persisted current input', runtime: 'codex', policy: { mode: 'auto' },
    agentRef: { agentId: 'packed-agent', profileRevision: 'profile' },
    egressPolicy: { policyRevision: 'policy', activity: { mode: 'metadata-status', delivery: 'latest-value' },
      reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
      transfers: { workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] }, transcript: 'disabled', artifact: 'disabled' } },
    messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 },
    terminalProjection: { mode: 'none' } },
  agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'turn' },
});
const submitted = await cloud.submitRecurringExecution(tenant, JSON.parse(JSON.stringify(input)));
assert.equal(submitted.taskId, input.taskId);
assert.equal(submitted.envelope.type, 'task.offer_for_agent_with_egress_fresh');
assert.equal('sessionRef' in submitted.envelope.payload, false);
assert.deepEqual((await cloud.readTaskOffer(tenant, input.taskId)).payload, input.payload);
await assert.rejects(cloud.submitRecurringExecution(tenant, input));
assert.equal(await cloud.readDeviceTerminal(tenant, input.taskId), undefined);
await cloud.cancelTask(tenant, input.taskId, 'packed stop');
assert.equal((await cloud.readTaskResult(tenant, input.taskId)).state, 'cancelled');
assert.equal(await cloud.readDeviceTerminal(tenant, input.taskId), undefined);
assert.equal(typeof cloud.readAgentMessageDisposition, 'function');
assert.equal(typeof cloud.readTaskAgentMessage, 'function');
assert.equal(await cloud.readTaskAgentMessage(tenant, deviceId, input.taskId, input.payload.agentRef), undefined);
const server = createByokServer({ productId: 'packed-recurring' });
try {
  assert.equal(typeof server.recurring.submit, 'function');
  assert.equal(typeof server.tasks.messageDisposition, 'function');
  assert.equal(typeof server.tasks.agentMessage, 'function');
  assert.equal(await server.tasks.agentMessage('absent', deviceId, input.payload.agentRef), undefined);
  assert.equal(await server.tasks.attempt('absent'), undefined);
  assert.equal(await server.tasks.deviceTerminal('absent'), undefined);
  await assert.rejects(server.recurring.submit(input), /registered Agent message consumer/);
} finally { server.stop(); }
console.log('[release-pack] recurring public imports, strict submission and independent device observation passed');
