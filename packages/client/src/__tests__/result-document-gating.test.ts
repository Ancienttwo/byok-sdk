import { testScratchRoot } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, encodeEnvelope, PROTOCOL_VERSION } from '@byok-sdk/protocol';
import { createDaemon, createDaemonWithAdapters, type DaemonConfig } from '../daemon/create-daemon';
import { DaemonConfigFieldRemovedError, DaemonJournalProtocolUnsupportedError } from '../daemon/daemon-errors';
import { journalHash } from '../daemon/journal/journal';
import { JOURNAL_DB_FILENAME, SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';
import { DeviceStore } from '../daemon/store';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

/**
 * Wire v3 result channel, daemon construction and startup:
 * - TE-B: every removed `DaemonConfig` field, `resultDocument` included,
 *   throws the typed {@link DaemonConfigFieldRemovedError}.
 * - A journal holding envelope bytes of another wire major stops startup
 *   with {@link DaemonJournalProtocolUnsupportedError} before any recovery
 *   write: the journal is byte-identical afterwards.
 */

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const fn of cleanup.reverse()) await fn(); cleanup.length = 0; });

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function baseConfig(serverUrl = 'http://127.0.0.1:9'): Promise<DaemonConfig> {
  return {
    storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product', productId: 'result-gating',
    serverUrl,
    workspaceRoot: await tmpDir('byok-result-gating-workspace-'),
    storeDir: await tmpDir('byok-result-gating-store-'),
  };
}

function expectRemoved(build: () => unknown, field: string): void {
  let thrown: unknown;
  try { build(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(DaemonConfigFieldRemovedError);
  expect(thrown).toMatchObject({ code: 'daemon_config_field_removed', field, name: 'DaemonConfigFieldRemovedError' });
  expect((thrown as Error).message).toContain(`DaemonConfig.${field} was removed`);
}

describe('removed DaemonConfig fields (TE-B)', () => {
  it('createDaemon and createDaemonWithAdapters refuse resultDocument with the typed error', async () => {
    const config = { ...(await baseConfig()), resultDocument: { extract: () => ({}) } } as unknown as DaemonConfig;
    expectRemoved(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter()]), 'resultDocument');
    expectRemoved(() => createDaemon(config), 'resultDocument');
  });

  it.each([
    ['permissionDefaults', { permissionDefaults: {} }],
    ['agentEgress.sanitizer', { agentEgress: { sanitizer: () => undefined } }],
    ['mcpLaunchCwd', { mcpLaunchCwd: '/tmp' }],
    ['toolImplementationAuthority', { toolImplementationAuthority: {} }],
    ['maxConcurrentMutableSessionsPerAgentHome', { maxConcurrentMutableSessionsPerAgentHome: 1 }],
  ])('%s throws DaemonConfigFieldRemovedError with its path', async (field, extra) => {
    const config = { ...(await baseConfig()), ...extra } as unknown as DaemonConfig;
    expectRemoved(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter()]), field);
  });
});

function v2Bytes(bytes: string): string {
  const parsed = JSON.parse(bytes) as { v: number };
  expect(parsed.v).toBe(PROTOCOL_VERSION);
  return `${JSON.stringify({ ...parsed, v: 2 })}\n`;
}

function snapshot(storeDir: string): Record<string, unknown[]> {
  const db = new DatabaseSync(path.join(storeDir, JOURNAL_DB_FILENAME), { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>)
      .map((row) => row.name);
    return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]));
  } finally { db.close(); }
}

describe('startup refuses a journal of another wire major', () => {
  async function pairedDaemonStore() {
    const server = await TestServer.start(); cleanup.push(() => server.close());
    const config = { ...(await baseConfig(server.url)), hostedJournal: { mode: 'sqlite' as const } };
    const pairing = createDaemonWithAdapters(config, [new StubRuntimeAdapter()]);
    await pairing.pair('pairing-code');
    const device = (await new DeviceStore(config.storeDir!, undefined, config.productId).credentials.read())!;
    const identity = { tenantId: device.tenantId, productId: config.productId, deviceId: device.deviceId };
    return { server, config, identity };
  }

  async function seedOffer(journal: SqliteLocalTaskJournal, identity: { tenantId: string; productId: string; deviceId: string }, taskId: string, seq: number, bytes: string): Promise<void> {
    await journal.appendEnvelope({ identity, taskId, envelopeId: (JSON.parse(bytes) as { id: string }).id, seq, bytes,
      bytesHash: journalHash(bytes), opensTask: true, receivedAt: new Date().toISOString() });
    await journal.recordAdmission({ taskId, admitted: true, claimedRuntime: 'pi', decidedAt: new Date().toISOString() });
  }

  async function expectStartupRefused(config: DaemonConfig, expected: Partial<DaemonJournalProtocolUnsupportedError>): Promise<void> {
    const before = snapshot(config.storeDir!);
    const journal = new SqliteLocalTaskJournal({ storeDir: config.storeDir! });
    const daemon = createDaemonWithAdapters(config, [new StubRuntimeAdapter()], { hostedJournal: { journal } });
    cleanup.push(async () => { await daemon.stop().catch(() => {}); await journal.close().catch(() => {}); });
    let thrown: unknown;
    try { await daemon.start(); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(DaemonJournalProtocolUnsupportedError);
    expect(thrown).toMatchObject({ code: 'daemon_journal_protocol_unsupported', found: 2, expected: PROTOCOL_VERSION, ...expected });
    await daemon.stop().catch(() => {});
    await journal.close();
    expect(snapshot(config.storeDir!)).toEqual(before);
  }

  it('a v2 recovery offer stops startup before any daemon_interrupted terminal is written', async () => {
    const { config, identity } = await pairedDaemonStore();
    const journal = new SqliteLocalTaskJournal({ storeDir: config.storeDir! });
    // A v3 row first: scanning before acting means it gets no terminal either.
    await seedOffer(journal, identity, 'v3-task', 1, encodeEnvelope(createEnvelope('task.offer', { instruction: 'current' }, { taskId: 'v3-task', seq: 1 })));
    await seedOffer(journal, identity, 'v2-task', 2, v2Bytes(encodeEnvelope(createEnvelope('task.offer', { instruction: 'old' }, { taskId: 'v2-task', seq: 2 }))));
    await journal.close();
    await expectStartupRefused(config, { taskId: 'v2-task', record: 'recovery-offer' });
    expect(snapshot(config.storeDir!).journal_terminal).toEqual([]);
  });

  it('a v2 pending terminal stops startup before replay', async () => {
    const { server, config, identity } = await pairedDaemonStore();
    const journal = new SqliteLocalTaskJournal({ storeDir: config.storeDir! });
    await seedOffer(journal, identity, 'done-task', 1, encodeEnvelope(createEnvelope('task.offer', { instruction: 'done' }, { taskId: 'done-task', seq: 1 })));
    const terminal = v2Bytes(encodeEnvelope(createEnvelope('task.complete', { summary: 'old', sessionRef: 's' }, { taskId: 'done-task', sessionRef: 's' })));
    await journal.recordTerminal({ taskId: 'done-task', terminalType: 'complete', bytes: terminal, payloadHash: journalHash(terminal),
      truthState: 'pending', attempt: 1, recordedAt: new Date().toISOString() });
    await journal.close();
    await expectStartupRefused(config, { taskId: 'done-task', record: 'pending-terminal' });
    expect(server.received.some((envelope) => envelope.type === 'task.complete')).toBe(false);
  });
});
