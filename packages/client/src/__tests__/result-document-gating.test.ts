import { freshTestAgentRef, testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, decodeEnvelope, encodeEnvelope, PROTOCOL_VERSION } from '@byok-sdk/protocol';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AgentResultStore } from '../daemon/agent-result-store';
import { createDaemon, createDaemonWithAdapters, type DaemonConfig } from '../daemon/create-daemon';
import { DaemonConfigFieldRemovedError, DaemonJournalProtocolUnsupportedError } from '../daemon/daemon-errors';
import { journalHash } from '../daemon/journal/journal';
import { JOURNAL_DB_FILENAME, SqliteLocalTaskJournal } from '../daemon/journal/sqlite-journal';
import { createTestDeviceStore } from './fixtures/device-credentials';
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
    agentHome: testAgentHomeConfig(),
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
    ['gitWorkspace', { gitWorkspace: { mode: 'local-checkpoints' } }],
    ['workspaceRoot', { workspaceRoot: '/tmp' }],
  ])('%s throws DaemonConfigFieldRemovedError with its path', async (field, extra) => {
    const config = { ...(await baseConfig()), ...extra } as unknown as DaemonConfig;
    expectRemoved(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter()]), field);
  });

  it('refuses the removed overrides.gitWorkspace seam with the typed error', async () => {
    const config = await baseConfig();
    expectRemoved(() => createDaemonWithAdapters(config, [new StubRuntimeAdapter()], { gitWorkspace: {} } as never), 'gitWorkspace');
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
    const config = { ...(await baseConfig(server.url)) };
    const pairing = createDaemonWithAdapters(config, [new StubRuntimeAdapter()]);
    await pairing.pair('pairing-code');
    const device = (await createTestDeviceStore(config.storeDir!, undefined, config.productId).credentials.read())!;
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
    const daemon = createDaemonWithAdapters(config, [new StubRuntimeAdapter()], { journal });
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
    await seedOffer(journal, identity, 'v3-task', 1, encodeEnvelope(createEnvelope('task.offer_for_agent', { agentRef: freshTestAgentRef(),  instruction: 'current' }, { taskId: 'v3-task', seq: 1 })));
    await seedOffer(journal, identity, 'v2-task', 2, v2Bytes(encodeEnvelope(createEnvelope('task.offer_for_agent', { agentRef: freshTestAgentRef(),  instruction: 'old' }, { taskId: 'v2-task', seq: 2 }))));
    await journal.close();
    await expectStartupRefused(config, { taskId: 'v2-task', record: 'recovery-offer' });
    expect(snapshot(config.storeDir!).journal_terminal).toEqual([]);
  });

  it('a v2 pending terminal stops startup before replay', async () => {
    const { server, config, identity } = await pairedDaemonStore();
    const journal = new SqliteLocalTaskJournal({ storeDir: config.storeDir! });
    await seedOffer(journal, identity, 'done-task', 1, encodeEnvelope(createEnvelope('task.offer_for_agent', { agentRef: freshTestAgentRef(),  instruction: 'done' }, { taskId: 'done-task', seq: 1 })));
    const terminal = v2Bytes(encodeEnvelope(createEnvelope('task.complete', { summary: 'old', sessionRef: 's' }, { taskId: 'done-task', sessionRef: 's' })));
    await journal.recordTerminal({ taskId: 'done-task', terminalType: 'complete', bytes: terminal, payloadHash: journalHash(terminal),
      truthState: 'pending', attempt: 1, recordedAt: new Date().toISOString() });
    await journal.close();
    await expectStartupRefused(config, { taskId: 'done-task', record: 'pending-terminal' });
    expect(server.received.some((envelope) => envelope.type === 'task.complete')).toBe(false);
  });
});

/**
 * The two restart points of a result-document task, driven in process from a
 * journal image a daemon death leaves behind (the compiled SIGKILL variants
 * live in `execution-recovery-kill.test.ts`). The journal is the only
 * terminal authority: a staged outcome never becomes a document on restart,
 * and a recorded `task.complete` is replayed byte-for-byte.
 */
