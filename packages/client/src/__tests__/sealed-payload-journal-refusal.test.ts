/**
 * #654 E3a, Codex review: the hosted journal bounds each record (256 KiB by
 * default). A schema-valid inline sealed member at the inline maximum
 * (`paddedLength` 256 KiB) is about 342 KiB of base64url. An inbound envelope
 * record may reach a floor derived from that maximum, so this daemon
 * journals such an envelope and then declines or drops it, and the cursor
 * moves past it. Terminal records keep `maxRecordBytes`.
 */
import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs, readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  EnvelopeSchema,
  PROTOCOL_VERSION,
  SEALED_INLINE_MAX_PADDED_LENGTH,
  SEALED_SPLIT_TABLE,
  encodeEnvelope,
  isServerToDaemonType,
  type Envelope,
  type MessageType,
} from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { CursorStore } from '../daemon/cursor-store';
import { JournalRecordTooLargeError, journalHash, type JournalIdentity } from '../daemon/journal/journal';
import { DEFAULT_JOURNAL_BUSY_TIMEOUT_MS, DEFAULT_MAX_RECORD_BYTES, JOURNAL_DB_FILENAME, SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';
import { openJournalDatabase } from '../daemon/journal/sqlite-support';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const corpus = readFileSync(new URL('../../../protocol/src/__tests__/golden/v4.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: MessageType; task_id: string; payload: Record<string, unknown> });

const EVENTUAL_STATE_BUDGET_MS = 4_000;
const IDENTITY: JournalIdentity = { tenantId: 'tenant-a', productId: 'test-product', deviceId: 'dev_1' };

/** Every sealable type that a Host sends to a daemon; the golden line of each is its sealed branch. */
const SEALED_INBOUND_TYPES = (Object.keys(SEALED_SPLIT_TABLE) as MessageType[]).filter((type) => isServerToDaemonType(type));

/** A golden line of `type` with an inline member, grown to the inline maximum of the protocol. */
function largestInline(type: MessageType): Record<string, unknown> {
  const line = corpus.find((candidate) => candidate.type === type && (candidate.payload.sealed as { ciphertext?: string } | undefined)?.ciphertext !== undefined);
  if (line === undefined) throw new Error(`no inline golden line for ${type}`);
  return {
    ...line.payload,
    sealed: {
      ...(line.payload.sealed as Record<string, unknown>),
      paddedLength: SEALED_INLINE_MAX_PADDED_LENGTH,
      ciphertext: randomBytes(SEALED_INLINE_MAX_PADDED_LENGTH + 16).toString('base64url'),
    },
  };
}

function envelopeOf(type: MessageType, taskId: string, seq: number): Envelope {
  return EnvelopeSchema.parse({ v: PROTOCOL_VERSION, id: randomUUID(), ts: new Date().toISOString(), type, task_id: taskId, seq, payload: largestInline(type) });
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-sealed-journal-'));
  dirs.push(dir);
  return dir;
}

function rows(storeDir: string, sql: string): Record<string, unknown>[] {
  const db = openJournalDatabase(path.join(storeDir, JOURNAL_DB_FILENAME), DEFAULT_JOURNAL_BUSY_TIMEOUT_MS);
  try { return db.prepare(sql).all() as Record<string, unknown>[]; }
  finally { db.close(); }
}

describe('the journal bound of an inbound envelope record (#654)', () => {
  it.each(SEALED_INBOUND_TYPES)('journals %s at the inline maximum under the default bound', async (type) => {
    const journal = new SqliteLocalTaskJournal({ storeDir: await tmp() });
    try {
      const bytes = encodeEnvelope(envelopeOf(type, 'sealed-task', 1));
      expect(Buffer.byteLength(bytes)).toBeGreaterThan(DEFAULT_MAX_RECORD_BYTES);
      await expect(journal.appendEnvelope({
        identity: IDENTITY, envelopeId: randomUUID(), taskId: 'sealed-task', seq: 1, bytes, bytesHash: journalHash(bytes),
        receivedAt: '2026-10-24T00:00:00.000Z', opensTask: type !== 'task.steer',
      })).resolves.toMatchObject({ created: true });
    } finally { await journal.close(); }
  });

  it('keeps maxRecordBytes for a terminal record', async () => {
    const journal = new SqliteLocalTaskJournal({ storeDir: await tmp() });
    try {
      const offer = encodeEnvelope(envelopeOf('task.offer', 'sealed-task', 1));
      await journal.appendEnvelope({
        identity: IDENTITY, envelopeId: randomUUID(), taskId: 'sealed-task', seq: 1, bytes: offer, bytesHash: journalHash(offer),
        receivedAt: '2026-10-24T00:00:00.000Z', opensTask: true,
      });
      const terminal = 'x'.repeat(DEFAULT_MAX_RECORD_BYTES + 1);
      await expect(journal.recordTerminal({
        taskId: 'sealed-task', terminalType: 'failed', bytes: terminal, payloadHash: journalHash(terminal),
        truthState: 'pending', attempt: 1, recordedAt: '2026-10-24T00:00:00.000Z',
      })).rejects.toBeInstanceOf(JournalRecordTooLargeError);
    } finally { await journal.close(); }
  });
});

describe('a sealed envelope at the inline maximum, on a daemon with the default hosted journal (#654)', () => {
  async function start() {
    const root = await tmp();
    server = await TestServer.start();
    const storeDir = path.join(root, 'store');
    daemon = createDaemonWithAdapters({
      storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Sealed journal test', productId: 'sealed-journal-test',
      serverUrl: server.url, storeDir,
    }, [new StubRuntimeAdapter('pi')]);
    const device = await daemon.pair('pair-code');
    await daemon.start();
    return { storeDir, device, server };
  }

  it('journals a sealed offer, declines it, and moves the cursor', async () => {
    const { storeDir, device, server } = await start();
    const offer = envelopeOf('task.offer', 'sealed-large-offer', server.nextSeq());
    server.send(offer);

    const decline = await server.waitFor((event) => event.type === 'task.decline' && event.task_id === 'sealed-large-offer', EVENTUAL_STATE_BUDGET_MS);
    expect(decline.payload).toMatchObject({ retryable: false });
    await vi.waitFor(async () => expect(await new CursorStore(storeDir).load(server.url, device.deviceId)).toBe(offer.seq), EVENTUAL_STATE_BUDGET_MS);
    expect(rows(storeDir, 'SELECT task_id FROM journal_task')).toEqual([{ task_id: 'sealed-large-offer' }]);
    expect(rows(storeDir, 'SELECT task_id, terminal_type FROM journal_terminal')).toEqual([{ task_id: 'sealed-large-offer', terminal_type: 'declined' }]);
  });

  it('journals a sealed steer, drops it, and moves the cursor', async () => {
    const { storeDir, device, server } = await start();
    const steer = envelopeOf('task.steer', 'sealed-large-steer', server.nextSeq());
    server.send(steer);

    await vi.waitFor(async () => expect(await new CursorStore(storeDir).load(server.url, device.deviceId)).toBe(steer.seq), EVENTUAL_STATE_BUDGET_MS);
    expect(rows(storeDir, 'SELECT envelope_id FROM journal_envelope')).toEqual([{ envelope_id: steer.id }]);
    expect(rows(storeDir, 'SELECT task_id FROM journal_task')).toEqual([]);
    expect(server.received.filter((event) => event.task_id === 'sealed-large-steer')).toEqual([]);
  });
});
