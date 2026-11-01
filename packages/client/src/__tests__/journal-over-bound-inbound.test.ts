import { FRESH_DAEMON_EGRESS, FRESH_OFFER } from './fixtures/fresh-offer';
import { freshTestAgentRef, testAgentHomeConfig } from './fixtures/test-agent';
/**
 * #826: an inbound envelope above the journal record bound must not stall the
 * redelivery cursor. A task-opening envelope is declined once, durably and
 * non-retryably, without storing its bytes. Any other envelope over the bound
 * is dropped. Either way the cursor moves past it.
 */
import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  EnvelopeSchema,
  PROTOCOL_VERSION,
  createEnvelope,
  encodeEnvelope,
  type Envelope,
  type MessageType,
} from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { CursorStore } from '../daemon/cursor-store';
import { JournalRecordTooLargeError, JournalUnavailableError, journalHash, type JournalIdentity } from '../daemon/journal/journal';
import { DEFAULT_JOURNAL_BUSY_TIMEOUT_MS, JOURNAL_DB_FILENAME, SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';
import { openJournalDatabase } from '../util/sqlite-support';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const corpus = readFileSync(new URL('../../../protocol/src/__tests__/golden/v5.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: MessageType; payload: Record<string, unknown> });

const EVENTUAL_STATE_BUDGET_MS = 4_000;
/** Above the inbound floor (415083 bytes) and the default record bound. */
const OVER_BOUND = 500 * 1024;
const IDENTITY: JournalIdentity = { tenantId: 'tenant-a', productId: 'test-product', deviceId: 'dev_1' };
const DECLINE_REASON = 'inbound_envelope_too_large';

function golden(type: MessageType, predicate: (payload: Record<string, unknown>) => boolean = () => true): Record<string, unknown> {
  const line = corpus.find((candidate) => candidate.type === type && predicate(candidate.payload));
  if (line === undefined) throw new Error(`no golden line for ${type}`);
  return line.payload;
}

function envelopeOf(type: MessageType, taskId: string, seq: number, payload: Record<string, unknown>): Envelope {
  return EnvelopeSchema.parse({ v: PROTOCOL_VERSION, id: randomUUID(), ts: new Date().toISOString(), type, task_id: taskId, seq, payload });
}

const dirs: string[] = [];
let daemon: Daemon | undefined;
let server: TestServer | undefined;

afterEach(async () => {
  await daemon?.stop(); daemon = undefined;
  await server?.close(); server = undefined;
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-over-bound-'));
  dirs.push(dir);
  return dir;
}

function rows(storeDir: string, sql: string): Record<string, unknown>[] {
  const db = openJournalDatabase(path.join(storeDir, JOURNAL_DB_FILENAME), DEFAULT_JOURNAL_BUSY_TIMEOUT_MS);
  try { return db.prepare(sql).all() as Record<string, unknown>[]; }
  finally { db.close(); }
}

async function start() {
  const root = await tmp();
  server = await TestServer.start();
  const storeDir = path.join(root, 'store');
  daemon = createDaemonWithAdapters({agentHome: testAgentHomeConfig(), agentEgress: FRESH_DAEMON_EGRESS,
    storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Over-bound journal test', productId: 'over-bound-journal-test',
    serverUrl: server.url, storeDir,
  }, [new StubRuntimeAdapter('pi')]);
  const device = await daemon.pair('pair-code');
  await daemon.start();
  const cursor = () => new CursorStore(storeDir).load(server!.url, device.deviceId);
  return { storeDir, server, cursor };
}

describe('a task-opening envelope over the journal bound (#826)', () => {
  it('declines an offer once, journals no bytes, and lets the next offer be acked', async () => {
    const { storeDir, server, cursor } = await start();
    const big = createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'x'.repeat(OVER_BOUND), ...FRESH_OFFER }, { taskId: 'big', seq: server.nextSeq() });
    const small = createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'hi', ...FRESH_OFFER }, { taskId: 'small', seq: server.nextSeq() });
    server.send(big);
    server.send(small);

    const decline = await server.waitFor((event) => event.type === 'task.decline' && event.task_id === 'big');
    expect(decline.payload).toEqual({ reason: DECLINE_REASON, retryable: false, agentRef: big.payload.agentRef });
    await vi.waitFor(async () => expect(await cursor()).toBe(small.seq), EVENTUAL_STATE_BUDGET_MS);
    const length = Buffer.byteLength(encodeEnvelope(big));
    expect(rows(storeDir, `SELECT bytes, bytes_hash, withheld_bytes FROM journal_envelope WHERE envelope_id = '${big.id}'`))
      .toEqual([{ bytes: '', bytes_hash: journalHash(encodeEnvelope(big)), withheld_bytes: length }]);
    expect(rows(storeDir, "SELECT local_state FROM journal_task WHERE task_id = 'big'")).toEqual([{ local_state: 'terminal:declined' }]);
    expect(rows(storeDir, "SELECT terminal_type FROM journal_terminal WHERE task_id = 'big'")).toEqual([{ terminal_type: 'declined' }]);
    expect(server.received.filter((event) => event.task_id === 'big').map((event) => event.type)).toEqual(['task.decline']);
  });

  it('echoes the agentRef of an Agent offer on its decline', async () => {
    const { server, cursor } = await start();
    const payload = golden('task.offer', (candidate) => candidate.sealing === undefined);
    const big = envelopeOf('task.offer', 'big-agent', server.nextSeq(), { ...payload, instruction: 'x'.repeat(OVER_BOUND) });
    server.send(big);

    const decline = await server.waitFor((event) => event.type === 'task.decline' && event.task_id === 'big-agent');
    expect(decline.payload).toEqual({ reason: DECLINE_REASON, retryable: false, agentRef: payload.agentRef });
    await vi.waitFor(async () => expect(await cursor()).toBe(big.seq), EVENTUAL_STATE_BUDGET_MS);
  });

  it('declines a sealed offer whose plaintext metadata passes the inline floor', async () => {
    const { server, cursor } = await start();
    // v4 caps `session.sessionRef` at 512 characters, so no valid plaintext member of an offer that carries ciphertext
    // can pass the inline floor; an offer with `sealing` and no `sealed` still takes the sealed floor and has a free-text member.
    const payload = golden('task.offer', (candidate) => candidate.sealing !== undefined && candidate.sealed === undefined && typeof candidate.instruction === 'string');
    const big = envelopeOf('task.offer', 'big-sealed', server.nextSeq(), {
      ...payload,
      instruction: 'x'.repeat(OVER_BOUND),
    });
    server.send(big);

    const decline = await server.waitFor((event) => event.type === 'task.decline' && event.task_id === 'big-sealed');
    expect(decline.payload).toEqual({ reason: DECLINE_REASON, retryable: false, agentRef: payload.agentRef });
    await vi.waitFor(async () => expect(await cursor()).toBe(big.seq), EVENTUAL_STATE_BUDGET_MS);
  });

  it('serves a later offer for a withheld task from the stored decline', async () => {
    const { storeDir, server, cursor } = await start();
    const big = createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'x'.repeat(OVER_BOUND), ...FRESH_OFFER }, { taskId: 'reused', seq: server.nextSeq() });
    server.send(big);
    await server.waitFor((event) => event.type === 'task.decline' && event.task_id === 'reused');
    await vi.waitFor(async () => expect(await cursor()).toBe(big.seq), EVENTUAL_STATE_BUDGET_MS);

    const again = createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'hi', ...FRESH_OFFER }, { taskId: 'reused', seq: server.nextSeq() });
    server.send(again);
    await vi.waitFor(async () => expect(await cursor()).toBe(again.seq), EVENTUAL_STATE_BUDGET_MS);
    expect(server.received.filter((event) => event.task_id === 'reused').map((event) => event.type)).toEqual(['task.decline']);
    expect(rows(storeDir, "SELECT local_state FROM journal_task WHERE task_id = 'reused'")).toEqual([{ local_state: 'terminal:declined' }]);
  });
});

