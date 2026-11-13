import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { ChildProcess, spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runBounded } from '../lifecycle/platform-command';
import { launchUnit } from '../lifecycle/windows-user';
import { COMMAND_TIMEOUT_MS, PlatformCommandTimeoutError, stopRoot } from '../util/command-timeouts';

const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('lifecycle/platform-command: runBounded (#1971)', () => {
  it('resolves a non-zero exit with its output', async () => {
    await expect(runBounded(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(3)'], 10_000))
      .resolves.toEqual({ code: 3, stdout: 'out', stderr: 'err' });
  });

  it('after its bound, rejects with PlatformCommandTimeoutError only once the command and its child are gone', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exec-runner-'));
    dirs.push(dir);
    const pids = path.join(dir, 'pids');
    // The command ignores SIGTERM and starts a child that holds its output open.
    const script = `
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {});
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });
      require('node:fs').writeFileSync(${JSON.stringify(pids)}, process.pid + ' ' + child.pid);
      setInterval(() => {}, 1000);
    `;
    const started = Date.now();
    const failure = await runBounded(process.execPath, ['-e', script], 2_000).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PlatformCommandTimeoutError);
    expect(failure).toMatchObject({ exitConfirmed: true });
    // Disposal proved the tree gone, so no disposal failure is attached.
    expect((failure as Error).cause).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(10_000);
    const [command, child] = (await fs.readFile(pids, 'utf8')).split(' ').map(Number);
    expect(alive(command!)).toBe(false);
    expect(alive(child!)).toBe(false);
  });

  /** A node command that records its pid in a fresh directory and runs until killed. */
  async function sleeper(): Promise<{ args: string[]; pid: () => Promise<number> }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exec-runner-'));
    dirs.push(dir);
    const file = path.join(dir, 'pid');
    const args = ['-e', `require('node:fs').writeFileSync(${JSON.stringify(file)}, String(process.pid)); setInterval(() => {}, 1000)`];
    const pid = async (): Promise<number> => {
      for (;;) {
        const text = await fs.readFile(file, 'utf8').catch(() => '');
        if (text !== '') return Number(text);
        await new Promise((resolve) => setImmediate(resolve));
      }
    };
    return { args, pid };
  }

  it.each(Object.entries(COMMAND_TIMEOUT_MS))('times out exactly at the %s bound (%i ms)', async (_kind, bound) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const { args } = await sleeper();
    let settled = false;
    const run = runBounded(process.execPath, args, bound).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(bound - 500);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await expect(run).rejects.toMatchObject({ constructor: PlatformCommandTimeoutError, exitConfirmed: true });
  });

  const failingTaskkill = (() => {
    throw new Error('taskkill unavailable');
  }) as unknown as typeof spawn;
  const hangingTaskkill = (() => Object.assign(new EventEmitter(), { stdout: null, stderr: null })) as unknown as typeof spawn;

  it.each([
    ['cannot start', failingTaskkill, 0],
    ['never exits', hangingTaskkill, COMMAND_TIMEOUT_MS.disposal],
  ])('Windows: a taskkill that %s leaves the exit unconfirmed', async (_case, spawnFn, wait) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    const { args, pid } = await sleeper();
    const run = runBounded(process.execPath, args, 1_000, { platform: 'win32', spawnFn }).catch((error: unknown) => error);
    const command = await pid();
    try {
      await vi.advanceTimersByTimeAsync(1_000 + wait);
      expect(await run).toMatchObject({ constructor: PlatformCommandTimeoutError, exitConfirmed: false });
    } finally {
      process.kill(command, 'SIGKILL');
    }
  });
});

/** A child that never exits on its own; `kill` answers `killed`. */
function fakeChild(killed: boolean): ChildProcess & EventEmitter {
  return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill: vi.fn(() => killed) }) as unknown as ChildProcess & EventEmitter;
}

describe('util/command-timeouts: stopRoot (#1971)', () => {
  it.each([
    ['kill() fails', false, false, false, 0],
    ['the root does not exit in time', true, false, false, COMMAND_TIMEOUT_MS.rootExit],
    ['the root exits', true, true, true, 0],
  ])('%s: exitConfirmed %s', async (_case, killed, exits, confirmed, wait) => {
    vi.useFakeTimers();
    const child = fakeChild(killed);
    const stopped = stopRoot(child, 'icacls');
    if (exits) child.emit('exit', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(wait);
    expect(await stopped).toMatchObject({ constructor: PlatformCommandTimeoutError, exitConfirmed: confirmed });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('the Startup launch kills only its cmd and reports a failed kill as unconfirmed', async () => {
    vi.useFakeTimers();
    const child = fakeChild(false);
    const launched = launchUnit('C:\\Startup\\acme.cmd', () => child).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS.launch);
    expect(await launched).toMatchObject({ constructor: PlatformCommandTimeoutError, exitConfirmed: false });
  });
});
