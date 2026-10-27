/**
 * `ByokCloud.redactTasks` and the readers of a redacted task (#654 E5a).
 *
 * The Postgres store is tested against a real database in
 * `cloud-dataplane/src/__tests__/task-redaction.test.ts`. Here a test store
 * replaces the receipt bodies the way that store does, through the codec cloud
 * passes in, so every cloud reader and fence sees a real tombstone.
 */
import { createHmacTokenSigner } from '../auth/tokens';
import { fullCapabilityDeclaration } from '../capabilities';
import { createByokCloud, type ByokCloud } from '../cloud';
import { isCloudError } from '../errors';
import { createMutableClock, type TenantId } from '@byok-sdk/core';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { createInMemoryByokCloud } from '../composition/in-memory';
import {
  isTaskRedactionTombstone,
  parseTaskRedactionInput,
  sameTaskBody,
  taskRedactionCodec,
  type TaskRedactionStore,
  type TaskRedactionStoreInput,
} from '../task-redaction';
import { createWebCrypto } from '../crypto/web-crypto';
import { TENANT_A, TENANT_B, CLOUD_ORIGIN, createDeviceKeys, type PairedDevice } from './support/harness';

const crypto = createWebCrypto();
const codec = taskRedactionCodec(crypto);
const AGENT_REF = { agentId: 'redaction-agent', profileRevision: 'profile-v1' };
const CAPABILITIES = [
  'agent-home-contract',
  'agent-egress-policy',
  'agent-egress-reliable-ack',
  'agent-message-egress',
  'terminal-projection-selection',
  'agent-egress-fresh-session',
];
const SECRET = 'redaction-secret-text';

function executionInput(taskId: string, deviceId: string) {
  return {
    taskId,
    deviceId,
    payload: {
      instruction: `instruction ${SECRET}`,
      agentRef: AGENT_REF,
      runtime: 'codex',
      session: { mode: 'fresh' },
      egressPolicy: {
        policyRevision: 'policy-v1',
        activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
        reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
        transfers: { workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] as string[] }, transcript: 'disabled', artifact: 'disabled' },
      },
      messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 },
      terminalProjection: { mode: 'none' },
    },
    agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'turn' },
  } as const;
}

/** Replaces the named receipt bodies with their tombstones, as the Postgres store does. */
function receiptRedactionStore(base: ReturnType<typeof createInMemoryByokCloud>) {
  const receipts = base.stores.receipts;
  const get = receipts.get.bind(receipts);
  const record = receipts.record.bind(receipts);
  const tombstones = new Map<string, string>();
  const slot = (tenant: TenantId, key: string) => `${tenant}\u0000${key}`;
  receipts.get = async (tenant, key) => {
    const receipt = await get(tenant, key);
    const tombstone = tombstones.get(slot(tenant, key));
    return receipt === undefined || tombstone === undefined ? receipt : { ...receipt, body: tombstone };
  };
  receipts.record = async (tenant, input) => {
    const recorded = await record(tenant, input);
    const tombstone = tombstones.get(slot(tenant, input.key));
    return recorded.created || tombstone === undefined
      ? recorded
      : { ...recorded, receipt: { ...recorded.receipt, body: tombstone } };
  };
  const calls: TaskRedactionStoreInput[] = [];
  const store: TaskRedactionStore = {
    async redactTask(input) {
      calls.push(input);
      await record(input.tenantId, { key: input.terminalReceiptKey, body: input.codec.absent });
      let receiptsRedacted = 0;
      for (const key of input.receiptKeys) {
        const receipt = await get(input.tenantId, key);
        if (receipt === undefined || input.codec.isTombstone(receipt.body) || tombstones.has(slot(input.tenantId, key))) continue;
        tombstones.set(slot(input.tenantId, key), (await input.codec.tombstone(receipt.body)).body);
        receiptsRedacted += 1;
      }
      const audit = await record(input.tenantId, { key: input.auditReceiptKey, body: '{}' });
      return {
        taskId: input.taskId,
        outcome: audit.created ? 'redacted' : 'already_redacted',
        counts: { receiptsRedacted, admissionsRedacted: 0, outboxRedacted: 0, ephemeralRowsDeleted: 0, objectsDeleted: 0 },
      };
    },
  };
  return { store, calls };
}

