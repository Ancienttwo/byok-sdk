import { expect, test } from 'bun:test';
import { resolve, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { StubRuntimeAdapter } from '../../packages/client/src/__tests__/fixtures/stub-adapter';
import { pathToFileURL } from 'node:url';
import { createHash, generateKeyPairSync } from 'node:crypto';

const root = process.env.SALESKO_TEST_ROOT;
if (!root) throw new Error('Set SALESKO_TEST_ROOT to the isolated pinned Salesko checkout.');
const sha = Bun.spawnSync(['git', '-C', root, 'rev-parse', 'HEAD']);
if (sha.exitCode !== 0 || sha.stdout.toString().trim() !== '5dab9af32cf123797a4c674aac39decd2371eaa2') throw new Error('Salesko test subject mismatch');
const installed = (name: string) => import(pathToFileURL(Bun.resolveSync(name, root)).href);
const { tenantId: sdkTenantId } = await installed('@byok-sdk/core');
const { createEnvelope } = await installed('@byok-sdk/protocol');
const { createInMemoryByokCloud } = await installed('@byok-sdk/cloud');
const load = (file: string) => import(pathToFileURL(resolve(root, file)).href);
const { InMemoryPrivateAgentChatRepository } = await load('apps/api/src/private-agent-chat-repository.ts');
const { submitAndPrepare } = await load('apps/api/src/private-agent-chat-test-helpers.ts');
const { byokTenantRef, MemoryDatasetScope } = await load('apps/api/src/byok-tenant-ref.ts');
const C = await load('packages/contracts/src/index.ts');
const { offerPrivateAgentChat, reconcilePrivateAgentChat } = await load('apps/byok-control/src/private-agent-chat.ts');
const { privateAgentChatCloud } = await load('apps/byok-control/src/main.ts');

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
  let recurringSubmissions = 0;
  const submitRecurring = harness.cloud.submitRecurringExecution.bind(harness.cloud);
  harness.cloud.submitRecurringExecution = (...args: Parameters<typeof submitRecurring>) => {
    recurringSubmissions++; return submitRecurring(...args);
  };
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
  await repository.createConversation({ continuity: { mode: "fresh", version: 1 }, tenantId, userId, conversationId, title: 'Integration', agentId: binding.agentRef.agentId, execution: { epoch: 1 }, now });
  await submitAndPrepare(repository, { tenantId, userId, conversationId, turnId, clientRequestId: 'integration-request', message: 'U1', binding, expectedExecution: { epoch: 1 }, now });
  const dispatch = await repository.startDispatch({ tenantId, turnId, now });
  expect(dispatch).not.toBeNull();
  const taskId = dispatch.execution.taskId;
  const execution = dispatch.execution;
  const dispatchInput = {
    tenantRef: tenant,
    execution: { conversationId, turnId, taskId, generation: execution.generation,
      snapshot: execution.snapshot, messageContext: execution.messageContext },
  };
  const port = privateAgentChatCloud(harness.cloud);
  const result = await offerPrivateAgentChat(port, dispatchInput);
  expect(result).toMatchObject({ status: 'accepted', taskId });
  expect(recurringSubmissions).toBe(1);
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
  const observed = await reconcilePrivateAgentChat(port, { ...dispatchInput, message: payload });
  expect(observed.messageReceipt).toEqual({ schemaVersion: 'salesko.sdk_message_receipt.v1', payload, disposition: receipt });
  expect(await repository.recordMessageReceipt({ tenantId, taskId, receipt: observed.messageReceipt, now })).toBe(!cancelFirst);
  const view = await repository.readFullConversation({ tenantId, userId, conversationId });
  expect(view.messages.filter((m: { role: string }) => m.role === 'assistant')).toHaveLength(cancelFirst ? 0 : 1);
});


