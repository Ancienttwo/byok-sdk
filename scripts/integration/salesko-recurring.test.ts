import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, generateKeyPairSync } from 'node:crypto';

const root = process.env.SALESKO_TEST_ROOT;
if (!root) throw new Error('Set SALESKO_TEST_ROOT to the isolated pinned Salesko checkout.');
const sha = Bun.spawnSync(['git', '-C', root, 'rev-parse', 'HEAD']);
if (sha.exitCode !== 0 || sha.stdout.toString().trim() !== '90fab70c54895ee0bcf08f45a164bb823f9ada34') throw new Error('Salesko test subject mismatch');
const installed = (name: string) => import(pathToFileURL(Bun.resolveSync(name, root)).href);
const { tenantId: sdkTenantId } = await installed('@byok-sdk/core');
const { createEnvelope } = await installed('@byok-sdk/protocol');
const { createInMemoryByokCloud, RecurringExecutionInputSchema } = await installed('@byok-sdk/cloud');
const load = (file: string) => import(pathToFileURL(resolve(root, file)).href);
const { InMemoryPrivateAgentChatRepository } = await load('apps/api/src/private-agent-chat-repository.ts');
const { byokTenantRef, MemoryDatasetScope } = await load('apps/api/src/byok-tenant-ref.ts');
const C = await load('packages/contracts/src/index.ts');

for (const cancelFirst of [false, true]) test(`Salesko transaction + SDK recurring replay: cancelFirst=${cancelFirst}`, async () => {
  const repository = new InMemoryPrivateAgentChatRepository(); repository.resetForTests();
  const tenantId = 'integration-tenant', userId = 'integration-user', conversationId = 'integration-conversation', turnId = 'integration-turn';
  const now = '2026-09-10T00:00:00.000Z';
  const tenant = sdkTenantId(await byokTenantRef(MemoryDatasetScope, tenantId));
  let crash = !cancelFirst;
  const harness = createInMemoryByokCloud({ agentMessage: { consume: async ({ tenant: actualTenant, deviceId, taskId, context, payload }) => {
    const result = await repository.recordAgentMessage({ now, message: { schemaVersion: C.PrivateAgentChatMessageConsumeSchemaVersion,
      tenantRef: actualTenant, deviceId, taskId, context, payload } });
    if (crash) { crash = false; throw new Error('Host committed before consumer response was lost'); }
    return result;
  } } });
  const request = (path: string, init: RequestInit) => harness.cloud.fetch(new Request(`http://integration.test${path}`, init));
  await harness.core.quota.writeEntitlement(tenant, {
    version: 1n, hardLimitBytes: 1_000_000_000n, maxObjectBytes: 100_000_000n,
    maxInlineBytes: 1_000_000n, mailboxLimitBytes: 100_000_000n, retentionPolicyId: 'test',
  });
  const { publicKey } = generateKeyPairSync('ed25519');
  const pairing = await harness.cloud.createPairingCode(tenant, { productId: 'salesko-integration' });
  const paired = await request('/byok/pair', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingCode: pairing.code, deviceName: 'fixture', devicePublicKey: publicKey.export({ format: 'jwk' }).x }) });
  expect(paired.status).toBe(200);
  const device = await paired.json();
  await harness.stores.devices.recordCapabilities(tenant, { deviceId: device.deviceId, capabilities: [
    'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-egress-fresh-session', 'agent-message-egress', 'terminal-projection-selection',
  ] });
  const binding = { agentRef: { agentId: '7bf9cf51-8c51-4a67-b8f3-4f11de2cecb1', profileRevision: '1' }, deviceId: device.deviceId,
    placementRevision: '3', runtime: 'claude', cwd: 'byok-agent-home', egressPolicy: C.PrivateAgentEgressPolicy, tools: C.PrivateAgentChatToolBinding };
  await repository.createConversation({ tenantId, userId, conversationId, title: 'Integration', agentId: binding.agentRef.agentId, execution: { epoch: 1 }, now });
  await repository.submitTurn({ tenantId, userId, conversationId, turnId, clientRequestId: 'integration-request', message: 'U1', binding, expectedExecution: { epoch: 1 }, now });
  const dispatch = await repository.startDispatch({ tenantId, turnId, now });
  expect(dispatch).not.toBeNull();
  const taskId = dispatch.execution.taskId;
  const offer = dispatch.execution.snapshot.offer;
  await harness.cloud.submitRecurringExecution(tenant, RecurringExecutionInputSchema.parse({ taskId, deviceId: device.deviceId, payload: {
    instruction: offer.instruction, runtime: 'claude', policy: offer.policy, agentRef: binding.agentRef, egressPolicy: binding.egressPolicy,
    messageEgress: { mode: 'required', contract: C.PrivateAgentChatMessageContract, contentType: 'text/markdown', maxBytes: 100000 }, terminalProjection: { mode: 'none' },
  }, agentMessageContext: { destinationBinding: conversationId, freshnessCursor: turnId } }));
  const payload = { agentRef: binding.agentRef, sessionRef: 'native-session', contract: C.PrivateAgentChatMessageContract,
    messageId: '10000000-0000-4000-8000-000000000099', cursor: 1, contentType: 'text/markdown' as const, body: 'A1', byteCount: 2,
    contentHash: `sha256:${createHash('sha256').update('A1').digest('hex')}` as `sha256:${string}` };
  const publish = () => request('/byok/messages', { method: 'POST', headers: { authorization: `Bearer ${device.accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [createEnvelope('agent.message.publish', payload, { taskId })] }) });
  if (cancelFirst) await repository.requestCancel({ tenantId, userId, conversationId, turnId, now });
  else {
    expect((await publish()).status).toBeGreaterThanOrEqual(500);
    expect(await harness.cloud.readAgentMessageDisposition(tenant, device.deviceId, taskId, payload)).toBeUndefined();
    const committed = await repository.readFullConversation({ tenantId, userId, conversationId });
    expect(committed.messages.filter((m: { role: string }) => m.role === 'assistant')).toHaveLength(1);
    await repository.requestCancel({ tenantId, userId, conversationId, turnId, now });
  }
  expect(await (await publish()).json()).toEqual({ accepted: 1 });
  expect(await harness.cloud.readAgentMessageDisposition(tenant, device.deviceId, taskId, payload)).toMatchObject({ outcome: cancelFirst ? 'refused' : 'accepted' });
  const receipt = await harness.cloud.readAgentMessageDisposition(tenant, device.deviceId, taskId, payload);
  expect(await (await publish()).json()).toEqual({ accepted: 1 });
  expect(await harness.cloud.readAgentMessageDisposition(tenant, device.deviceId, taskId, payload)).toEqual(receipt);
  const view = await repository.readFullConversation({ tenantId, userId, conversationId });
  expect(view.messages.filter((m: { role: string }) => m.role === 'assistant')).toHaveLength(cancelFirst ? 0 : 1);
});
