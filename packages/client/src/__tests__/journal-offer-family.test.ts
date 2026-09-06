import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { encodeEnvelope, EnvelopeSchema, MESSAGE_TYPES, type Envelope } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentHomeManager } from '../agent-home';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { CursorStore } from '../daemon/cursor-store';
import { JOURNAL_DB_FILENAME, DEFAULT_JOURNAL_BUSY_TIMEOUT_MS } from '../daemon/journal/sqlite-journal';
import { openJournalDatabase } from '../daemon/journal/sqlite-support';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

// Independent completeness oracle: enumerate the declared wire family, not the
// implementation's classifier. Payloads still pass the real EnvelopeSchema.
const offerTypes = MESSAGE_TYPES.filter((type) => type === 'task.offer' || type.startsWith('task.offer_'));
const agentRef = { agentId: 'journal-family-agent', profileRevision: 'r1' };
let daemon: Daemon | undefined;
let server: TestServer;
let root: string;

afterEach(async () => {
  await daemon?.stop(); daemon = undefined;
  await server?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

function rows(storeDir: string, sql: string): Record<string, unknown>[] {
  const db = openJournalDatabase(path.join(storeDir, JOURNAL_DB_FILENAME), DEFAULT_JOURNAL_BUSY_TIMEOUT_MS);
  try { return db.prepare(sql).all() as Record<string, unknown>[]; }
  finally { db.close(); }
}

async function setup(type: string) {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-147-'));
  server = await TestServer.start();
  server.setAckCapabilities(['agent-egress-reliable-ack']);
  const storeDir = path.join(root, 'store');
  const hostStorageRoot = path.join(root, 'home');
  const config: DaemonConfig = {
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Journal test', productId: 'journal-test',
    serverUrl: server.url, storeDir, workspaceRoot: path.join(root, 'workspace'),
    hostedJournal: { mode: 'sqlite' }, agentHome: { hostStorageRoot },
    agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
  };
  if (type === 'task.offer_for_agent_with_egress') {
    const manager = new AgentHomeManager({ hostStorageRoot });
    const binding = await manager.prepare(agentRef);
    try {
      await new AgentSessionHandoffStore().record({ agentRef, taskId: 'prior-task', sessionRef: 'resume-session', runtimeId: 'pi', cwd: binding.resolution.canonicalHome, leaseId: 'prior-lease' });
    } finally { await binding.lease.release(); }
  }
  const adapter = new StubRuntimeAdapter('pi');
  daemon = createDaemonWithAdapters(config, [adapter]);
  const device = await daemon.pair('pair-code');
  await daemon.start();
  const payload = {
    instruction: 'journal lifecycle', policy: { mode: 'auto' }, runtime: 'pi',
    ...(type.includes('for_agent') ? { agentRef } : {}),
    ...(type.includes('with_egress') ? { egressPolicy: DEFAULT_AGENT_EGRESS_POLICY } : {}),
    ...(type === 'task.offer_for_agent_with_egress' ? { sessionRef: 'resume-session' } : {}),
    ...(type === 'task.offer_with_toolsets' ? { requiredToolsets: ['test-missing'] } : {}),
  };
  const seq = server.nextSeq();
  const envelope: Envelope = EnvelopeSchema.parse({ v: 1, id: randomUUID(), ts: new Date().toISOString(), type, task_id: 'task-147', seq, payload });
  server.send(envelope);
  await vi.waitFor(async () => expect(await new CursorStore(storeDir).load(server.url, device.deviceId)).toBe(seq));
  return { config, adapter, storeDir, envelope, device };
}

describe('issue #147 protocol offer family through real hosted SQLite journal', () => {
  it.each(offerTypes)('%s has one durable journal_task at cursor acknowledgement and absorbs redelivery', async (type) => {
    const { storeDir, envelope, adapter, device } = await setup(type);
    expect(rows(storeDir, 'SELECT task_id FROM journal_task')).toEqual([{ task_id: 'task-147' }]);
    server.send(envelope);
    // A later acknowledged frame proves the duplicate has passed the ordered inbound chain.
    const laterSeq = server.nextSeq();
    server.send({ ...envelope, id: randomUUID(), seq: laterSeq });
    await vi.waitFor(async () => expect(await new CursorStore(storeDir).load(server.url, device.deviceId)).toBe(laterSeq));
    await vi.waitFor(() => expect(rows(storeDir, 'SELECT count(*) AS n FROM journal_envelope WHERE task_id IS NOT NULL')[0]?.n).toBe(2));
    expect(rows(storeDir, 'SELECT task_id FROM journal_task')).toHaveLength(1);
    expect(adapter.startCalls).toHaveLength(type === 'task.offer_with_toolsets' ? 0 : 1);
  });

  it.each(offerTypes.filter((type) => type !== 'task.offer_with_toolsets'))('%s records the exact interrupted terminal before transport confirmation on restart', async (type) => {
    const { config, adapter, storeDir } = await setup(type);
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-147');
    expect(rows(storeDir, 'SELECT task_id, recovery_marker FROM journal_task')).toEqual([{ task_id: 'task-147', recovery_marker: null }]);
    // Capture a real SQLite-consistent crash boundary after ack and before terminal.
    // Graceful stop would create a terminal; restore this snapshot to exercise
    // startup against exactly the acknowledged, unfinished state instead.
    const snapshot = path.join(root, 'interrupted.db');
    const db = openJournalDatabase(path.join(storeDir, JOURNAL_DB_FILENAME), DEFAULT_JOURNAL_BUSY_TIMEOUT_MS);
    try { db.prepare('VACUUM INTO ?').run(snapshot); } finally { db.close(); }
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-147');
    expect(rows(storeDir, 'SELECT task_id, terminal_type FROM journal_terminal')).toEqual([{ task_id: 'task-147', terminal_type: 'complete' }]);
    await daemon!.stop(); daemon = undefined;
    await fs.copyFile(snapshot, path.join(storeDir, JOURNAL_DB_FILENAME));
    const restartedAdapter = new StubRuntimeAdapter('pi');
    daemon = createDaemonWithAdapters(config, [restartedAdapter]);
    await daemon.start();
    const interrupted = await server.waitFor((event) => event.type === 'task.fail' && event.task_id === 'task-147');
    const recovered = rows(storeDir, 'SELECT recovery_marker FROM journal_task');
    expect(recovered).toHaveLength(1);
    expect(JSON.parse(String(recovered[0]!.recovery_marker))).toMatchObject({ disposition: 'interrupted' });
    expect(rows(storeDir, 'SELECT task_id, terminal_type, bytes, payload_hash, truth_state FROM journal_terminal')).toEqual([{
      task_id: 'task-147', terminal_type: 'failed', bytes: encodeEnvelope(interrupted),
      payload_hash: expect.stringMatching(/^sha256:/), truth_state: 'pending',
    }]);
    expect(restartedAdapter.startCalls).toHaveLength(0);
  });
});
