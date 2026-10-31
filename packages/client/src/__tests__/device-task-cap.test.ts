import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { MAX_DURATION_EXCEEDED_REASON_PREFIX } from '../daemon/task-runner/state';
import { TestServer } from './fixtures/test-server';
import { until } from './fixtures/until';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { FRESH_OFFER } from './fixtures/fresh-offer';

/**
 * #1121: one daemon runs at most `maxConcurrentTasks` tasks across every
 * Agent home, and a task whose offer sets no wall-clock limit gets the
 * daemon's `defaultMaxDurationMs`.
 */
describe('device-wide task resources (#1121)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;
  const roots: string[] = [];

  beforeEach(async () => { server = await TestServer.start(); });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
    await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  });

  async function temp(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    roots.push(dir);
    return dir;
  }

  async function config(overrides: Partial<DaemonConfig>): Promise<DaemonConfig> {
    const storeDir = await temp('byok-device-cap-store-');
    return {
      storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Device cap',
      productId: `device-cap-${path.basename(storeDir)}`, serverUrl: server.url, storeDir,
      agentHome: { hostStorageRoot: await temp('byok-device-cap-home-') }, agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
      ...overrides,
    };
  }

  async function start(overrides: Partial<DaemonConfig>): Promise<StubRuntimeAdapter> {
    const pi = new StubRuntimeAdapter('pi');
    daemon = createDaemonWithAdapters(await config(overrides), [pi]);
    await daemon.pair('pairing-code');
    await daemon.start();
    await server.waitFor(entry => entry.type === 'conn.hello');
    return pi;
  }

  function offer(taskId: string, agentId: string, limits?: { maxDurationMs: number }): void {
    server.send(createEnvelope('task.offer', {
      instruction: `work for ${agentId}`, agentRef: { agentId, profileRevision: 'r1' }, runtime: 'pi', ...FRESH_OFFER,
      ...(limits === undefined ? {} : { limits }),
    }, { taskId, seq: server.nextSeq() }));
  }

  const started = (taskId: string) => server.waitFor(entry => entry.type === 'task.started' && entry.task_id === taskId);

  it('declines an offer over the cap retryably, with no code, across different Agent homes, and admits again once a task ends', async () => {
    const pi = await start({ maxConcurrentTasks: 2 });
    offer('cap-1', 'agent-a');
    await started('cap-1');
    offer('cap-2', 'agent-b');
    await started('cap-2');

    offer('cap-3', 'agent-c');
    const decline = await server.waitFor(entry => entry.type === 'task.decline' && entry.task_id === 'cap-3');
    expect(decline.payload).toMatchObject({ reason: 'device busy: 2 of 2 concurrent task(s) in use', retryable: true });
    expect(decline.payload).not.toHaveProperty('code');
    expect(server.received.some(entry => entry.type === 'task.claim' && entry.task_id === 'cap-3')).toBe(false);
    expect(pi.sessions).toHaveLength(2);

    pi.sessions[0]!.emit({ type: 'turn_end' });
    await server.waitFor(entry => entry.type === 'task.complete' && entry.task_id === 'cap-1');
    // task.complete is sent before finish() releases the task's slot; offer
    // again only once the device has a free slot.
    await until(() => daemon!.status().activeTaskCount === 1, () => `activeTaskCount=${daemon!.status().activeTaskCount}`);
    offer('cap-4', 'agent-c');
    await started('cap-4');
    expect(pi.sessions).toHaveLength(3);
  });

  it('applies defaultMaxDurationMs only to an offer that sets no limit of its own', async () => {
    await start({ defaultMaxDurationMs: 50 });
    offer('limited-by-offer', 'agent-a', { maxDurationMs: 60_000 });
    await started('limited-by-offer');
    offer('limited-by-default', 'agent-b');
    const failed = await server.waitFor(entry => entry.type === 'task.fail' && entry.task_id === 'limited-by-default');
    expect((failed.payload as { reason: string }).reason.startsWith(MAX_DURATION_EXCEEDED_REASON_PREFIX)).toBe(true);
    expect(server.received.some(entry => entry.type === 'task.fail' && entry.task_id === 'limited-by-offer')).toBe(false);
  });

  it.each([
    ['maxConcurrentTasks', 0],
    ['maxConcurrentTasks', 1.5],
    ['defaultMaxDurationMs', 0],
    ['defaultMaxDurationMs', -1],
  ] as const)('rejects %s = %s at construction', async (field, value) => {
    const base = await config({ [field]: value });
    expect(() => createDaemonWithAdapters(base, [new StubRuntimeAdapter('pi')])).toThrow(field);
  });
});
