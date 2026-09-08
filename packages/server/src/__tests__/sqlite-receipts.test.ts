import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { createByokCloud, createHmacTokenSigner, createWebCrypto, fullCapabilityDeclaration } from '@byok-sdk/cloud';
import { createEnvelope } from '@byok-sdk/protocol';
import { handleInboundEnvelope } from '../../../cloud/src/inbound';
import { tenantStoresFor } from '../../../cloud/src/tenant-stores';
import { createSqliteEmbeddedStores } from '../stores/sqlite';

const tenant = tenantId('receipts');
const other = tenantId('other');
const deviceId = 'device-receipts';
const payload = { instruction: 'original', runtime: 'claude', policy: { mode: 'auto' } } as const;

describe('SQLite receipt recovery', () => {
  const roots: string[] = [];
  afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'byok-receipts-')); roots.push(root);
    const clock = createMutableClock();
    const crypto = createWebCrypto();
    const path = join(root, 'server.sqlite');
    function open(migration?: 'v1-to-v3' | 'v2-to-v3') {
      const stores = createSqliteEmbeddedStores({ path, ...(migration === undefined ? {} : { migration }) }, { clock, crypto });
      const cloud = createByokCloud({ ...stores, clock, crypto,
        tokenSigner: createHmacTokenSigner(new Uint8Array(32), clock), capabilities: fullCapabilityDeclaration() });
      const bound = tenantStoresFor({ kind: 'device', tenantId: tenant, productId: 'probe', deviceId }, stores);
      return { stores, cloud, bound };
    }
    return { open, path };
  }

  it('keeps one immutable winner across independent connections, restart and tenants', async () => {
    const { open } = fixture(); const a = open(); const b = open();
    const input = { key: 'same-key', body: 'original' };
    const winners = await Promise.all([a.stores.cloud.receipts.record(tenant, input), b.stores.cloud.receipts.record(tenant, { ...input, body: 'other' })]);
    expect(winners.filter(result => result.created)).toHaveLength(1);
    expect(winners[0]?.receipt).toEqual(winners[1]?.receipt);
    await a.stores.close(); await b.stores.close();
    const reopened = open();
    try {
      expect(await reopened.stores.cloud.receipts.get(tenant, input.key)).toEqual(winners[0]?.receipt);
      expect(await reopened.stores.cloud.receipts.get(other, input.key)).toBeUndefined();
      expect((await reopened.stores.cloud.receipts.record(other, input)).created).toBe(true);
    } finally { await reopened.stores.close(); }
  });

  it('preserves canonical terminal and refuses same or changed offers after ACK, retention and restart', async () => {
    const { open } = fixture(); let runtime = open();
    const taskId = 'completed-task'; const input = { taskId, payload };
    try {
      const first = await runtime.cloud.enqueueOffer(tenant, deviceId, input);
      expect(await handleInboundEnvelope(runtime.bound, deviceId, createEnvelope('task.claim', { deviceId }, { taskId }))).toBe('accepted');
      expect(await handleInboundEnvelope(runtime.bound, deviceId, createEnvelope('task.complete', { summary: 'first', sessionRef: 'session-first' }, { taskId }))).toBe('accepted');
      const receipt = await runtime.cloud.readTerminalReceipt(tenant, taskId);
      const result = await runtime.cloud.readTaskResult(tenant, taskId);
      await runtime.stores.core.mailbox.recordDelivery(tenant, { deviceId, deliveredSeq: first.seq });
      await runtime.stores.core.mailbox.advanceCursor(tenant, { deviceId, ackedSeq: first.seq });
      await runtime.stores.core.mailbox.collectRetired(tenant, { deviceId, ackedBefore: '2999-01-01T00:00:00.000Z', expireUnackedBefore: '2999-01-01T00:00:00.000Z' });
      await runtime.stores.close(); runtime = open();
      expect(await runtime.cloud.readTaskResult(tenant, taskId)).toEqual(result);
      expect(await runtime.cloud.readTaskResult(other, taskId)).toBeUndefined();
      for (const retry of [input, { taskId, payload: { ...payload, instruction: 'changed' } }]) {
        await expect(runtime.cloud.enqueueOffer(tenant, deviceId, retry)).rejects.toMatchObject({ code: 'coordination_input_invalid' });
      }
      expect((await runtime.stores.core.mailbox.readAfter(tenant, { deviceId, afterSeq: 0 })).messages).toEqual([]);
      expect(await handleInboundEnvelope(runtime.bound, deviceId, createEnvelope('task.complete', { summary: 'conflict', sessionRef: 'session-other' }, { taskId }))).toBe('accepted');
      expect(await runtime.cloud.readTerminalReceipt(tenant, taskId)).toEqual(receipt);
      expect(await runtime.cloud.readTaskResult(tenant, taskId)).toEqual(result);
    } finally { await runtime.stores.close(); }
  });

  it.each(['1', '2'] as const)('adopts only unused schema %s and rejects historical tasks without mutation', async (version) => {
    const { open, path } = fixture(); let runtime = open();
    await runtime.stores.cloud.devices.register(tenant, { deviceId, productId: 'probe', deviceName: 'fixture',
      devicePublicKey: 'key', proofKeyId: 'proof', proofKeyEpoch: 1 });
    await runtime.stores.cloud.tasks.open(tenant, { taskId: 'historical', deviceId });
    await runtime.stores.close();
    const db = new DatabaseSync(path);
    db.exec('DROP TABLE request_receipt');
    if (version === '1') db.exec('DROP TABLE device_directory');
    db.prepare("UPDATE byok_sqlite_meta SET value = ? WHERE key = 'schema_version'").run(version);
    db.close();
    const migration = version === '1' ? 'v1-to-v3' : 'v2-to-v3';
    expect(() => open()).toThrow('Unsupported BYOK SQLite schema version');
    expect(() => open(migration)).toThrow('historical receipts are unavailable');
    const check = new DatabaseSync(path);
    expect(check.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value).toBe(version);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'request_receipt'").get()).toBeUndefined();
    expect(check.prepare('SELECT task_id FROM task_attempt').get()?.task_id).toBe('historical');
    // Test-only reset: production instructions explicitly forbid deleting history to pass migration.
    check.exec('DELETE FROM task_attempt'); check.close();
    runtime = open(migration);
    try {
      expect(await runtime.stores.cloud.receipts.get(tenant, 'absent')).toBeUndefined();
      expect((await runtime.stores.cloud.devices.list(tenant)).length).toBe(version === '1' ? 0 : 1);
    } finally { await runtime.stores.close(); }
    const current = new DatabaseSync(path, { readOnly: true });
    expect(current.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value).toBe('3');
    current.close();
  });

  it('fails closed when the durable receipt authority is missing', async () => {
    const { open, path } = fixture(); await open().stores.close();
    const db = new DatabaseSync(path); db.exec('DROP TABLE request_receipt'); db.close();
    expect(() => open()).toThrow();
    const check = new DatabaseSync(path, { readOnly: true });
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'request_receipt'").get()).toBeUndefined();
    check.close();
  });

  it('preserves immutable offer before failed append and resumes only the original payload', async () => {
    const { open, path } = fixture(); let runtime = open();
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER fail_append BEFORE INSERT ON mailbox_message BEGIN SELECT RAISE(ABORT, 'injected append failure'); END;"); db.close();
    const input = { taskId: 'pre-append', payload };
    try {
      await expect(runtime.cloud.enqueueOffer(tenant, deviceId, input)).rejects.toThrow('injected append failure');
      await runtime.stores.close();
      const reset = new DatabaseSync(path); reset.exec('DROP TRIGGER fail_append'); reset.close();
      runtime = open();
      await expect(runtime.cloud.enqueueOffer(tenant, deviceId, { ...input, payload: { ...payload, instruction: 'changed' } })).rejects.toMatchObject({ code: 'coordination_input_invalid' });
      await runtime.cloud.enqueueOffer(tenant, deviceId, input);
      expect((await runtime.stores.core.mailbox.readAfter(tenant, { deviceId, afterSeq: 0 })).messages).toHaveLength(1);
    } finally { await runtime.stores.close(); }
  });

  it('resumes the same mailbox row after append but before delivered receipt commit', async () => {
    const { open, path } = fixture(); let runtime = open();
    const db = new DatabaseSync(path);
    db.exec("CREATE TRIGGER fail_delivered BEFORE INSERT ON request_receipt WHEN NEW.key LIKE 'task-offer-delivered:%' BEGIN SELECT RAISE(ABORT, 'injected delivered failure'); END;"); db.close();
    const input = { taskId: 'post-append', payload };
    try {
      await expect(runtime.cloud.enqueueOffer(tenant, deviceId, input)).rejects.toThrow('injected delivered failure');
      const before = (await runtime.stores.core.mailbox.readAfter(tenant, { deviceId, afterSeq: 0 })).messages;
      expect(before).toHaveLength(1);
      await runtime.stores.close();
      const reset = new DatabaseSync(path); reset.exec('DROP TRIGGER fail_delivered'); reset.close();
      runtime = open();
      await runtime.cloud.enqueueOffer(tenant, deviceId, input);
      expect((await runtime.stores.core.mailbox.readAfter(tenant, { deviceId, afterSeq: 0 })).messages).toEqual(before);
    } finally { await runtime.stores.close(); }
  });


  it('rejects cleaned legacy delivery history and a v3 table missing its composite primary key', async () => {
    const { open, path } = fixture(); await open().stores.close();
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE request_receipt; UPDATE byok_sqlite_meta SET value = '2' WHERE key = 'schema_version'; INSERT INTO mailbox_cursor VALUES ('receipts', 'device-receipts', 2, 1, 1, '2026-01-01T00:00:00.000Z')");
    db.close();
    expect(() => open('v2-to-v3')).toThrow('delivery history');
    const corrupt = new DatabaseSync(path);
    expect(corrupt.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value).toBe('2');
    corrupt.exec("UPDATE byok_sqlite_meta SET value = '3' WHERE key = 'schema_version'; CREATE TABLE request_receipt (tenant_id TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, recorded_at TEXT NOT NULL)");
    corrupt.close();
    expect(() => open()).toThrow('Invalid BYOK SQLite request receipt schema');
  });

  it('keeps cancellation result authority after reopen', async () => {
    const { open } = fixture(); let runtime = open();
    try {
      await runtime.cloud.enqueueOffer(tenant, deviceId, { taskId: 'cancelled-task', payload });
      await runtime.cloud.cancelTask(tenant, 'cancelled-task', 'host-cancel');
      const result = await runtime.cloud.readTaskResult(tenant, 'cancelled-task');
      expect(result?.state).toBe('cancelled');
      await runtime.stores.close(); runtime = open();
      expect(await runtime.cloud.readTaskResult(tenant, 'cancelled-task')).toEqual(result);
    } finally { await runtime.stores.close(); }
  });

});