interface Fixture {
  readonly cloud: ByokCloud;
  readonly base: ReturnType<typeof createInMemoryByokCloud>;
  readonly calls: TaskRedactionStoreInput[];
  readonly consumed: string[];
  pair(tenant: TenantId): Promise<PairedDevice>;
  send(device: PairedDevice, ...messages: Envelope[]): Promise<{ readonly status: number; readonly body: unknown }>;
}

function createFixture(withStore = true): Fixture {
  const clock = createMutableClock();
  const base = createInMemoryByokCloud({ clock });
  const { store, calls } = receiptRedactionStore(base);
  const consumed: string[] = [];
  const cloud = createByokCloud({
    core: base.core,
    cloud: base.stores,
    mailboxWake: base.mailboxWake,
    blobContentProxy: base.blobContentProxy,
    crypto: base.crypto,
    tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(5), clock),
    clock,
    capabilities: fullCapabilityDeclaration(),
    agentMessage: {
      consume: async (input) => {
        consumed.push(input.payload.body);
        return { outcome: 'accepted' };
      },
    },
    ...(withStore ? { taskRedactionStore: store } : {}),
  });
  const request = (path: string, init: RequestInit = {}) => cloud.fetch(new Request(`${CLOUD_ORIGIN}${path}`, init));
  return {
    cloud,
    base,
    calls,
    consumed,
    async pair(tenant) {
      await base.core.quota.writeEntitlement(tenant, {
        version: 1n,
        hardLimitBytes: 1_000_000_000n,
        maxObjectBytes: 100_000_000n,
        maxInlineBytes: 1_000_000n,
        mailboxLimitBytes: 100_000_000n,
        retentionPolicyId: 'test',
      });
      const keys = createDeviceKeys();
      const { code } = await cloud.createPairingCode(tenant, { productId: 'test-product' });
      const response = await request('/byok/pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pairingCode: code, deviceName: 'test-device', devicePublicKey: keys.publicKeyBase64Url }),
      });
      const body = (await response.json()) as { deviceId: string; accessToken: string };
      await base.stores.devices.recordCapabilities(tenant, { deviceId: body.deviceId, capabilities: CAPABILITIES });
      return {
        tenant,
        deviceId: body.deviceId,
        accessToken: body.accessToken,
        keys,
        authorization: { authorization: `Bearer ${body.accessToken}` },
      };
    },
    async send(device, ...messages) {
      const response = await request('/byok/messages', {
        method: 'POST',
        headers: { ...device.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
      const text = await response.text();
      return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
    },
  };
}

function publish(taskId: string, body: string) {
  return createEnvelope('agent.message.publish', {
    agentRef: AGENT_REF,
    sessionRef: 'session-1',
    contract: 'conversation-turn/v1',
    messageId: '10000000-0000-4000-8000-000000000042',
    cursor: 1,
    contentType: 'text/markdown',
    body,
    byteCount: new TextEncoder().encode(body).byteLength,
    contentHash: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  }, { taskId });
}

function complete(taskId: string) {
  return createEnvelope('task.complete', {
    agentRef: AGENT_REF,
    sessionRef: 'session-1',
    summary: `summary ${SECRET}`,
    finalMessage: `final ${SECRET}`,
  }, { taskId });
}

/** One Agent task run to `complete`, with an admitted message. */
async function completedTask(fixture: Fixture, device: PairedDevice, taskId: string): Promise<void> {
  await fixture.cloud.submitAgentExecution(device.tenant, executionInput(taskId, device.deviceId));
  await fixture.send(device, createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: AGENT_REF, runtime: 'codex' }, { taskId }));
  await fixture.send(device, createEnvelope('task.started', {}, { taskId }));
  await fixture.send(device, publish(taskId, `message ${SECRET}`));
  expect((await fixture.send(device, complete(taskId))).status).toBe(200);
  await expect(fixture.cloud.readTaskAttempt(device.tenant, taskId)).resolves.toMatchObject({ status: 'complete' });
}

