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
import { createSqliteEmbeddedStores, type SqliteEmbeddedStoreOptions } from '../stores/sqlite';
import { TEST_AGENT_DISPATCH, TEST_AGENT_REF } from './test-support';

const tenant = tenantId('custom-harness');
const deviceId = 'custom-device';
const harnessId = 'acme-harness';
const capabilities = { steer: true };
const payload = { ...TEST_AGENT_DISPATCH, instruction: 'run custom adapter' } as const;
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
    const open = (migration?: SqliteEmbeddedStoreOptions['migration']) => {
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

  it('explicitly adopts v3 unclaimed offers and identified built-in history without inventing identities', async () => {
    const { open, path } = fixture();
    let runtime = open();
    await runtime.stores.cloud.devices.register(tenant, { deviceId, productId: 'probe', deviceName: 'fixture',
      devicePublicKey: 'key', proofKeyId: 'proof', proofKeyEpoch: 1 });
    await runtime.bound.devices.recordCapabilities({ capabilities: ['agent-home-contract', 'custom-harness'], harnesses: [{ id: harnessId, capabilities }] });
    const { taskId } = await runtime.cloud.enqueueAgentOffer(tenant, deviceId, { payload: { ...payload, harnessId } });
    for (const status of ['claimed', 'complete'] as const) {
      const id = `builtin-${status}`;
      await runtime.stores.cloud.tasks.open(tenant, { taskId: id, deviceId });
      await runtime.stores.cloud.tasks.claim(tenant, { taskId: id, deviceId, runtime: 'pi' });
      if (status === 'complete') await runtime.stores.cloud.tasks.recordStatus(tenant, { taskId: id, status });
    }
    const offer = await runtime.cloud.readTaskOffer(tenant, taskId);
    await runtime.stores.close();
    downgradeToV3(path);
    expect(() => open()).toThrow('v3-to-v5');
    expectUnchangedV3(path);
    // Old selectors must fail explicitly rather than silently upgrading past v3.
    for (const migration of ['v1-to-v4', 'v2-to-v4', 'v3-to-v4']) {
      expect(() => open(migration as SqliteEmbeddedStoreOptions['migration'])).toThrow('Target-v4 migration selectors are no longer supported');
      expectUnchangedV3(path);
    }
    runtime = open('v3-to-v5');
    try {
      expect(await runtime.cloud.readTaskOffer(tenant, taskId)).toEqual(offer);
      expect((await runtime.bound.tasks.get(taskId))?.claimedHarnessId).toBeUndefined();
      for (const status of ['claimed', 'complete'] as const) {
        const attempt = await runtime.bound.tasks.get(`builtin-${status}`);
        expect(attempt).toMatchObject({ status, ownerDeviceId: deviceId, claimedRuntime: 'pi' });
        expect(attempt?.claimedHarnessId).toBeUndefined();
      }
      expect(await handleInboundEnvelope(runtime.bound, deviceId,
        createEnvelope('task.claim', { deviceId, agentRef, harnessId }, { taskId })).then((result) => result.outcome)).toBe('accepted');
      await runtime.stores.close(); runtime = open();
      expect(await runtime.bound.tasks.get(taskId)).toMatchObject({ claimedHarnessId: harnessId });
      await runtime.stores.close();
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        expect(db.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value).toBe('5');
      } finally { db.close(); }
    } finally { await runtime.stores.close(); }
  });

  it.each(['claimed', 'complete'] as const)('rejects ambiguous v3 %s identity without changing history or schema', async (status) => {
    const { open, path } = fixture();
    const runtime = open();
    await runtime.stores.cloud.tasks.open(tenant, { taskId: 'ambiguous', deviceId });
    await runtime.stores.cloud.tasks.claim(tenant, { taskId: 'ambiguous', deviceId, harnessId });
    if (status === 'complete') await runtime.stores.cloud.tasks.recordStatus(tenant, { taskId: 'ambiguous', status });
    await runtime.stores.close();
    downgradeToV3(path);
    expect(() => open('v3-to-v5')).toThrow('historical harness identities are unavailable');
    expectUnchangedV3(path);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      expect(db.prepare('SELECT owner_device_id, claimed_runtime, status FROM task_attempt').get())
        .toMatchObject({ owner_device_id: deviceId, claimed_runtime: null, status });
    } finally { db.close(); }
  });

  it('rolls back the new column when version advancement fails and retries cleanly', async () => {
    const { open, path } = fixture();
    await open().stores.close();
    downgradeToV3(path);
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER fail_version BEFORE UPDATE ON byok_sqlite_meta BEGIN SELECT RAISE(ABORT, 'injected version failure'); END");
    db.close();
    expect(() => open('v3-to-v5')).toThrow('injected version failure');
    expectUnchangedV3(path);
    const repair = new DatabaseSync(path);
    repair.exec('DROP TRIGGER fail_version');
    repair.close();
    await open('v3-to-v5').stores.close();
    await open().stores.close();
  });

  it('refuses a v5 file missing its claim authority without recreating the column', async () => {
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
