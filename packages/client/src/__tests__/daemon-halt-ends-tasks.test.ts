import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { DEFAULT_JOURNAL_BUSY_TIMEOUT_MS, JOURNAL_DB_FILENAME } from '../daemon/journal/sqlite-journal';
import { openJournalDatabase } from '../util/sqlite-support';
import { FRESH_DAEMON_EGRESS, FRESH_OFFER } from './fixtures/fresh-offer';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

function terminalRows(storeDir: string, taskId: string): Array<{ truth_state: string }> {
  const db = openJournalDatabase(path.join(storeDir, JOURNAL_DB_FILENAME), DEFAULT_JOURNAL_BUSY_TIMEOUT_MS);
  try {
    return db.prepare('SELECT truth_state FROM journal_terminal WHERE task_id = ?').all(taskId) as Array<{ truth_state: string }>;
  } finally {
    db.close();
  }
}

/**
 * #1119: a run that ends (here `device_revoked`) stops its active tasks
 * itself. An embedded Host that never calls `stop()` gets the same teardown
 * `byok-agent` gets, and the `task.fail` waits in the journal for the next start.
 */
describe('#1119 a halted daemon ends its active tasks', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;
  let storeDir: string;
  let adapter: StubRuntimeAdapter;

  let shutdownGraceMs: number | undefined;

  function createTestDaemon(): void {
    daemon = createDaemonWithAdapters({
      storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Halt test',
      productId: `halt-${path.basename(storeDir)}`, serverUrl: server.url, storeDir,
      agentHome: { hostStorageRoot }, agentEgress: FRESH_DAEMON_EGRESS,
      ...(shutdownGraceMs === undefined ? {} : { shutdownGraceMs }),
    }, [adapter], { longPoll: { retryDelayMs: 10, idleDelayMs: 10 } });
  }

  let hostStorageRoot: string;

  beforeEach(async () => {
    shutdownGraceMs = undefined;
    server = await TestServer.start();
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-halt-tasks-store-'));
    hostStorageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-halt-tasks-home-'));
    adapter = new StubRuntimeAdapter('pi');
  });

  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  async function runningTask(taskId: string): Promise<{ deviceId: string }> {
    createTestDaemon();
    const record = await daemon!.pair('pairing-code');
    await daemon!.start();
    server.send(createEnvelope('task.offer', {
      instruction: 'long work', agentRef: { agentId: 'halt-agent', profileRevision: 'r1' }, ...FRESH_OFFER,
    }, { taskId, seq: server.nextSeq() }));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === taskId);
    expect(adapter.sessions).toHaveLength(1);
    return record;
  }

  it('an embedded daemon revoked mid-task tears the task down without stop() and journals its fail', async () => {
    const { deviceId } = await runningTask('revoked-mid-task');

    server.revokeDevice(deviceId);

    await expect.poll(() => daemon!.status().lifecycle, { timeout: 5000 }).toMatchObject({ phase: 'halted', reason: 'device_revoked' });
    await expect.poll(() => adapter.sessions[0]!.closeCalled, { timeout: 5000 }).toBe(true);
    expect(adapter.sessions[0]!.interruptCalled).toBe(true);
    await expect.poll(() => terminalRows(storeDir, 'revoked-mid-task'), { timeout: 5000 }).toEqual([{ truth_state: 'pending' }]);
    expect(server.received.some((entry) => entry.type === 'task.fail' && entry.task_id === 'revoked-mid-task')).toBe(false);

    // The owner's later stop() finds the task already ended: one terminal, no second teardown.
    await daemon!.stop();
    expect(adapter.sessions).toHaveLength(1);
    expect(terminalRows(storeDir, 'revoked-mid-task')).toEqual([{ truth_state: 'pending' }]);
    expect(daemon!.status().lifecycle).toMatchObject({ phase: 'halted', reason: 'device_revoked' });
  });

  it('bounds the halt teardown by shutdownGraceMs even when the runtime never answers the interrupt', async () => {
    shutdownGraceMs = 50;
    const { deviceId } = await runningTask('hung-interrupt');
    const session = adapter.sessions[0]!;
    let interruptAt: number | undefined;
    vi.spyOn(session, 'interrupt').mockImplementation(() => {
      interruptAt = Date.now();
      return new Promise<void>(() => undefined);
    });

    server.revokeDevice(deviceId);

    await expect.poll(() => interruptAt, { timeout: 5000 }).toBeDefined();
    // Well inside the 5 s interrupt bound a plain shutdown would wait out.
    await expect.poll(() => session.closeCalled, { timeout: 1000, interval: 10 }).toBe(true);
    await expect.poll(() => terminalRows(storeDir, 'hung-interrupt'), { timeout: 1000, interval: 10 }).toEqual([{ truth_state: 'pending' }]);
    expect(Date.now() - interruptAt!).toBeLessThan(1000);
    // The halt barrier's fsync tail runs past the journal row; activeTaskCount drops after its lease release (finish.ts:199).
    await expect.poll(() => daemon!.status().activeTaskCount).toBe(0);
  });
});