async function rejection(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return isCloudError(error) ? error.code : String(error);
  }
}

describe('task redaction codec', () => {
  it('gives one tombstone per body, keeps the envelope type and drops the text', async () => {
    const body = JSON.stringify({ type: 'task.complete', payload: { summary: SECRET } });
    const first = await codec.tombstone(body);
    expect(await codec.tombstone(body)).toEqual(first);
    expect(first.body).not.toContain(SECRET);
    expect(JSON.parse(first.body)).toEqual({
      byokRedacted: 1,
      sha256: await crypto.sha256(new TextEncoder().encode(body)),
      bytes: new TextEncoder().encode(body).byteLength,
      type: 'task.complete',
    });
    expect(first.bodyHash).toBe(await crypto.sha256(new TextEncoder().encode(first.body)));
    expect(first.byteSize).toBe(BigInt(new TextEncoder().encode(first.body).byteLength));
    expect(isTaskRedactionTombstone(first.body)).toBe(true);
    expect(isTaskRedactionTombstone(body)).toBe(false);
    // A type that could carry text is not kept.
    expect(JSON.parse((await codec.tombstone(JSON.stringify({ type: `free ${SECRET}` }))).body)).not.toHaveProperty('type');
    expect(JSON.parse((await codec.tombstone('not json')).body)).not.toHaveProperty('type');
  });

  it('compares a replay with the tombstone of its body', async () => {
    const body = JSON.stringify({ deviceId: 'device-1', type: 'task.offer', payload: { instruction: SECRET } });
    const tombstone = (await codec.tombstone(body)).body;
    await expect(sameTaskBody(body, body, crypto)).resolves.toBe(true);
    await expect(sameTaskBody(tombstone, body, crypto)).resolves.toBe(true);
    await expect(sameTaskBody(tombstone, `${body} `, crypto)).resolves.toBe(false);
    await expect(sameTaskBody(body, `${body} `, crypto)).resolves.toBe(false);
  });

  it('finds the hash of every BlobRef in a body', () => {
    const hashA = `sha256:${'a'.repeat(64)}`;
    const hashB = `sha256:${'b'.repeat(64)}`;
    const body = JSON.stringify({
      payload: {
        instruction: { blobRef: { blobId: 'blob-a', contentHash: hashA, size: 1 } },
        artifactRefs: [{ blobId: 'blob-b', contentHash: hashB, size: 2 }, { blobId: 'blob-a2', contentHash: hashA, size: 1 }],
        note: { contentHash: `sha256:${'c'.repeat(64)}` },
      },
    });
    expect(codec.blobHashes(body)).toEqual([hashA, hashB]);
    expect(codec.blobHashes('{')).toEqual([]);
  });

  it('accepts 1 to 100 distinct task ids', () => {
    expect(parseTaskRedactionInput({ taskIds: ['a', 'b'] })).toEqual(['a', 'b']);
    for (const taskIds of [[], ['a', 'a'], [''], Array.from({ length: 101 }, (_, index) => `t${index}`)]) {
      expect(() => parseTaskRedactionInput({ taskIds })).toThrow(expect.objectContaining({ code: 'coordination_input_invalid' }));
    }
  });
});

