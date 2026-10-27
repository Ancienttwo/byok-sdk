import { createInProcessMailboxWake } from '@byok-sdk/cloud';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { createByokCloud, createHmacTokenSigner, createWebCrypto, fullCapabilityDeclaration } from '@byok-sdk/cloud';
import { createEnvelope, type TaskClaimPayload } from '@byok-sdk/protocol';
import { handleInboundEnvelope } from '../../../cloud/src/inbound';
import { tenantStoresFor } from '../../../cloud/src/tenant-stores';
import { createSqliteEmbeddedStores } from '../stores/sqlite';
import { TEST_AGENT_REF, TEST_SESSION_REF } from './test-support';

const tenant = tenantId('custom-harness');
const deviceId = 'custom-device';
const harnessId = 'acme-harness';
const capabilities = { steer: true };
const payload = { agentRef: TEST_AGENT_REF, session: { mode: 'resume', sessionRef: TEST_SESSION_REF }, instruction: 'run custom adapter' } as const;
const agentRef = TEST_AGENT_REF;

describe('SQLite custom-harness claim authority', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'byok-custom-harness-'));
    roots.push(root);
    const path = join(root, 'server.sqlite');
    const clock = createMutableClock();
    const crypto = createWebCrypto();
    const open = (migration?: string) => {
      const embedded = createSqliteEmbeddedStores({ path, ...(migration === undefined ? {} : { migration }) }, { clock, crypto });
      const stores = { ...embedded, mailboxWake: createInProcessMailboxWake() };
      // Quota is process memory here; issue the entitlement on every open, as the
      // embedded server does, so limited mailbox appends are admitted (#411).
      void stores.core.quota.writeEntitlement(tenant, {
        version: 1n,
        hardLimitBytes: 1_000_000_000n,
        maxObjectBytes: 100_000_000n,
        maxInlineBytes: 1_000_000n,
        mailboxLimitBytes: 100_000_000n,
        retentionPolicyId: 'test',
      });
      const cloud = createByokCloud({ ...stores, clock, crypto,
        tokenSigner: createHmacTokenSigner(new Uint8Array(32), clock), capabilities: fullCapabilityDeclaration() });
      const bound = tenantStoresFor({ kind: 'device', tenantId: tenant, productId: 'probe', deviceId }, stores);
      return { stores, cloud, bound };
    };
    return { path, open };
  }

  it.each([
    ['explicit', 'complete'], ['automatic', 'complete'],
    ['explicit', 'failed'], ['automatic', 'failed'],
    ['explicit', 'cancelled'], ['automatic', 'cancelled'],
  ] as const)('persists %s custom claims and gates %s across reopen', async (selection, status) => {
    const { open } = fixture();
    let runtime = open();
    try {
      await runtime.stores.cloud.devices.register(tenant, { deviceId, productId: 'probe', deviceName: 'fixture',
        devicePublicKey: 'key', proofKeyId: 'proof', proofKeyEpoch: 1 });
      await runtime.bound.devices.recordCapabilities({ capabilities: ['agent-home-contract', 'custom-harness'],
        harnesses: [{ id: harnessId, capabilities }, { id: 'other', capabilities }] });
      const offer = await runtime.cloud.enqueueAgentOffer(tenant, deviceId, {
        payload: { ...payload, ...(selection === 'explicit' ? { harnessId } : {}) },
      });
      const taskId = offer.taskId;
      const claim = createEnvelope('task.claim', { deviceId, agentRef, harnessId, capabilities }, { taskId });
      expect(await handleInboundEnvelope(runtime.bound, deviceId, claim).then((result) => result.outcome)).toBe('accepted');
      const expected = { ownerDeviceId: deviceId, claimedHarnessId: harnessId,
        claimedRuntimeCapabilities: capabilities, status: 'claimed' };
      expect(await runtime.bound.tasks.get(taskId)).toMatchObject(expected);
      await runtime.stores.close();
      runtime = open();
      expect(await runtime.bound.tasks.get(taskId)).toMatchObject(expected);
      expect(await runtime.stores.cloud.tasks.getMany(tenant, [taskId])).toMatchObject([expected]);
      expect((await runtime.stores.cloud.tasks.list(tenant, { limit: 10 })).attempts).toMatchObject([expected]);
      expect(await handleInboundEnvelope(runtime.bound, deviceId, claim).then((result) => result.outcome)).toBe('accepted');
      for (const changed of [{}, { harnessId: 'other' }, { runtime: 'pi' }] satisfies Omit<TaskClaimPayload, 'deviceId'>[]) {
        expect(await handleInboundEnvelope(runtime.bound, deviceId,
          createEnvelope('task.claim', { deviceId, agentRef, ...changed }, { taskId })).then((result) => result.outcome)).toBe('rejected');
      }
      // Mutable inventory is not authority for this already-claimed execution.
      await runtime.bound.devices.recordCapabilities({ capabilities: [], harnesses: [] });
      for (const identity of [{}, { harnessId: 'other' }]) {
        for (const terminal of [
          createEnvelope('task.complete', { agentRef, summary: 'wrong', sessionRef: 's', ...identity }, { taskId }),
          createEnvelope('task.fail', { agentRef, reason: 'wrong', retryable: false, ...identity }, { taskId }),
          createEnvelope('task.cancelled', { agentRef, ...identity }, { taskId }),
        ]) expect(await handleInboundEnvelope(runtime.bound, deviceId, terminal).then((result) => result.outcome)).toBe('rejected');
      }
      expect(await runtime.cloud.readTerminalReceipt(tenant, taskId)).toBeUndefined();
      expect(await runtime.bound.tasks.get(taskId)).toMatchObject(expected);
      const terminal = status === 'complete'
        ? createEnvelope('task.complete', { agentRef, summary: 'done', sessionRef: 's', harnessId }, { taskId })
        : status === 'failed'
          ? createEnvelope('task.fail', { agentRef, reason: 'fixture-failure', retryable: false, harnessId }, { taskId })
          : createEnvelope('task.cancelled', { agentRef, harnessId }, { taskId });
      expect(await handleInboundEnvelope(runtime.bound, deviceId, terminal).then((result) => result.outcome)).toBe('accepted');
      await runtime.stores.close();
      runtime = open();
      expect(await runtime.bound.tasks.get(taskId)).toMatchObject({ ...expected, status });
      expect(await runtime.cloud.readTaskResult(tenant, taskId)).toMatchObject({ state: status, harnessId });
    } finally { await runtime.stores.close(); }
  });

  it.each(['pi', 'claude', 'codex', undefined] as const)('preserves built-in or identity-free claim %s without fabricating a harness', async (runtimeId) => {
    const { open } = fixture();
    let runtime = open();
    try {
      await runtime.stores.cloud.devices.register(tenant, { deviceId, productId: 'probe', deviceName: 'fixture',
        devicePublicKey: 'key', proofKeyId: 'proof', proofKeyEpoch: 1 });
      await runtime.bound.devices.recordCapabilities({ capabilities: ['agent-home-contract'] });
      const { taskId } = await runtime.cloud.enqueueAgentOffer(tenant, deviceId, { payload });
      expect(await handleInboundEnvelope(runtime.bound, deviceId, createEnvelope('task.claim', {
        deviceId, agentRef, ...(runtimeId === undefined ? {} : { runtime: runtimeId }),
      }, { taskId })).then((result) => result.outcome)).toBe('accepted');
      await runtime.stores.close(); runtime = open();
      const attempt = await runtime.bound.tasks.get(taskId);
      expect(attempt?.claimedRuntime).toBe(runtimeId);
      expect(attempt?.claimedHarnessId).toBeUndefined();
      expect(await handleInboundEnvelope(runtime.bound, deviceId,
        createEnvelope('task.complete', { agentRef, summary: 'wrong', sessionRef: 's', harnessId }, { taskId })).then((result) => result.outcome)).toBe('rejected');
      expect(await handleInboundEnvelope(runtime.bound, deviceId,
        createEnvelope('task.complete', { agentRef, summary: 'done', sessionRef: 's' }, { taskId })).then((result) => result.outcome)).toBe('accepted');
    } finally { await runtime.stores.close(); }
  });

  function downgradeToV3(path: string): void {
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec("DROP TABLE wake; ALTER TABLE task_attempt DROP COLUMN claimed_harness_id; UPDATE byok_sqlite_meta SET value = '3' WHERE key = 'schema_version'");
    } finally { legacy.close(); }
  }

  function expectUnchangedV3(path: string): void {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value).toBe('3');
      expect(db.prepare('PRAGMA table_info(task_attempt)').all().map(column => column.name)).not.toContain('claimed_harness_id');
    } finally { db.close(); }
  }

  it('refuses identified v3 history without changing its task or receipt authority', async () => {
    const { open, path } = fixture();
    const runtime = open();
    await runtime.stores.cloud.tasks.open(tenant, { taskId: 'identified', deviceId });
    await runtime.stores.cloud.tasks.claim(tenant, { taskId: 'identified', deviceId, runtime: 'pi' });
    await runtime.stores.close();
    downgradeToV3(path);
    expect(() => open()).toThrow(expect.objectContaining({ code: 'SQLITE_SCHEMA_UNSUPPORTED', foundVersion: '3', requiredVersion: '6' }));
    expectUnchangedV3(path);
    const db = new DatabaseSync(path, { readOnly: true });
    try { expect(db.prepare('SELECT claimed_runtime, status FROM task_attempt').get()).toMatchObject({ claimed_runtime: 'pi', status: 'claimed' }); }
    finally { db.close(); }
  });

  it.each(['claimed', 'complete'] as const)('rejects ambiguous v3 %s identity without changing history or schema', async (status) => {
    const { open, path } = fixture();
    const runtime = open();
    await runtime.stores.cloud.tasks.open(tenant, { taskId: 'ambiguous', deviceId });
    await runtime.stores.cloud.tasks.claim(tenant, { taskId: 'ambiguous', deviceId, harnessId });
    if (status === 'complete') await runtime.stores.cloud.tasks.recordStatus(tenant, { taskId: 'ambiguous', status });
    await runtime.stores.close();
    downgradeToV3(path);
    expect(() => open()).toThrow(expect.objectContaining({ code: 'SQLITE_SCHEMA_UNSUPPORTED', foundVersion: '3' }));
    expectUnchangedV3(path);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare('SELECT owner_device_id, claimed_runtime, status FROM task_attempt').get())
        .toMatchObject({ owner_device_id: deviceId, claimed_runtime: null, status });
    } finally { db.close(); }
  });

  it('rejects removed migration selectors without advancing a legacy version', async () => {
    const { open, path } = fixture();
    await open().stores.close();
    downgradeToV3(path);
    for (const selector of ['v1-to-v4', 'v2-to-v4', 'v3-to-v4', 'v1-to-v5', 'v2-to-v5', 'v3-to-v5', 'v4-to-v5']) {
      expect(() => open(selector)).toThrow('migration selectors are not supported');
      expectUnchangedV3(path);
    }
  });

  it('refuses a v6 file missing its claim authority without recreating the column', async () => {
    const { open, path } = fixture();
    await open().stores.close();
    const db = new DatabaseSync(path);
    db.exec('ALTER TABLE task_attempt DROP COLUMN claimed_harness_id');
    db.close();
    expect(() => open()).toThrow('claimed_harness_id');
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      expect(check.prepare('PRAGMA table_info(task_attempt)').all().map(column => column.name)).not.toContain('claimed_harness_id');
    } finally { check.close(); }
  });

});
