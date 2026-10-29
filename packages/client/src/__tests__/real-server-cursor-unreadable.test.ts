import { testAgentHomeConfig } from './fixtures/test-agent';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { DaemonHaltError } from '../daemon/daemon-lifecycle';
import { resetDeviceCursor, DeviceCursorResetError } from '../diagnostics/device-doctor';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { type RealServerHandle, startRealServer, submitAgentTask, waitForTaskResult } from './fixtures/real-server';

const LONG_POLL_DAEMON_OPTIONS = {
  longPoll: { retryDelayMs: 20, idleDelayMs: 20 },
} as const;

async function cursorFile(storeDir: string): Promise<string> {
  const names = (await fs.readdir(storeDir)).filter(name => /^cursor-[0-9a-f]{32}\.json$/.test(name));
  expect(names).toHaveLength(1);
  return path.join(storeDir, names[0]!);
}

/**
 * #1121: a damaged cursor file halts startup with `cursor_unreadable` instead
 * of reading as a fresh device. The operator resets it to 0 and the next
 * start replays what the server retains: work this device already finished is
 * not run again, and new work still arrives.
 */
describe('an unreadable delivery cursor halts until the operator resets it (real @byok-sdk/server)', () => {
  let real: RealServerHandle;
  let daemon: Daemon | undefined;
  const roots: string[] = [];

  afterEach(async () => {
    await daemon?.stop();
    await real.close();
    await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  });

  it('halts cursor_unreadable, refuses the reset while running, and replays from 0 after reset without rerunning finished work', async () => {
    real = await startRealServer({ productId: 'test-product', longPollHoldMs: 200 });
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-cursor-unreadable-'));
    roots.push(storeDir);
    const config: DaemonConfig = {
      storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Test',
      productId: 'test-product', serverUrl: real.url, storeDir, agentHome: testAgentHomeConfig(),
      agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
    };
    const adapter = new StubRuntimeAdapter();
    daemon = createDaemonWithAdapters(config, [adapter], LONG_POLL_DAEMON_OPTIONS);
    const record = await daemon.pair((await real.createPairingCode()).code);
    await daemon.start();
    const connected = () => vi.waitFor(async () => {
      expect((await real.byok.machines.list()).find(machine => machine.deviceId === record.deviceId)?.connected).toBe(true);
    });
    await connected();

    const first = await submitAgentTask(real, { taskId: 'task-before-corruption', deviceId: record.deviceId, instruction: 'before corruption' });
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    expect((await waitForTaskResult(real, first)).state).toBe('Complete');
    const file = await cursorFile(storeDir);
    await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(file, 'utf8')).cursor).toBeGreaterThan(0));

    // The cursor cannot be reset while the daemon owns the store.
    await expect(resetDeviceCursor(config, { confirmed: true })).rejects.toMatchObject({ code: 'daemon-running' });
    await daemon.stop();

    await fs.writeFile(file, '{"cursor":');
    const halted = createDaemonWithAdapters(config, [adapter], LONG_POLL_DAEMON_OPTIONS);
    daemon = halted;
    const thrown = await halted.start().then(() => undefined, (error: unknown) => error);
    expect(thrown).toBeInstanceOf(DaemonHaltError);
    expect((thrown as DaemonHaltError).reason).toBe('cursor_unreadable');
    expect(halted.status().lifecycle).toMatchObject({ phase: 'halted', reason: 'cursor_unreadable' });
    // The damaged file is left for the operator; startup did not rewrite it.
    expect(await fs.readFile(file, 'utf8')).toBe('{"cursor":');

    await expect(resetDeviceCursor(config, { confirmed: false as unknown as true })).rejects.toBeInstanceOf(DeviceCursorResetError);
    expect(await resetDeviceCursor(config, { confirmed: true })).toEqual({ action: 'reset-cursor', scope: 'device', status: 'reset' });
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ cursor: 0 });

    const resumed = createDaemonWithAdapters(config, [adapter], LONG_POLL_DAEMON_OPTIONS);
    daemon = resumed;
    await resumed.start();
    expect(resumed.status().lifecycle.phase).toBe('running');
    await connected();

    // The replay from 0 is delivered in seq order ahead of this new offer, so
    // once the new task has started, the finished one would have started too.
    const second = await submitAgentTask(real, { taskId: 'task-after-reset', deviceId: record.deviceId, instruction: 'after reset' });
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(2));
    adapter.sessions[1]!.emit({ type: 'turn_end' });
    expect((await waitForTaskResult(real, second)).state).toBe('Complete');
    expect(adapter.startCalls.map(call => String(call.task.instruction).split('\n').at(-1))).toEqual(['before corruption', 'after reset']);
    await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(file, 'utf8')).cursor).toBeGreaterThan(0));
  }, 20000);
});