describe('ByokCloud.redactTasks', () => {
  it('fails closed without a store and reports unknown tasks per tenant', async () => {
    const without = createFixture(false);
    expect(await rejection(without.cloud.redactTasks(TENANT_A, { taskIds: ['task-1'] }))).toBe('task_redaction_unavailable');

    const fixture = createFixture();
    const device = await fixture.pair(TENANT_A);
    await completedTask(fixture, device, 'task-1');
    await expect(fixture.cloud.redactTasks(TENANT_B, { taskIds: ['task-1'] })).resolves.toEqual({
      tasks: [{ taskId: 'task-1', outcome: 'not_found' }],
    });
    expect(fixture.calls).toEqual([]);
    await expect(fixture.cloud.readTaskOffer(TENANT_A, 'task-1')).resolves.toMatchObject({ taskId: 'task-1' });
  });

  it('passes the content receipt keys and the audit key to the store', async () => {
    const fixture = createFixture();
    const device = await fixture.pair(TENANT_A);
    await completedTask(fixture, device, 'task-1');
    const offer = await fixture.cloud.readTaskOffer(TENANT_A, 'task-1');
    const result = await fixture.cloud.redactTasks(TENANT_A, { taskIds: ['task-1', 'task-missing'] });
    expect(result.tasks).toEqual([
      { taskId: 'task-1', outcome: 'redacted', counts: expect.objectContaining({ receiptsRedacted: 3 }) },
      { taskId: 'task-missing', outcome: 'not_found' },
    ]);
    expect(fixture.calls.map(({ tenantId, taskId, receiptKeys, terminalReceiptKey, auditReceiptKey }) =>
      ({ tenantId, taskId, receiptKeys, terminalReceiptKey, auditReceiptKey })))
      .toEqual([{
        tenantId: TENANT_A,
        taskId: 'task-1',
        receiptKeys: [`task-offer:${offer!.messageId}`, 'task:task-1:terminal', `agent-message-offer:${device.deviceId}:task-1`],
        terminalReceiptKey: 'task:task-1:terminal',
        auditReceiptKey: 'task-redaction:task-1',
      }]);
    await expect(fixture.cloud.redactTasks(TENANT_A, { taskIds: ['task-1'] })).resolves.toMatchObject({
      tasks: [{ taskId: 'task-1', outcome: 'already_redacted' }],
    });
  });

  it('closes content reads and keeps status reads', async () => {
    const fixture = createFixture();
    const device = await fixture.pair(TENANT_A);
    await completedTask(fixture, device, 'task-1');
    const draftRead = () => fixture.cloud.readTaskAgentMessageDraft(TENANT_A, device.deviceId, 'task-1', AGENT_REF);
    expect(await draftRead()).toMatchObject({ state: 'ended' });
    await fixture.cloud.redactTasks(TENANT_A, { taskIds: ['task-1'] });

    for (const read of [
      () => fixture.cloud.readTaskOffer(TENANT_A, 'task-1'),
      () => fixture.cloud.readTerminalReceipt(TENANT_A, 'task-1'),
      () => fixture.cloud.readDeviceTerminal(TENANT_A, 'task-1'),
      () => fixture.cloud.readTaskResult(TENANT_A, 'task-1'),
      () => fixture.cloud.readTaskAgentMessage(TENANT_A, device.deviceId, 'task-1', AGENT_REF),
      draftRead,
    ]) {
      expect(await rejection(read())).toBe('task_content_redacted');
    }
    await expect(fixture.cloud.readTaskAttempt(TENANT_A, 'task-1')).resolves.toMatchObject({ status: 'complete' });
  });

  it('fences the terminal of a task cancelled before a claim, so a late device terminal stores nothing', async () => {
    const fixture = createFixture();
    const device = await fixture.pair(TENANT_A);
    await fixture.cloud.submitAgentExecution(TENANT_A, executionInput('task-1', device.deviceId));
    await fixture.cloud.cancelTask(TENANT_A, 'task-1', `reason ${SECRET}`);
    expect(await fixture.cloud.readTerminalReceipt(TENANT_A, 'task-1')).toBeUndefined();
    await fixture.cloud.redactTasks(TENANT_A, { taskIds: ['task-1'] });

    const decline = createEnvelope('task.decline', { reason: `late ${SECRET}`, agentRef: AGENT_REF }, { taskId: 'task-1' });
    const cancelled = createEnvelope('task.cancelled', { reason: `late ${SECRET}`, agentRef: AGENT_REF }, { taskId: 'task-1' });
    expect(await fixture.send(device, decline, cancelled)).toMatchObject({ status: 200, body: { accepted: 2 } });
    const stored = await fixture.base.stores.receipts.get(TENANT_A, 'task:task-1:terminal');
    expect(stored?.body).toBe(codec.absent);
    expect(isTaskRedactionTombstone(codec.absent)).toBe(true);
    expect(await rejection(fixture.cloud.readTerminalReceipt(TENANT_A, 'task-1'))).toBe('task_content_redacted');
    expect(await rejection(fixture.cloud.readDeviceTerminal(TENANT_A, 'task-1'))).toBe('task_content_redacted');
    await expect(fixture.cloud.readTaskAttempt(TENANT_A, 'task-1')).resolves.toMatchObject({ status: 'cancelled' });
    await expect(fixture.cloud.readTaskResult(TENANT_A, 'task-1')).resolves.toMatchObject({ state: 'cancelled' });
  });

  it('keeps device replays and Host resubmits inside the fences', async () => {
    const fixture = createFixture();
    const device = await fixture.pair(TENANT_A);
    await completedTask(fixture, device, 'task-1');
    const resubmitBefore = await rejection(fixture.cloud.submitAgentExecution(TENANT_A, executionInput('task-1', device.deviceId)));
    await fixture.cloud.redactTasks(TENANT_A, { taskIds: ['task-1'] });

    // A terminal replay is a duplicate with nothing to record.
    expect(await fixture.send(device, complete('task-1'))).toMatchObject({ status: 200, body: { accepted: 1 } });
    await expect(fixture.cloud.readTaskAttempt(TENANT_A, 'task-1')).resolves.toMatchObject({ status: 'complete' });

    // A message replay is refused before admission; the consumer is not called again.
    const replay = await fixture.send(device, publish('task-1', `message ${SECRET}`));
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ accepted: 0, rejected: 1, outcomes: [{ outcome: 'rejected', reason: 'not_permitted' }] });
    expect(fixture.consumed).toEqual([`message ${SECRET}`]);

    // Late progress keeps no content.
    const progress = createEnvelope('task.progress', { seq: 9, events: [{ type: 'progress', text: `late ${SECRET}` }] }, { taskId: 'task-1' });
    expect((await fixture.send(device, progress)).body).toMatchObject({ accepted: 1 });
    await expect(fixture.cloud.readActivity(TENANT_A, 'task-1')).resolves.toBeUndefined();

    // A late claim is refused with the existing reason, not a server error.
    const claim = await fixture.send(device, createEnvelope('task.claim', { deviceId: device.deviceId, agentRef: AGENT_REF, runtime: 'codex' }, { taskId: 'task-1' }));
    expect(claim).toMatchObject({ status: 200, body: { rejected: 1, outcomes: [{ outcome: 'rejected', reason: 'not_permitted' }] } });

    // The Host gets the same answer for a resubmit as before the redaction.
    expect(await rejection(fixture.cloud.submitAgentExecution(TENANT_A, executionInput('task-1', device.deviceId)))).toBe(resubmitBefore);
    expect(resubmitBefore).toBeDefined();
  });

  it('leaves another task and another tenant untouched', async () => {
    const fixture = createFixture();
    const deviceA = await fixture.pair(TENANT_A);
    const deviceB = await fixture.pair(TENANT_B);
    await completedTask(fixture, deviceA, 'task-1');
    await completedTask(fixture, deviceA, 'task-2');
    await completedTask(fixture, deviceB, 'task-1');
    await fixture.cloud.redactTasks(TENANT_A, { taskIds: ['task-1'] });
    await expect(fixture.cloud.readTaskOffer(TENANT_A, 'task-2')).resolves.toMatchObject({ taskId: 'task-2' });
    await expect(fixture.cloud.readTaskResult(TENANT_A, 'task-2')).resolves.toMatchObject({ summary: `summary ${SECRET}` });
    await expect(fixture.cloud.readTaskResult(TENANT_B, 'task-1')).resolves.toMatchObject({ summary: `summary ${SECRET}` });
  });
});
