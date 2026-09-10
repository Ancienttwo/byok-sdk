import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { createByokCloud, createHmacTokenSigner, createWebCrypto, fullCapabilityDeclaration, RecurringExecutionInputSchema } from '@byok-sdk/cloud';
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
        tokenSigner: createHmacTokenSigner(new Uint8Array(32), clock), capabilities: fullCapabilityDeclaration(),
        agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
      const bound = tenantStoresFor({ kind: 'device', tenantId: tenant, productId: 'probe', deviceId }, stores);
      return { stores, cloud, bound };
    }
    return { open, path };
  }

  it.each(['accepted', 'held', 'refused'] as const)('recovers pending then immutable %s message disposition across SQLite reopen', async (outcome) => {
    const { open, path } = fixture(); let runtime = open();
    const taskId = `message-${outcome}`;
    const agentRef = { agentId: 'receipt-agent', profileRevision: 'profile-v1' };
    const message = createEnvelope('agent.message.publish', {
      agentRef, sessionRef: 'native-session', contract: 'conversation-turn/v1',
      messageId: '10000000-0000-4000-8000-000000000099', cursor: 1,
      contentType: 'text/markdown', body: 'hello', byteCount: 5,
      contentHash: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    }, { taskId });
    let calls = 0;
    const consume = async () => { calls++; return { outcome }; };
    const read = () => runtime.cloud.readAgentMessageDisposition(tenant, deviceId, taskId, message.payload);
    const discover = () => runtime.cloud.readTaskAgentMessage(tenant, deviceId, taskId, agentRef);
    try {
      await runtime.stores.cloud.devices.register(tenant, { deviceId, productId: 'probe', deviceName: 'fixture',
        devicePublicKey: 'key', proofKeyId: 'proof', proofKeyEpoch: 1 });
      await runtime.stores.cloud.devices.recordCapabilities(tenant, { deviceId, capabilities: [
        'agent-home-contract', 'agent-egress-policy', 'agent-egress-reliable-ack', 'agent-message-egress',
        'terminal-projection-selection', 'agent-egress-fresh-session',
      ] });
      const execution = RecurringExecutionInputSchema.parse({ taskId, deviceId, payload: {
        instruction: 'reply', runtime: 'codex', agentRef, policy: { mode: 'auto' },
        egressPolicy: { policyRevision: 'policy-v1', activity: { mode: 'metadata-status', delivery: 'latest-value' },
          reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
          transfers: { workspace: { maxBytes: 512, allowedMimeTypes: ['text/plain'] }, transcript: 'disabled', artifact: 'disabled' } },
        messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 },
        terminalProjection: { mode: 'none' },
      }, agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'turn' } });
      const persistedInput = JSON.stringify(execution);
      const appendFault = new DatabaseSync(path);
      appendFault.exec("CREATE TRIGGER fail_recurring_append BEFORE INSERT ON mailbox_message BEGIN SELECT RAISE(ABORT, 'injected recurring append'); END;");
      appendFault.close();
      await expect(runtime.cloud.submitRecurringExecution(tenant, JSON.parse(persistedInput))).rejects.toThrow('injected recurring append');
      expect(await runtime.cloud.readTaskOffer(tenant, taskId)).toMatchObject({ delivered: false });
      await runtime.stores.close(); runtime = open();
      const removeAppendFault = new DatabaseSync(path); removeAppendFault.exec('DROP TRIGGER fail_recurring_append'); removeAppendFault.close();
      await expect(runtime.cloud.submitRecurringExecution(tenant, { ...execution,
        agentMessageContext: { destinationBinding: 'different' } })).rejects.toThrow();
      await runtime.cloud.submitRecurringExecution(tenant, JSON.parse(persistedInput));
      expect(await runtime.cloud.readTaskOffer(tenant, taskId)).toMatchObject({ delivered: true, payload: execution.payload });
      expect((await runtime.stores.core.mailbox.readAfter(tenant, { deviceId, afterSeq: 0 })).messages).toHaveLength(1);

      const fault = new DatabaseSync(path);
      fault.exec("CREATE TRIGGER fail_message_finalize BEFORE UPDATE OF terminal_body ON agent_message_admission BEGIN SELECT RAISE(ABORT, 'injected finalize fault'); END;");
      fault.close();
      await expect(handleInboundEnvelope(runtime.bound, deviceId, message, undefined, consume)).rejects.toThrow('injected finalize fault');
      expect(calls).toBe(1);
      expect(await read()).toBeUndefined();
      await runtime.stores.close(); runtime = open();
      expect(await read()).toBeUndefined();
      expect(await discover()).toEqual({ payload: message.payload, context: execution.agentMessageContext });
      const repair = new DatabaseSync(path); repair.exec('DROP TRIGGER fail_message_finalize'); repair.close();
      expect(await handleInboundEnvelope(runtime.bound, deviceId, message, undefined, consume)).toBe('accepted');
      expect(calls).toBe(2);
      const receipt = await read();
      expect(receipt).toMatchObject({ outcome, messageId: message.payload.messageId, agentRef });
      await runtime.cloud.cancelTask(tenant, taskId, 'stop remaining');
      await runtime.stores.close(); runtime = open();
      expect(await read()).toEqual(receipt);
      expect(await discover()).toEqual({ payload: message.payload, context: execution.agentMessageContext, disposition: receipt });
      expect(await runtime.cloud.readTaskAgentMessage(other, deviceId, taskId, agentRef)).toBeUndefined();
      expect(await runtime.cloud.readTaskAgentMessage(tenant, 'other-device', taskId, agentRef)).toBeUndefined();
      expect(await runtime.cloud.readTaskAgentMessage(tenant, deviceId, taskId, { ...agentRef, profileRevision: 'other' })).toBeUndefined();
      expect(await runtime.cloud.readAgentMessageDisposition(other, deviceId, taskId, message.payload)).toBeUndefined();
      expect(await runtime.cloud.readAgentMessageDisposition(tenant, 'other-device', taskId, message.payload)).toBeUndefined();
      // Envelope dedup is process-local; durable message replay must still skip the consumer.
      expect(await handleInboundEnvelope(runtime.bound, deviceId, message, undefined, consume)).toBe('accepted');
      expect(calls).toBe(2);
      expect(await read()).toEqual(receipt);
    } finally { await runtime.stores.close(); }
  });

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
      const deviceTerminal = await runtime.cloud.readDeviceTerminal(tenant, taskId);
      await runtime.stores.core.mailbox.recordDelivery(tenant, { deviceId, deliveredSeq: first.seq });
      await runtime.stores.core.mailbox.advanceCursor(tenant, { deviceId, ackedSeq: first.seq });
      await runtime.stores.core.mailbox.collectRetired(tenant, { deviceId, ackedBefore: '2999-01-01T00:00:00.000Z', expireUnackedBefore: '2999-01-01T00:00:00.000Z' });
      await runtime.stores.close(); runtime = open();
      expect(await runtime.cloud.readTaskResult(tenant, taskId)).toEqual(result);
      expect(await runtime.cloud.readDeviceTerminal(tenant, taskId)).toEqual(deviceTerminal);
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
      expect(await runtime.cloud.readTaskOffer(tenant, input.taskId)).toMatchObject({ delivered: false, payload });
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


  it('reads only validated immutable offer authority and rejects corrupt receipts', async () => {
    const { open, path } = fixture(); const runtime = open();
    const taskId = 'offer-readback';
    try {
      await runtime.stores.cloud.tasks.open(tenant, { taskId: 'unsubmitted', deviceId });
      expect(await runtime.cloud.readTaskOffer(tenant, 'unsubmitted')).toBeUndefined();
      const enqueued = await runtime.cloud.enqueueOffer(tenant, deviceId, { taskId, payload });
      const original = await runtime.cloud.readTaskOffer(tenant, taskId);
      expect(original).toMatchObject({ taskId, deviceId, messageId: enqueued.envelope.id, delivered: true,
        type: 'task.offer', payload });
      expect(await runtime.cloud.readTaskOffer(other, taskId)).toBeUndefined();
      const db = new DatabaseSync(path);
      const key = `task-offer:${enqueued.envelope.id}`;
      const body = db.prepare('SELECT body FROM request_receipt WHERE tenant_id = ? AND key = ?').get(tenant, key)?.body as string;
      try {
        for (const corrupted of ['{', 'null', JSON.stringify({ ...JSON.parse(body), deviceId: 'foreign' }),
          JSON.stringify({ ...JSON.parse(body), type: 'task.complete' }),
          JSON.stringify({ ...JSON.parse(body), payload: { ...payload, instruction: 17 } })]) {
          db.prepare('UPDATE request_receipt SET body = ? WHERE tenant_id = ? AND key = ?').run(corrupted, tenant, key);
          await expect(runtime.cloud.readTaskOffer(tenant, taskId)).rejects.toMatchObject({ code: 'coordination_input_invalid' });
        }
        db.prepare('UPDATE request_receipt SET body = ? WHERE tenant_id = ? AND key = ?').run(body, tenant, key);
        db.prepare('UPDATE request_receipt SET body = ? WHERE tenant_id = ? AND key = ?').run('wrong-id', tenant, `task-offer-delivered:${enqueued.envelope.id}`);
        await expect(runtime.cloud.readTaskOffer(tenant, taskId)).rejects.toMatchObject({ code: 'coordination_input_invalid' });
      } finally { db.close(); }
    } finally { await runtime.stores.close(); }
  });

});