describe('result-document recovery from the journal', () => {
  const agentRef = { agentId: 'agent-result', profileRevision: 'profile-v1' } as const;
  const selection = { mode: 'result-document', contract: 'fixture.result.v1', schema: {
    type: 'object', additionalProperties: false, required: ['verdict'], properties: { verdict: { type: 'string' } },
  } } as const;

  async function pairedAgentStore(requiredReply = false) {
    const server = await TestServer.start(); cleanup.push(() => server.close());
    const root = await tmpDir('byok-result-recovery-');
    const config: DaemonConfig = { ...(await baseConfig(server.url)),
      agentHome: { hostStorageRoot: path.join(root, 'agent-home') }, agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY } };
    await createDaemonWithAdapters(config, [new StubRuntimeAdapter()]).pair('pairing-code');
    const device = (await createTestDeviceStore(config.storeDir!, undefined, config.productId).credentials.read())!;
    const identity = { tenantId: device.tenantId, productId: config.productId, deviceId: device.deviceId };
    const offerBytes = (taskId: string) => encodeEnvelope(createEnvelope('task.offer_for_agent_with_egress_fresh', {
      instruction: 'submit one result', runtime: 'pi', agentRef, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY, terminalProjection: selection,
      ...(requiredReply ? { messageEgress: { mode: 'required', contract: 'reply.v1', contentType: 'text/plain', maxBytes: 1024 } } : {}),
    }, { taskId, seq: 1 }));
    const home = path.join(config.agentHome!.hostStorageRoot, 'agents', agentRef.agentId);
    return { server, config, identity, offerBytes, home };
  }

  async function startWith(config: DaemonConfig, journal: SqliteLocalTaskJournal) {
    const daemon = createDaemonWithAdapters(config, [new StubRuntimeAdapter()], { journal });
    cleanup.push(async () => { await daemon.stop().catch(() => {}); await journal.close().catch(() => {}); });
    await daemon.start();
    return daemon;
  }

  it('refuses a result-reply marker that does not match the original required-reply offer', async () => {
    const { config, identity, offerBytes } = await pairedAgentStore(false);
    const journal = new SqliteLocalTaskJournal({ storeDir: config.storeDir! });
    cleanup.push(() => journal.close());
    const taskId = 'invalid-result-reply-marker';
    const bytes = offerBytes(taskId);
    await journal.appendEnvelope({ identity, taskId, envelopeId: JSON.parse(bytes).id, seq: 1, bytes, bytesHash: journalHash(bytes), opensTask: true, receivedAt: new Date().toISOString() });
    await journal.recordAdmission({ taskId, admitted: true, claimedRuntime: 'pi', decidedAt: new Date().toISOString() });
    await journal.recordTransition({ transitionId: `result-reply:${taskId}`, taskId, to: 'required-reply-result-missing', occurredAt: new Date().toISOString() });
    const daemon = createDaemonWithAdapters(config, [new StubRuntimeAdapter()], { journal });
    cleanup.push(() => daemon.stop().catch(() => {}));
    await expect(daemon.start()).rejects.toThrow('does not match its original offer');
    expect(await journal.listPendingTerminals(identity)).toEqual([]);
  });

  it('retains an existing cancellation terminal over a pending result-reply decision', async () => {
    const { server, config, identity, offerBytes } = await pairedAgentStore(true);
    let journal = new SqliteLocalTaskJournal({ storeDir: config.storeDir! });
    const taskId = 'cancelled-result-reply-marker';
    const bytes = offerBytes(taskId);
    await journal.appendEnvelope({ identity, taskId, envelopeId: JSON.parse(bytes).id, seq: 1, bytes, bytesHash: journalHash(bytes), opensTask: true, receivedAt: new Date().toISOString() });
    await journal.recordAdmission({ taskId, admitted: true, claimedRuntime: 'pi', decidedAt: new Date().toISOString() });
    await journal.recordTransition({ transitionId: `result-reply:${taskId}`, taskId, to: 'required-reply-result-missing', occurredAt: new Date().toISOString() });
    const cancelled = encodeEnvelope(createEnvelope('task.cancelled', { reason: 'cancel wins', agentRef }, { taskId }));
    await journal.recordTerminal({ taskId, terminalType: 'cancelled', bytes: cancelled, payloadHash: journalHash(cancelled), truthState: 'pending', attempt: 1, recordedAt: new Date().toISOString() });
    await journal.close();
    journal = new SqliteLocalTaskJournal({ storeDir: config.storeDir! });
    await startWith(config, journal);
    const terminal = await server.waitFor(e => e.task_id === taskId && e.type === 'task.cancelled', 5000);
    expect(encodeEnvelope(terminal)).toBe(cancelled);
    expect(server.received.filter(e => e.task_id === taskId && e.type === 'task.fail')).toHaveLength(0);
  });

  it('an interrupted task with a staged outcome recovers as daemon_interrupted with no document; the staged record stays as audit', async () => {
    const { server, config, identity, offerBytes, home } = await pairedAgentStore();
    const taskId = 'staged-then-killed';
    let journal = new SqliteLocalTaskJournal({ storeDir: config.storeDir! });
    const bytes = offerBytes(taskId);
    await journal.appendEnvelope({ identity, taskId, envelopeId: (JSON.parse(bytes) as { id: string }).id, seq: 1, bytes,
      bytesHash: journalHash(bytes), opensTask: true, receivedAt: new Date().toISOString() });
    await journal.recordAdmission({ taskId, admitted: true, claimedRuntime: 'pi', decidedAt: new Date().toISOString() });
    await journal.close();
    await fs.mkdir(home, { recursive: true });
    const staged = await (await AgentResultStore.open(home)).stage({ taskId, tenantId: identity.tenantId, agentRef,
      contract: selection.contract, schema: selection.schema, outcome: { verdict: 'pass' }, byteCount: 18 });

    journal = new SqliteLocalTaskJournal({ storeDir: config.storeDir! });
    await startWith(config, journal);
    const terminal = await server.waitFor((envelope) => envelope.task_id === taskId && envelope.type === 'task.fail', 5000);
    expect(terminal.payload).toMatchObject({ reason: 'daemon_interrupted', retryable: false, agentRef });
    expect(JSON.stringify(terminal)).not.toContain('"document"');
    expect(server.received.some((envelope) => envelope.type === 'task.complete')).toBe(false);
    expect(await (await AgentResultStore.open(home)).get(taskId)).toEqual(staged);
  });

  it('a task.complete with its document recorded before send is replayed once, byte-identical', async () => {
    const { server, config, identity, offerBytes } = await pairedAgentStore();
    const taskId = 'complete-before-send';
    let journal = new SqliteLocalTaskJournal({ storeDir: config.storeDir! });
    const bytes = offerBytes(taskId);
    await journal.appendEnvelope({ identity, taskId, envelopeId: (JSON.parse(bytes) as { id: string }).id, seq: 1, bytes,
      bytesHash: journalHash(bytes), opensTask: true, receivedAt: new Date().toISOString() });
    await journal.recordAdmission({ taskId, admitted: true, claimedRuntime: 'pi', decidedAt: new Date().toISOString() });
    const complete = encodeEnvelope(createEnvelope('task.complete', {
      summary: 'submitted', sessionRef: 'session-1', document: { verdict: 'pass' }, agentRef,
    }, { taskId, sessionRef: 'session-1' }));
    await journal.recordTerminal({ taskId, terminalType: 'complete', bytes: complete, payloadHash: journalHash(complete),
      truthState: 'pending', attempt: 1, recordedAt: new Date().toISOString() });
    await journal.close();

    journal = new SqliteLocalTaskJournal({ storeDir: config.storeDir! });
    await startWith(config, journal);
    const delivered = await server.waitFor((envelope) => envelope.task_id === taskId && envelope.type === 'task.complete', 5000);
    expect(encodeEnvelope(delivered)).toBe(complete);
    expect(decodeEnvelope(complete).payload).toMatchObject({ document: { verdict: 'pass' } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.received.filter((envelope) => envelope.task_id === taskId)).toHaveLength(1);
  });
});
