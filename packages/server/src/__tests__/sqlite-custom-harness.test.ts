import { createInProcessMailboxWake } from '@byok-sdk/cloud';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { createByokCloud, createHmacTokenSigner, createWebCrypto, fullCapabilityDeclaration } from '@byok-sdk/cloud';
import { createEnvelope, type ClaimedExecutor } from '@byok-sdk/protocol';
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
const HARNESS: ClaimedExecutor = { kind: 'harness', harnessId };
const OTHER_HARNESS: ClaimedExecutor = { kind: 'harness', harnessId: 'other' };
const PI: ClaimedExecutor = { kind: 'runtime', runtimeId: 'pi' };

describe('SQLite custom-harness claim authority', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'byok-custom-harness-'));
    roots.push(root);
    const path = join(root, 'server.sqlite');
    const clock = createMutableClock();
    const crypto = createWebCrypto();
    const open = () => {
      const embedded = createSqliteEmbeddedStores({ path }, { clock, crypto });
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
      const cloud = createByokCloud({
        proofReceiptRetention: { authority: stores.proofReceiptAuthority },
        ...stores, clock, crypto,
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
        payload: { ...payload, target: selection === 'explicit' ? { lane: 'harness', harnessId } : { lane: 'auto' } },
      });
      const taskId = offer.taskId;
      const claim = createEnvelope('task.claim', { executor: HARNESS, deviceId, agentRef, capabilities }, { taskId });
      expect(await handleInboundEnvelope(runtime.bound, deviceId, claim).then((result) => result.outcome)).toBe('accepted');
      const expected = { ownerDeviceId: deviceId, claimedExecutor: HARNESS,
        claimedRuntimeCapabilities: capabilities, status: 'claimed' };
      expect(await runtime.bound.tasks.get(taskId)).toMatchObject(expected);
      await runtime.stores.close();
      runtime = open();
      expect(await runtime.bound.tasks.get(taskId)).toMatchObject(expected);
      expect(await runtime.stores.cloud.tasks.getMany(tenant, [taskId])).toMatchObject([expected]);
      expect((await runtime.stores.cloud.tasks.list(tenant, { limit: 10 })).attempts).toMatchObject([expected]);
      expect(await handleInboundEnvelope(runtime.bound, deviceId, claim).then((result) => result.outcome)).toBe('accepted');
      for (const executor of [OTHER_HARNESS, PI]) {
        expect(await handleInboundEnvelope(runtime.bound, deviceId,
          createEnvelope('task.claim', { executor, deviceId, agentRef }, { taskId })).then((result) => result.outcome)).toBe('rejected');
      }
      // Mutable inventory is not authority for this already-claimed execution.
      await runtime.bound.devices.recordCapabilities({ capabilities: [], harnesses: [] });
      for (const executor of [OTHER_HARNESS, PI]) {
        for (const terminal of [
          createEnvelope('task.complete', { executor, agentRef, summary: 'wrong', sessionRef: 's' }, { taskId }),
          createEnvelope('task.fail', { executor, agentRef, reason: 'wrong', retryable: false }, { taskId }),
          createEnvelope('task.cancelled', { executor, agentRef }, { taskId }),
        ]) expect(await handleInboundEnvelope(runtime.bound, deviceId, terminal).then((result) => result.outcome)).toBe('rejected');
      }
      // After a claim, a failure or cancellation must echo the claimed executor.
      for (const terminal of [
        createEnvelope('task.fail', { agentRef, reason: 'wrong', retryable: false }, { taskId }),
        createEnvelope('task.cancelled', { agentRef }, { taskId }),
      ]) expect(await handleInboundEnvelope(runtime.bound, deviceId, terminal).then((result) => result.outcome)).toBe('rejected');
      expect(await runtime.cloud.readTerminalReceipt(tenant, taskId)).toBeUndefined();
      expect(await runtime.bound.tasks.get(taskId)).toMatchObject(expected);
      const terminal = status === 'complete'
        ? createEnvelope('task.complete', { executor: HARNESS, agentRef, summary: 'done', sessionRef: 's' }, { taskId })
        : status === 'failed'
          ? createEnvelope('task.fail', { executor: HARNESS, agentRef, reason: 'fixture-failure', retryable: false }, { taskId })
          : createEnvelope('task.cancelled', { executor: HARNESS, agentRef }, { taskId });
      expect(await handleInboundEnvelope(runtime.bound, deviceId, terminal).then((result) => result.outcome)).toBe('accepted');
      await runtime.stores.close();
      runtime = open();
      expect(await runtime.bound.tasks.get(taskId)).toMatchObject({ ...expected, status });
      expect(await runtime.cloud.readTaskResult(tenant, taskId)).toMatchObject({ state: status });
      expect((await runtime.cloud.readDeviceTerminal(tenant, taskId))?.envelope.payload).toMatchObject({ executor: HARNESS });
    } finally { await runtime.stores.close(); }
  });

  it.each(['pi', 'claude', 'codex'] as const)('preserves built-in claim %s without fabricating a harness', async (runtimeId) => {
    const executor: ClaimedExecutor = { kind: 'runtime', runtimeId };
    const { open } = fixture();
    let runtime = open();
    try {
      await runtime.stores.cloud.devices.register(tenant, { deviceId, productId: 'probe', deviceName: 'fixture',
        devicePublicKey: 'key', proofKeyId: 'proof', proofKeyEpoch: 1 });
      await runtime.bound.devices.recordCapabilities({ capabilities: ['agent-home-contract'] });
      const { taskId } = await runtime.cloud.enqueueAgentOffer(tenant, deviceId, { payload: { ...payload, target: { lane: 'auto' } } });
      expect(await handleInboundEnvelope(runtime.bound, deviceId, createEnvelope('task.claim', {
        deviceId, agentRef, executor,
      }, { taskId })).then((result) => result.outcome)).toBe('accepted');
      await runtime.stores.close(); runtime = open();
      const attempt = await runtime.bound.tasks.get(taskId);
      expect(attempt?.claimedExecutor).toEqual(executor);
      expect(await handleInboundEnvelope(runtime.bound, deviceId,
        createEnvelope('task.complete', { executor: HARNESS, agentRef, summary: 'wrong', sessionRef: 's' }, { taskId })).then((result) => result.outcome)).toBe('rejected');
      expect(await handleInboundEnvelope(runtime.bound, deviceId,
        createEnvelope('task.complete', { executor, agentRef, summary: 'done', sessionRef: 's' }, { taskId })).then((result) => result.outcome)).toBe('accepted');
    } finally { await runtime.stores.close(); }
  });

  it('refuses a task attempt row that names both a claimed runtime and a claimed harness', async () => {
    const { open, path } = fixture();
    const runtime = open();
    try {
      await runtime.stores.cloud.tasks.reserveAgentOffer(tenant, { taskId: 'both', deviceId, agentRef });
    } finally { await runtime.stores.close(); }
    const db = new DatabaseSync(path);
    try {
      expect(() => db.prepare("UPDATE task_attempt SET claimed_runtime = 'pi', claimed_harness_id = ? WHERE task_id = 'both'").run(harnessId))
        .toThrow(/CHECK constraint failed/);
      expect(db.prepare("SELECT claimed_runtime, claimed_harness_id FROM task_attempt WHERE task_id = 'both'").get())
        .toEqual({ claimed_runtime: null, claimed_harness_id: null });
    } finally { db.close(); }
  });

  it('refuses a file missing its claim authority without recreating the column', async () => {
    const { open, path } = fixture();
    await open().stores.close();
    const db = new DatabaseSync(path);
    // The executor CHECK names the column, so it cannot be dropped; renamed, it is just as missing.
    db.exec('ALTER TABLE task_attempt RENAME COLUMN claimed_harness_id TO claimed_harness_removed');
    db.close();
    expect(() => open()).toThrow('claimed_harness_id');
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      expect(check.prepare('PRAGMA table_info(task_attempt)').all().map(column => column.name)).not.toContain('claimed_harness_id');
    } finally { check.close(); }
  });

});
