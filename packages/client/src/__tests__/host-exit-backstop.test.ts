import { execFile, spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { __hostExitBackstopForTests, adoptOwnedProcessTree, withOwnedProcessTree } from '../adapters/process-tree';

/**
 * The host-exit backstop: when the daemon exits normally, every still-live
 * owned tree dies with it.
 *
 * The first two cases are a real readback. A helper process — the daemon stand-in —
 * spawns a real three-level owned tree and then performs a real `process.exit(0)`
 * with nothing disposed. Only the registered `exit` listener can reap it, and the
 * test polls the real pids afterwards. The unadopted control run is what makes
 * that meaningful: without adoption the same tree survives its parent, which is
 * exactly the gap this mechanism closes.
 *
 * The helper is a plain Node process rather than an in-process simulation
 * because a vitest worker cannot exit itself, and it reaches the `.ts` source
 * through `fixtures/ts-source-resolve-hook.mjs` (Node type stripping plus one
 * resolve hook — see that file).
 */

const HOOK = fileURLToPath(new URL('./fixtures/ts-source-resolve-hook.mjs', import.meta.url));
const HELPER = fileURLToPath(new URL('./fixtures/host-exit-backstop-helper.mjs', import.meta.url));
const execFileAsync = promisify(execFile);

interface HelperReceipt {
  rootPid: number;
  grandchildPid: number;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function reap(pids: number[]): void {
  for (const pid of pids) {
    if (!processExists(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Exited between the probe and the cleanup.
    }
  }
}

async function waitGone(pids: number[], timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const live = pids.filter((pid) => processExists(pid));
    if (live.length === 0) return [];
    if (Date.now() >= deadline) return live;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function runHelper(adopt: '0' | '1'): Promise<HelperReceipt> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-host-exit-'));
  try {
    const { stdout } = await execFileAsync(process.execPath, [
      '--import', HOOK,
      HELPER,
      path.join(dir, 'tree.json'),
      adopt,
    ]);
    return JSON.parse(stdout.trim()) as HelperReceipt;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const spawned: ChildProcess[] = [];

function spawnOwnedIdle(): ChildProcess {
  const child = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], withOwnedProcessTree({
    stdio: 'ignore',
  }));
  spawned.push(child);
  return child;
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.pid === undefined) continue;
    reap([child.pid]);
  }
  __hostExitBackstopForTests.run();
});

describe('host-exit backstop (real process readback)', () => {
  it('kills an adopted owned tree when the host process exits normally', async () => {
    const receipt = await runHelper('1');

    expect(receipt.rootPid).toBeGreaterThan(0);
    expect(receipt.grandchildPid).toBeGreaterThan(0);
    const live = await waitGone([receipt.rootPid, receipt.grandchildPid], 5_000);
    reap([receipt.rootPid, receipt.grandchildPid]);
    expect(live).toEqual([]);
  });

  it('control: the same tree outlives the same exit when it was never adopted', async () => {
    const receipt = await runHelper('0');

    // No wait loop: the point is that nothing reaped it, so it is alive now.
    const survivors = [receipt.rootPid, receipt.grandchildPid].filter((pid) => processExists(pid));
    reap([receipt.rootPid, receipt.grandchildPid]);
    expect(survivors).toEqual([receipt.rootPid, receipt.grandchildPid]);
  });
});

describe('host-exit registry', () => {
  it('installs exactly one exit listener however many trees are adopted', async () => {
    await adoptOwnedProcessTree({ child: spawnOwnedIdle(), label: 'a' });
    await adoptOwnedProcessTree({ child: spawnOwnedIdle(), label: 'b' });

    expect(__hostExitBackstopForTests.listenerCount()).toBe(1);
    expect(__hostExitBackstopForTests.registeredPids()).toHaveLength(2);
  });

  it('drops a child that closed on its own, so the sweep never signals it', async () => {
    const child = realSpawn(process.execPath, ['-e', ''], withOwnedProcessTree({ stdio: 'ignore' }));
    spawned.push(child);
    const signalled: Array<[number, NodeJS.Signals | number]> = [];

    await adoptOwnedProcessTree({
      child,
      label: 'short-lived',
      killFn: (pid, signal) => {
        signalled.push([pid, signal]);
      },
    });
    expect(__hostExitBackstopForTests.registeredPids()).toContain(child.pid);

    await new Promise<void>((resolve) => child.once('close', () => resolve()));
    expect(__hostExitBackstopForTests.registeredPids()).not.toContain(child.pid);

    expect(() => __hostExitBackstopForTests.run()).not.toThrow();
    expect(signalled).toEqual([]);
  });

  it('signals the owned process GROUP, and one unreachable target cannot strand the rest', async () => {
    const first = spawnOwnedIdle();
    const second = spawnOwnedIdle();
    const signalled: number[] = [];

    await adoptOwnedProcessTree({
      child: first,
      label: 'first',
      killFn: () => {
        throw new Error('ESRCH');
      },
    });
    await adoptOwnedProcessTree({
      child: second,
      label: 'second',
      killFn: (pid, signal) => {
        expect(signal).toBe('SIGKILL');
        signalled.push(pid);
      },
    });

    expect(() => __hostExitBackstopForTests.run()).not.toThrow();
    // Negative pid: the whole owned process group, which is the only reason
    // `withOwnedProcessTree` makes the root a group leader.
    expect(signalled).toEqual([-(second.pid as number)]);
    expect(__hostExitBackstopForTests.registeredPids()).toEqual([]);
  });

  it('uses a synchronous taskkill tree sweep on win32', async () => {
    const child = spawnOwnedIdle();
    const invocations: Array<{ command: string; args: readonly string[]; options: unknown }> = [];

    await adoptOwnedProcessTree({
      child,
      label: 'win32-target',
      platform: 'win32',
      jobObject: { assign: () => Promise.resolve() },
      spawnSyncFn: ((command: string, args: readonly string[], options: unknown) => {
        invocations.push({ command, args, options });
        return { status: 0 } as never;
      }) as never,
    });

    __hostExitBackstopForTests.run();

    expect(invocations).toEqual([{
      command: 'taskkill',
      args: ['/PID', String(child.pid), '/T', '/F'],
      options: { stdio: 'ignore', windowsHide: true },
    }]);
  });
});