// The installed daemon is under test. Only provider output and close behavior are synthetic.
for (const disposal of ['delayed', 'failed'] as const) test(`Salesko + installed TaskRunner: ${disposal} close, real decline and explicit Retry`, async () => {
  const { createDaemonWithAdapters, RuntimeDisposalFailure } = await installed('@byok-sdk/client');
  const { Hono } = await installed('hono');
  const { createPrivateAgentChatRouter } = await load('apps/byok-control/src/main.ts');
  const { ByokPrivateAgentChatDispatcher } = await load('apps/api/src/private-agent-chat-dispatch.ts');
  const { dispatchAndReconcile, reconcileAndRecord } = await load('apps/api/src/private-agent-chat-routes.ts');
  const { runPrivateAgentChatRecovery } = await load('apps/api/src/private-agent-chat-recovery.ts');
  const localRoot = await mkdtemp(join(tmpdir(), 'salesko-sdk-lifecycle-'));
  const repository = new InMemoryPrivateAgentChatRepository(); repository.resetForTests();
  const owner = { tenantId: 'lifecycle-tenant', userId: 'lifecycle-user', conversationId: `lifecycle-${disposal}` };
  const tenant = sdkTenantId(await byokTenantRef(MemoryDatasetScope, owner.tenantId));
  let sequence = 0;
  const timestamp = () => new Date(Date.parse('2026-09-10T04:00:00.000Z') + sequence++ * 1000).toISOString();
  const consumed: string[] = [];
  const sdk = createInMemoryByokCloud({ longPollHoldMs: 50, agentMessage: { consume: async ({ tenant: actualTenant, deviceId, taskId, context, payload }) => {
    consumed.push(taskId);
    return repository.recordAgentMessage({ now: timestamp(), message: { schemaVersion: C.PrivateAgentChatMessageConsumeSchemaVersion,
      tenantRef: actualTenant, deviceId, taskId, context, payload } });
  } } });
  let submissions = 0;
  const submit = sdk.cloud.submitRecurringExecution.bind(sdk.cloud);
  sdk.cloud.submitRecurringExecution = (...args: Parameters<typeof submit>) => { submissions++; return submit(...args); };
  const token = 'disposable-lifecycle-control';
  const app = new Hono().route('/internal/private-agent-chat', createPrivateAgentChatRouter(privateAgentChatCloud(sdk.cloud), {
    auth: { researchToken: token, adminToken: 'disposable-admin', privateAgentChatCallbackToken: 'disposable-chat',
      privateAgentToolsCallbackToken: 'disposable-tools', profileProjectionToken: 'disposable-profile', tokenSigningSecret: new Uint8Array(32) },
  }));
  const http = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request =>
    new URL(request.url).pathname.startsWith('/internal/') ? app.fetch(request) : sdk.cloud.fetch(request) });
  const baseUrl = `http://127.0.0.1:${http.port}`;
  const dispatcher = new ByokPrivateAgentChatDispatcher({ baseUrl, datasetScope: MemoryDatasetScope, researchToken: token });
  const adapter = new StubRuntimeAdapter('claude', { kind: 'available', version: 'synthetic-test' },
    { steer: true, resume: true, approvalInteractive: true, mcpToolsets: true, permissionModes: ['auto', 'readonly', 'confirm', 'plan'] }, false);
  let preparations = 0;
  const prepare = adapter.prepare.bind(adapter);
  adapter.prepare = async input => { preparations++; return prepare(input); };
  const productId = 'salesko-lifecycle-fixture';
  const daemon = createDaemonWithAdapters({ localAgentRelease: { version: '0.0.0-lifecycle-test' }, productName: 'lifecycle fixture', productId,
    serverUrl: baseUrl, workspaceRoot: join(localRoot, 'workspace'), storeDir: join(localRoot, 'store'),
    agentHome: { hostStorageRoot: join(localRoot, 'home') }, agentEgress: { policy: C.PrivateAgentEgressPolicy },
    // Stub declares no tools/list observation and never executes these projections.
    mcpToolsets: { 'salesko.read.v1': { mcpServers: { read: { command: '/bin/false' } } },
      'salesko.propose.v1': { mcpServers: { propose: { command: '/bin/false' } } } },
  }, [adapter]);
  const until = async (predicate: () => boolean | Promise<boolean>, label: string) => {
    const deadline = Date.now() + 10000;
    while (!await predicate()) {
      if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  let releaseClose: (() => void) | undefined;
  let originalClose: (() => Promise<void>) | undefined;
  try {
    await sdk.core.quota.writeEntitlement(tenant, { version: 1n, hardLimitBytes: 1_000_000_000n, maxObjectBytes: 100_000_000n,
      maxInlineBytes: 1_000_000n, mailboxLimitBytes: 100_000_000n, retentionPolicyId: 'lifecycle-test' });
    const pairing = await sdk.cloud.createPairingCode(tenant, { productId });
    const { deviceId } = await daemon.pair(pairing.code); await daemon.start();
    await until(() => daemon.status().connected, 'daemon connection');
    await until(async () => (await sdk.cloud.listDevices(tenant))[0]?.capabilities?.includes('agent-message-egress') === true, 'device capabilities');
    const binding = { agentRef: { agentId: '7bf9cf51-8c51-4a67-b8f3-4f11de2cecb1', profileRevision: '1' }, deviceId,
      placementRevision: '3', runtime: 'claude', cwd: 'byok-agent-home', egressPolicy: C.PrivateAgentEgressPolicy, tools: C.PrivateAgentChatToolBinding };
    await repository.createConversation({ ...owner, continuity: { mode: 'fresh', version: 1 }, title: 'Lifecycle', agentId: binding.agentRef.agentId, execution: { epoch: 1 }, now: timestamp() });
    const input = (turnId: string, message: string) => ({ ...owner, turnId, clientRequestId: `request-${turnId}`, message, now: timestamp() });
    await submitAndPrepare(repository, { ...input('T1', 'U1'), binding, expectedExecution: { epoch: 1 } });
    await dispatchAndReconcile(repository, dispatcher, owner.tenantId, 'T1', timestamp());
    const first = (await repository.reconcileDispatch({ ...owner, turnId: 'T1', now: timestamp() }))!;
    await until(async () => {
      const terminal = await sdk.cloud.readDeviceTerminal(tenant, first.execution.taskId);
      if (terminal) throw new Error(JSON.stringify(terminal.envelope));
      return adapter.sessions.length === 1;
    }, 'first fresh session');
    const session = adapter.sessions[0]!; originalClose = session.close.bind(session);
    let closeFailed = false;
    if (disposal === 'delayed') releaseClose = session.blockClose();
    else session.close = async () => { closeFailed = true; throw new RuntimeDisposalFailure({ stage: 'quiescence', reason: 'synthetic disposal failure' }); };
    session.emit({ type: 'progress', text: 'A1' }); session.emit({ type: 'turn_end' });
    await until(async () => (await sdk.cloud.readDeviceTerminal(tenant, first.execution.taskId))?.envelope.type === 'task.complete', 'first terminal before close');
    if (disposal === 'failed') await until(() => closeFailed, 'failed close attempt');
    const answered = (await repository.reconcileDispatch({ ...owner, turnId: 'T1', now: timestamp() }))!;
    await reconcileAndRecord(repository, dispatcher, answered, timestamp());
    expect(await repository.reconcileDispatch({ ...owner, turnId: 'T1', now: timestamp() })).toBeNull();
    expect(daemon.status().agentHomeExecution.activeAttempts).toBe(1);
    expect((await repository.readFullConversation(owner))!.messages.map((message: { content: string }) => message.content)).toEqual(['U1', 'A1']);
    const current = (await repository.readFullConversation(owner))!;
    await submitAndPrepare(repository, { ...input('T2', 'U2'), binding, expectedExecution: current.conversation.execution });
    await repository.submitTurn(input('T3', 'U3'));
    await dispatchAndReconcile(repository, dispatcher, owner.tenantId, 'T2', timestamp());
    const second = (await repository.readFullConversation(owner))!.turns.find((turn: { turnId: string }) => turn.turnId === 'T2')!;
    const declinedTask = second.execution.taskId;
    await until(async () => (await sdk.cloud.readDeviceTerminal(tenant, declinedTask))?.envelope.type === 'task.decline', 'actual home-busy decline');
    const pending = (await repository.reconcileDispatch({ ...owner, turnId: 'T2', now: timestamp() }))!;
    await reconcileAndRecord(repository, dispatcher, pending, timestamp());
    const blocked = (await repository.readFullConversation(owner))!;
    expect(blocked.turns.find((turn: { turnId: string }) => turn.turnId === 'T2')).toMatchObject({ status: 'failed', execution: { taskId: declinedTask, generation: 1 } });
    expect(blocked.recovery).toMatchObject({ headTurnId: 'T2', unsettledTurns: 2 });
    expect(blocked.recovery.turns.find((turn: { turnId: string }) => turn.turnId === 'T2')).toMatchObject({
      settlement: null, resourceObservation: 'unknown', actions: { retry: true, end: true } });
    expect((await sdk.cloud.readTaskAttempt(tenant, declinedTask))?.ownerDeviceId).toBeUndefined();
    expect(preparations).toBe(1); expect(adapter.startCalls).toHaveLength(1);
    const scan = async () => {
      const now = timestamp();
      const result = await runPrivateAgentChatRecovery(new InMemoryPrivateAgentChatRepository(), dispatcher, {
        now, nextCheckAt: new Date(Date.parse(now) + 500).toISOString(), limit: 25, prepare: async (identity: { conversationId: string; turnId: string }) => {
          const full = (await repository.readFullConversation({ ...owner, ...identity }))!;
          return repository.prepareQueuedTurn({ ...owner, ...identity, binding, expectedExecution: full.conversation.execution, now });
        },
      });
      expect(result).toMatchObject({ selected: 1, skipped: 1, dispatchChecks: 0, reconciled: 0, failures: [] });
      const full = (await repository.readFullConversation(owner))!;
      expect(full.recovery.headTurnId).toBe('T2');
      expect(full.turns.find((turn: { turnId: string }) => turn.turnId === 'T2').execution.generation).toBe(1);
      expect(full.turns.find((turn: { turnId: string }) => turn.turnId === 'T3').execution).toBeNull();
      expect(submissions).toBe(2); expect(preparations).toBe(1); expect(adapter.startCalls).toHaveLength(1);
    };
    await scan(); await scan();
    if (disposal === 'delayed') {
      releaseClose!(); releaseClose = undefined;
      await until(() => daemon.status().agentHomeExecution.activeAttempts === 0, 'home release');
      await scan(); await scan();
      expect((await repository.readFullConversation(owner))!.recovery.turns.find((turn: { turnId: string }) => turn.turnId === 'T2').resourceObservation).toBe('unknown');
    } else expect(daemon.status().agentHomeExecution.activeAttempts).toBe(1);
    const action = { ...owner, turnId: 'T2', taskId: declinedTask, generation: 1, actionId: 'retry-once', allowCreate: true, now: timestamp() };
    const retry = await repository.retryTurn(action); expect(retry.status).toBe('created');
    expect(await new InMemoryPrivateAgentChatRepository().retryTurn(action)).toEqual({ status: 'duplicate', retry: retry.retry });
    expect(retry.retry.generation).toBe(2); expect(retry.retry.taskId).not.toBe(declinedTask);
    await dispatchAndReconcile(repository, dispatcher, owner.tenantId, 'T2', timestamp());
    if (disposal === 'delayed') {
      await until(() => adapter.sessions.length === 2, 'explicit Retry new fresh session');
      expect(preparations).toBe(2); expect(adapter.sessions[1]!.sessionRef).not.toBe(session.sessionRef);
      expect(adapter.startCalls[1]!.task.sessionRef).toBeUndefined();
      const instruction = adapter.startCalls[1]!.task.instruction as string;
      expect(instruction).toContain('U1'); expect(instruction).toContain('A1'); expect(instruction).toContain('U2'); expect(instruction).not.toContain('U3');
      adapter.sessions[1]!.emit({ type: 'progress', text: 'A2' }); adapter.sessions[1]!.emit({ type: 'turn_end' });
      await until(async () => (await sdk.cloud.readDeviceTerminal(tenant, retry.retry.taskId))?.envelope.type === 'task.complete', 'Retry terminal');
      const pending = (await repository.reconcileDispatch({ ...owner, turnId: 'T2', now: timestamp() }))!;
      await reconcileAndRecord(repository, dispatcher, pending, timestamp());
      expect((await repository.readFullConversation(owner))!.recovery.headTurnId).toBe('T3');
      expect(consumed).toEqual([first.execution.taskId, retry.retry.taskId]);
    } else {
      await until(async () => (await sdk.cloud.readDeviceTerminal(tenant, retry.retry.taskId))?.envelope.type === 'task.decline', 'Retry still busy');
      const pending = (await repository.reconcileDispatch({ ...owner, turnId: 'T2', now: timestamp() }))!;
      await reconcileAndRecord(repository, dispatcher, pending, timestamp());
      expect(daemon.status().agentHomeExecution.activeAttempts).toBe(1);
      expect(preparations).toBe(1); expect(adapter.startCalls).toHaveLength(1); expect(consumed).toEqual([first.execution.taskId]);
      expect((await repository.readFullConversation(owner))!.recovery.headTurnId).toBe('T2');
    }
    expect(submissions).toBe(3);
    expect(await repository.retryTurn(action)).toEqual({ status: 'duplicate', retry: retry.retry });
    const final = (await repository.readFullConversation(owner))!;
    expect(final.turns.find((turn: { turnId: string }) => turn.turnId === 'T2').execution.generation).toBe(2);
    expect(final.turns.find((turn: { turnId: string }) => turn.turnId === 'T3').execution).toBeNull();
    console.log(`A15/A21 installed-daemon+Host ${disposal}=PASS; submissions=3; prepares=${preparations}; synthetic_starts=${adapter.startCalls.length}; native_starts=0`);
  } finally {
    releaseClose?.();
    if (originalClose && adapter.sessions[0]) adapter.sessions[0].close = originalClose;
    await daemon.stop(); http.stop(true);
    await rm(localRoot, { recursive: true, force: true });
  }
}, 45000);