describe('a non-opening envelope over the journal bound (#826)', () => {
  it.each([
    ['task.steer', { text: 's'.repeat(OVER_BOUND) }],
    ['task.cancel', { reason: 'c'.repeat(OVER_BOUND) }],
    ['task.reject', { reason: 'r'.repeat(OVER_BOUND), approvalId: 'approval-over-bound' }],
  ] as const)('drops %s without journaling it and moves the cursor', async (type, payload) => {
    const { storeDir, server, cursor } = await start();
    const envelope = createEnvelope(type, payload, { taskId: 'no-such-task', seq: server.nextSeq() });
    server.send(envelope);

    await vi.waitFor(async () => expect(await cursor()).toBe(envelope.seq), EVENTUAL_STATE_BUDGET_MS);
    expect(rows(storeDir, 'SELECT envelope_id FROM journal_envelope')).toEqual([]);
    expect(server.received.filter((event) => event.task_id === 'no-such-task')).toEqual([]);
  });
});

describe('the withheld offer record of the journal (#826)', () => {
  function withheld(envelopeId: string, taskId: string) {
    const decline = encodeEnvelope(createEnvelope('task.decline', { reason: DECLINE_REASON, retryable: false }, { taskId }));
    return {
      identity: IDENTITY, envelopeId, taskId, seq: 1, bytesHash: journalHash('withheld'), byteLength: OVER_BOUND,
      receivedAt: '2026-10-24T00:00:00.000Z', decline: { bytes: decline, payloadHash: journalHash(decline) },
    };
  }

  it('is idempotent by envelope id', async () => {
    const storeDir = await tmp();
    const journal = new SqliteLocalTaskJournal({ storeDir });
    try {
      const record = withheld(randomUUID(), 'task-1');
      await expect(journal.appendWithheldOffer(record)).resolves.toMatchObject({ created: true, bytesHash: record.bytesHash });
      await expect(journal.appendWithheldOffer(record)).resolves.toMatchObject({ created: false, bytesHash: record.bytesHash });
      await expect(journal.readTask('task-1', IDENTITY)).resolves.toMatchObject({ localState: 'terminal:declined', withheldEnvelopeBytes: OVER_BOUND });
      await expect(journal.listRecoveryTasks(IDENTITY)).resolves.toEqual([]);
      const pending = await journal.listPendingTerminals(IDENTITY);
      expect(pending.map((terminal) => [terminal.taskId, terminal.terminalType, terminal.bytes])).toEqual([['task-1', 'declined', record.decline.bytes]]);
    } finally { await journal.close(); }
    expect(rows(storeDir, 'SELECT COUNT(*) AS n FROM journal_envelope')).toEqual([{ n: 1 }]);
  });

  it.each(['append:after-envelope', 'append:after-task', 'append:after-receipt'] as const)('writes nothing when it fails at %s', async (step) => {
    const storeDir = await tmp();
    const journal = new SqliteLocalTaskJournal({ storeDir, faults: { onStep: (at) => { if (at === step) throw new Error(`fault at ${at}`); } } });
    try {
      await expect(journal.appendWithheldOffer(withheld(randomUUID(), 'task-1'))).rejects.toThrow(`fault at ${step}`);
    } finally { await journal.close(); }
    for (const table of ['journal_envelope', 'journal_task', 'journal_terminal', 'journal_idempotency']) {
      expect(rows(storeDir, `SELECT COUNT(*) AS n FROM ${table}`)).toEqual([{ n: 0 }]);
    }
  });

  it('refuses a withheld offer for a task whose stored offer could run', async () => {
    const journal = new SqliteLocalTaskJournal({ storeDir: await tmp() });
    try {
      const offer = encodeEnvelope(createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'hi', ...FRESH_OFFER }, { taskId: 'task-1', seq: 1 }));
      await journal.appendEnvelope({
        identity: IDENTITY, envelopeId: randomUUID(), taskId: 'task-1', seq: 1, bytes: offer, bytesHash: journalHash(offer),
        receivedAt: '2026-10-24T00:00:00.000Z', opensTask: true,
      });
      await expect(journal.appendWithheldOffer(withheld(randomUUID(), 'task-1'))).rejects.toThrow(/different execution contract/u);
    } finally { await journal.close(); }
  });

  it('keeps maxRecordBytes for the decline', async () => {
    const journal = new SqliteLocalTaskJournal({ storeDir: await tmp(), maxRecordBytes: 64 });
    try {
      await expect(journal.appendWithheldOffer(withheld(randomUUID(), 'task-1'))).rejects.toBeInstanceOf(JournalRecordTooLargeError);
    } finally { await journal.close(); }
  });

  it('refuses, at open and without altering it, a journal written before the withheld column existed', async () => {
    const storeDir = await tmp();
    const offer = encodeEnvelope(createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: 'hi', ...FRESH_OFFER }, { taskId: 'task-1', seq: 1 }));
    const first = new SqliteLocalTaskJournal({ storeDir });
    try {
      await first.appendEnvelope({
        identity: IDENTITY, envelopeId: randomUUID(), taskId: 'task-1', seq: 1, bytes: offer, bytesHash: journalHash(offer),
        receivedAt: '2026-10-24T00:00:00.000Z', opensTask: true,
      });
    } finally { await first.close(); }
    const db = openJournalDatabase(path.join(storeDir, JOURNAL_DB_FILENAME), DEFAULT_JOURNAL_BUSY_TIMEOUT_MS);
    try { db.exec('ALTER TABLE journal_envelope DROP COLUMN withheld_bytes'); } finally { db.close(); }
    const before = rows(storeDir, 'SELECT envelope_id, task_id, bytes, bytes_hash FROM journal_envelope');

    expect(() => new SqliteLocalTaskJournal({ storeDir })).toThrow(JournalUnavailableError);
    expect(rows(storeDir, "SELECT name FROM pragma_table_info('journal_envelope') WHERE name = 'withheld_bytes'")).toEqual([]);
    expect(rows(storeDir, 'SELECT envelope_id, task_id, bytes, bytes_hash FROM journal_envelope')).toEqual(before);
  });
});
