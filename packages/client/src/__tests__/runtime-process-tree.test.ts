import type { RuntimeTaskInput } from '../types';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as childProcess from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { isRuntimeDisposalFailure } from '../runtime-failure';
import { taskRuntimeTarget } from '../runtime-detection';
import { OWNED_TREE_OBSERVE_MS, adoptOwnedProcessTree, disposeOwnedProcessTree, readOwnedProcessTable, withOwnedProcessTree } from '../adapters/process-tree';
import { startPreparedOperation } from './fixtures/prepared-operation';
import * as processTree from '../adapters/process-tree';
import { captureProcessIdentity, expectProcessNotLive, isProcessLive, type ProcessIdentity } from './support/process-liveness';

vi.mock('node:child_process', { spy: true });

const PI_FIXTURE = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const CLAUDE_FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const CODEX_FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const DESCENDANT_FIXTURE = fileURLToPath(new URL('./fixtures/process-tree-descendant.mjs', import.meta.url));

describe.skipIf(process.platform === 'win32')('POSIX process liveness assertions', () => {
  const live = { pid: 42, ppid: 41, pgid: 40, start: 'first' };

  it('accepts a missing PID', () => {
    const read = vi.spyOn(processTree, 'observeOwnedProcessTable').mockReturnValue({ table: new Map() });
    try {
      expect(isProcessLive(live.pid)).toBe(false);
      expectProcessNotLive(live.pid);
    } finally { read.mockRestore(); }
  });

  it('rejects a live PID with its process identity', () => {
    const read = vi.spyOn(processTree, 'observeOwnedProcessTable').mockReturnValue({ table: new Map([[live.pid, live]]) });
    try {
      expect(isProcessLive(live.pid)).toBe(true);
      expect(() => expectProcessNotLive(live.pid)).toThrow('Process still live: pid=42 ppid=41 pgid=40 start=first');
    } finally { read.mockRestore(); }
  });

  it('accepts a zombie and a PID reused after identity capture', () => {
    const read = vi.spyOn(processTree, 'observeOwnedProcessTable').mockReturnValue({ table: new Map([[live.pid, live]]) });
    try {
      const identity = captureProcessIdentity(live.pid);
      expect(identity).toEqual({ pid: live.pid, start: live.start });
      read.mockReturnValue({ table: new Map([[live.pid, { ...live, zombie: true }]]) });
      expectProcessNotLive(identity);
      read.mockReturnValue({ table: new Map([[live.pid, { ...live, start: 'second' }]]) });
      expectProcessNotLive(identity);
      expect(isProcessLive(live.pid)).toBe(true);
    } finally { read.mockRestore(); }
  });

  it('fails closed on an unreadable PID even when a zombie row is present', () => {
    const read = vi.spyOn(processTree, 'observeOwnedProcessTable').mockReturnValue({
      table: new Map([[live.pid, { ...live, zombie: true }]]), unreadable: new Set([live.pid]),
    });
    try {
      expect(() => captureProcessIdentity(live.pid)).toThrow('pid=42: process identity is unreadable');
      expect(() => expectProcessNotLive(live)).toThrow('pid=42: process identity is unreadable');
    } finally { read.mockRestore(); }
  });
});

const forkingDirectories: string[] = [];
const forkingGroups = new Set<number>();
afterEach(async () => {
  for (const pgid of forkingGroups) {
    await expect.poll(() => {
      try { process.kill(-pgid, 'SIGKILL'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      return [...readOwnedProcessTable().values()].some(entry => entry.pgid === pgid && entry.zombie !== true);
    }, { timeout: 5000, interval: 20 }).toBe(false);
  }
  forkingGroups.clear();
  for (const directory of forkingDirectories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

interface ProcessTreeReceipt {
  rootPid: number;
  descendantPid: number;
  /** Third level. A direct-child-only termination and a one-level sweep are indistinguishable without it. */
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

function allPids(receipt: ProcessTreeReceipt): number[] {
  return [receipt.grandchildPid, receipt.descendantPid, receipt.rootPid];
}

function reapAll(pids: number[]): void {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Best-effort cleanup after the test.
    }
  }
}

async function readReceipt(file: string, required: ReadonlyArray<keyof ProcessTreeReceipt> = ['rootPid', 'descendantPid', 'grandchildPid']): Promise<ProcessTreeReceipt> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      const receipt = JSON.parse(await fs.readFile(file, 'utf8')) as ProcessTreeReceipt;
      if (required.every((key) => receipt[key] > 0)) return receipt;
    } catch {
      // The fixture writes asynchronously after spawn; retry until the bounded deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('process-tree receipt was not written within 2 seconds');
}

describe('bundled runtime process-tree disposal', () => {
  it('escalates a TERM-resistant POSIX process group before resolving close', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-process-tree-escalation-'));
    const receiptFile = path.join(workspaceDir, 'process-tree.json');
    const offer: RuntimeTaskInput = { target: { lane: 'auto' }, instruction: 'stay alive' };
    const adapter = new PiAdapter({ resolveBin: () => ({ command: PI_FIXTURE, source: 'package' }) });
    const session = await startPreparedOperation(adapter, offer, {
      workspaceDir,
      env: {
        ...process.env,
        FAKE_PI_PROCESS_TREE_FILE: receiptFile,
        FAKE_PI_HANG_AFTER_TOOL: '1',
        FAKE_PI_IGNORE_TERM: '1',
      },
    });
    const receipt = await readReceipt(receiptFile);
    const startedAt = Date.now();
    try {
      const identities = allPids(receipt).map(captureProcessIdentity);
      await session.close();
      if (process.platform !== 'win32') expect(Date.now() - startedAt).toBeGreaterThanOrEqual(650);
      identities.forEach(expectProcessNotLive);
    } finally {
      reapAll(allPids(receipt));
    }
    // Pi gives shutdown hooks a 10 s SIGTERM grace before SIGKILL.
  }, 20_000);

  // #1304: taskkill starts from %SystemRoot%\System32 whatever the host's PATH holds.
  it.runIf(process.platform === 'win32')('win32 dispose ends the tree under an empty PATH', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], withOwnedProcessTree({ stdio: 'ignore' }));
    let closed = false;
    const closeReceipt = new Promise<void>((resolve) => child.once('close', () => { closed = true; resolve(); }));
    await new Promise((resolve) => child.once('spawn', resolve));
    vi.stubEnv('PATH', '');
    try {
      await disposeOwnedProcessTree({ child, waitClosed: () => closeReceipt, isClosed: () => closed, label: 'win32 fixture' });
      expectProcessNotLive(child.pid!);
    } finally {
      vi.unstubAllEnvs();
      reapAll([child.pid!]);
    }
  });

  it('Pi close resolves only after its real root, descendant and grandchild are all gone', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-process-tree-'));
    const receiptFile = path.join(workspaceDir, 'process-tree.json');
    const offer: RuntimeTaskInput = { target: { lane: 'auto' }, instruction: 'stay alive' };
    const adapter = new PiAdapter({ resolveBin: () => ({ command: PI_FIXTURE, source: 'package' }) });
    const session = await startPreparedOperation(adapter, offer, {
      workspaceDir,
      env: { ...process.env, FAKE_PI_PROCESS_TREE_FILE: receiptFile },
    });
    const receipt = await readReceipt(receiptFile);

    try {
      for (const pid of allPids(receipt)) expect(processExists(pid)).toBe(true);
      const identities = allPids(receipt).map(captureProcessIdentity);
      await session.interrupt();
      await session.close();
      identities.forEach(expectProcessNotLive);
    } finally {
      reapAll(allPids(receipt));
    }
  });

  /**
   * Escape race: the descendant keeps spawning fresh children while disposal
   * runs. The contract has exactly two acceptable outcomes and no third —
   * close() must never resolve while a process it recorded is still alive.
   */
  it('never resolves close while an escaping descendant is still alive', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-process-tree-escape-'));
    const receiptFile = path.join(workspaceDir, 'process-tree.json');
    const escapeLog = path.join(workspaceDir, 'escapees.log');
    const offer: RuntimeTaskInput = { target: { lane: 'auto' }, instruction: 'stay alive' };
    const adapter = new PiAdapter({ resolveBin: () => ({ command: PI_FIXTURE, source: 'package' }) });
    const session = await startPreparedOperation(adapter, offer, {
      workspaceDir,
      env: {
        ...process.env,
        FAKE_PI_PROCESS_TREE_FILE: receiptFile,
        FAKE_PI_HANG_AFTER_TOOL: '1',
        FAKE_PI_ESCAPE_LOG: escapeLog,
      },
    });
    const receipt = await readReceipt(receiptFile);
    // Let the fixture win a few rounds of the race before disposal starts.
    await new Promise((resolve) => setTimeout(resolve, 350));

    const readEscapees = async (): Promise<number[]> => {
      const raw = await fs.readFile(escapeLog, 'utf8').catch(() => '');
      return raw.split('\n').map((line) => Number(line.trim())).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    };
    const escapeesBefore = await readEscapees();
    const before = process.platform === 'win32' ? undefined : readOwnedProcessTable();

    let disposalFailure: unknown;
    try {
      await session.close();
    } catch (error) {
      disposalFailure = error;
    }

    const recorded = [...allPids(receipt), ...(await readEscapees())];
    try {
      expect(escapeesBefore.length).toBeGreaterThan(0);
      if (disposalFailure === undefined) {
        // Resolved: every recorded process must already be gone.
        for (const pid of recorded) expectProcessNotLive(before?.get(pid) ?? pid);
      } else {
        // Failed: it must be a typed quiescence failure, never a silent resolve.
        expect(isRuntimeDisposalFailure(disposalFailure)).toBe(true);
        expect((disposalFailure as { stage: string }).stage).toBe('quiescence');
      }
    } finally {
      reapAll(recorded);
    }
  });

  it.each([
    {
      runtime: 'Claude',
      adapter: () => new ClaudeAdapter({ resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }) }),
      env: (receiptFile: string) => ({ FAKE_CLAUDE_PROCESS_TREE_FILE: receiptFile, FAKE_CLAUDE_HANG_AFTER_TOOL: '1' }),
    },
    {
      runtime: 'Codex',
      adapter: () => new CodexAdapter({ resolveBin: () => ({ command: CODEX_FIXTURE, source: 'path' }) }),
      env: (receiptFile: string) => ({ FAKE_CODEX_PROCESS_TREE_FILE: receiptFile, FAKE_CODEX_HANG: '1' }),
    },
  ])('$runtime close resolves only after its real root, descendant and grandchild are all gone', async ({ runtime, adapter, env }) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), `byok-${runtime.toLowerCase()}-process-tree-`));
    const receiptFile = path.join(workspaceDir, 'process-tree.json');
    const runtimeAdapter = adapter();
    const offer: RuntimeTaskInput = { target: taskRuntimeTarget(runtimeAdapter.descriptor), instruction: 'stay alive' };
    const session = await startPreparedOperation(runtimeAdapter, offer, {
      workspaceDir,
      env: { ...process.env, ...env(receiptFile) },
    });
    const receipt = await readReceipt(receiptFile);

    try {
      for (const pid of allPids(receipt)) expect(processExists(pid)).toBe(true);
      const identities = allPids(receipt).map(captureProcessIdentity);
      await session.interrupt();
      await session.close();
      identities.forEach(expectProcessNotLive);
    } finally {
      reapAll(allPids(receipt));
    }
  });
});

describe.skipIf(process.platform === 'win32')('POSIX descendants that left the owned process group', () => {
  it.each([
    { stop: 'honours SIGTERM', ignoreTerm: '0' },
    { stop: 'ignores SIGTERM', ignoreTerm: '1' },
    // #1269: once the root is gone nothing below it leads to the grandchild; the observation taken while it ran does.
    { stop: 'is SIGKILLed from outside', ignoreTerm: '0', outsideKill: true },
    // #1298: the host's PATH need not name the process-table reader.
    { stop: 'honours SIGTERM, under an empty PATH', ignoreTerm: '0', emptyPath: true },
  ])('dispose ends a setsid grandchild when the root $stop', async ({ ignoreTerm, outsideKill, emptyPath }) => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-process-tree-setsid-'));
    const receiptFile = path.join(workspaceDir, 'process-tree.json');
    // The owned root starts its grandchild with `detached: true`: a session and group of its own.
    const child = spawn(process.execPath, [DESCENDANT_FIXTURE, receiptFile, '0', ignoreTerm, '', '1'], withOwnedProcessTree({
      stdio: 'ignore', env: {},
    }));
    let closed = false;
    const closeReceipt = new Promise<void>((resolve) => child.once('close', () => { closed = true; resolve(); }));
    const receipt = await readReceipt(receiptFile, ['descendantPid', 'grandchildPid']);
    const pids = [receipt.descendantPid, receipt.grandchildPid];
    try {
      expect(pids.map(processExists)).toEqual([true, true]);
      const identities = pids.map(captureProcessIdentity);
      await adoptOwnedProcessTree({ child, label: 'setsid fixture' });
      if (outsideKill) {
        await new Promise((resolve) => setTimeout(resolve, 2 * OWNED_TREE_OBSERVE_MS));
        child.kill('SIGKILL');
        await closeReceipt;
      }
      if (emptyPath) vi.stubEnv('PATH', '');
      await disposeOwnedProcessTree({
        child, waitClosed: () => closeReceipt, isClosed: () => closed, label: 'setsid fixture', termGraceMs: 300,
      });
      identities.forEach(expectProcessNotLive);
    } finally {
      vi.unstubAllEnvs();
      reapAll(pids);
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it('disposal ends members born while the group continuously forks', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-forking-tree-'));
    forkingDirectories.push(directory);
    const marker = path.join(directory, 'forked');
    const script = `process.on('SIGTERM', () => {}); process.on('SIGUSR2', () => require('node:child_process').spawn('/bin/sh', ['-c', 'sleep 600 & echo ready > "$1"; while :; do sleep 600 & sleep 0.01; done', 'forker', ${JSON.stringify(marker)}], { stdio: 'ignore' })); console.log('ready'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ['-e', script],
      withOwnedProcessTree({ cwd: directory, stdio: ['ignore', 'pipe', 'ignore'] }));
    const pgid = child.pid!;
    forkingGroups.add(pgid);
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      child.stdout!.once('data', () => resolve());
      child.once('error', reject);
    });
    let first = true;
    let missed: ProcessIdentity[] = [];
    await disposeOwnedProcessTree({
      child, waitClosed: () => closed, isClosed: () => child.signalCode !== null, label: 'forking fixture', termGraceMs: 0,
      killFn: (pid, signal) => {
        if (pid === -pgid && signal === 'SIGKILL' && first) {
          first = false;
          // Model the kernel's first delivery missing births after the pre-kill snapshot.
          process.kill(pgid, 'SIGUSR2');
          execFileSync('/bin/sh', ['-c', 'while ! test -f "$1"; do sleep 0.01; done', 'wait', marker], { timeout: 2000 });
          missed = [...readOwnedProcessTable().values()].filter(entry => entry.pgid === pgid && entry.pid !== pgid);
          expect(missed.length).toBeGreaterThan(0);
          process.kill(pgid, signal);
        } else process.kill(pid, signal);
      },
    });
    expect(first).toBe(false);
    missed.forEach(expectProcessNotLive);
    expect([...readOwnedProcessTable().values()].filter(entry => entry.pgid === pgid && entry.zombie !== true)).toEqual([]);
  });

  it('a resend EPERM retains the quiescence error at the original kill deadline', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], withOwnedProcessTree({ stdio: 'ignore' }));
    forkingGroups.add(child.pid!);
    await new Promise(resolve => child.once('spawn', resolve));
    const killGraceMs = 80;
    let deliveries = 0;
    vi.useFakeTimers();
    const started = Date.now();
    try {
      const outcome = disposeOwnedProcessTree({
        child, label: 'EPERM fixture', waitClosed: () => new Promise(() => {}), isClosed: () => false,
        termGraceMs: 0, killGraceMs,
        killFn: (pid, signal) => {
          if (pid === -child.pid! && signal === 'SIGKILL' && ++deliveries > 1) {
            throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
          }
        },
      }).then(() => ({ error: undefined, elapsed: Date.now() - started }), error => ({ error, elapsed: Date.now() - started }));
      await vi.advanceTimersByTimeAsync(2200);
      const result = await outcome;
      expect(deliveries).toBeGreaterThan(1);
      expect(result).toMatchObject({ elapsed: killGraceMs, error: { name: 'RuntimeDisposalFailure', stage: 'quiescence', message: 'EPERM fixture runtime process group remained live after SIGKILL' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unreadable process table fails the disposal typed, naming the read (#1298)', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], withOwnedProcessTree({ stdio: 'ignore', env: {} }));
    await new Promise((resolve) => child.once('spawn', resolve));
    const unreadable = (): never => { throw new Error('Process table ps: spawn_failed (ENOENT) after 1 ms'); };
    try {
      await expect(disposeOwnedProcessTree({
        child, waitClosed: () => new Promise(() => {}), isClosed: () => false, label: 'pi', readProcessTableFn: unreadable,
      })).rejects.toMatchObject({
        name: 'RuntimeDisposalFailure', stage: 'signal', message: 'pi runtime process table could not be read: Process table ps: spawn_failed (ENOENT) after 1 ms',
      });
      expect(processExists(child.pid!)).toBe(true);
    } finally {
      reapAll([child.pid!]);
    }
  });

  it('retains an unreadable cross-group descendant until a retry can confirm exit', async () => {
    const rootPid = 900_001;
    const descendantPid = 900_002;
    let rootRunning = true;
    const child = { pid: rootPid, exitCode: null, get signalCode() { return rootRunning ? null : 'SIGTERM'; } } as ChildProcess;
    const descendant = { pid: descendantPid, ppid: rootPid, pgid: descendantPid, start: 'descendant start' };
    const unreadable = new Set([descendantPid]);
    const options = {
      child, label: 'unreadable descendant', waitClosed: async () => {}, isClosed: () => !rootRunning, killGraceMs: 0,
      observeProcessTableFn: () => rootRunning ? { table: new Map([[descendantPid, descendant]]) } : { table: new Map(), unreadable },
      killFn(pid: number, signal: NodeJS.Signals | number) {
        expect(pid).toBe(-rootPid);
        if (!rootRunning) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        if (signal === 'SIGTERM') rootRunning = false;
      },
    };
    const unconfirmed = { name: 'RuntimeDisposalFailure', stage: 'quiescence', message: expect.stringContaining('not confirmed exited') };
    await expect(disposeOwnedProcessTree(options)).rejects.toMatchObject(unconfirmed);
    await expect(disposeOwnedProcessTree(options)).rejects.toMatchObject(unconfirmed);
    unreadable.clear();
    await expect(disposeOwnedProcessTree(options)).resolves.toBeUndefined();
  });

  // #2483: Darwin's killpg can miss a member forked while the SIGTERM is sent.
  // `memberExitsAfterMs` is how long after the first SIGTERM the group's last member exits; it exits on SIGKILL or a resend regardless.
  async function missedMemberDisposal({ rootRunning, termGraceMs, memberExitsAfterMs = Infinity }: { rootRunning: boolean; termGraceMs: number; memberExitsAfterMs?: number }) {
    const rootPid = 900_005;
    let memberLive = true;
    let firstTermAt: number | undefined;
    const signals: Array<NodeJS.Signals | number> = [];
    const child = { pid: rootPid, exitCode: null, get signalCode() { return rootRunning ? null : 'SIGTERM'; } } as ChildProcess;
    await disposeOwnedProcessTree({
      child, label: 'missed member', waitClosed: async () => {}, isClosed: () => !rootRunning, termGraceMs, killGraceMs: 0,
      observeProcessTableFn: () => ({ table: new Map() }),
      killFn(pid, signal) {
        expect(pid).toBe(-rootPid);
        if (signal === 0) {
          if (firstTermAt !== undefined && Date.now() - firstTermAt >= memberExitsAfterMs) memberLive = false;
          if (!memberLive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
          return;
        }
        signals.push(signal);
        // The first SIGTERM ends the root and misses the member; any later signal reaches it.
        if (signal === 'SIGTERM' && firstTermAt === undefined) {
          firstTermAt = Date.now();
          rootRunning = false;
        } else memberLive = false;
      },
    });
    return signals;
  }

  it('resends SIGTERM once when the root exited but its group outlived the first SIGTERM', async () => {
    await expect(missedMemberDisposal({ rootRunning: true, termGraceMs: 5_000 })).resolves.toEqual(['SIGTERM', 'SIGTERM']);
  });

  it('does not resend SIGTERM to a group that exits within a poll of the first SIGTERM', async () => {
    await expect(missedMemberDisposal({ rootRunning: false, termGraceMs: 5_000, memberExitsAfterMs: 5 })).resolves.toEqual(['SIGTERM']);
  });

  it('escalates without a resend when termGraceMs is 0', async () => {
    await expect(missedMemberDisposal({ rootRunning: false, termGraceMs: 0 })).resolves.toEqual(['SIGTERM', 'SIGKILL']);
  });

  function zombieDescendantDisposal(killGraceMs: number) {
    const rootPid = 900_003;
    const descendantPid = 900_004;
    let rootRunning = true;
    const child = { pid: rootPid, exitCode: null, get signalCode() { return rootRunning ? null : 'SIGTERM'; } } as ChildProcess;
    const host = { pid: process.pid, ppid: process.ppid, pgid: process.pid, start: 'host start' };
    const descendant = { pid: descendantPid, ppid: rootPid, pgid: descendantPid, start: 'descendant start' };
    const liveTable = new Map([[host.pid, host], [descendantPid, descendant]]);
    const zombie = { ...descendant, zombie: true as const };
    const zombieTable = new Map([[host.pid, host], [descendantPid, zombie]]);
    const observeProcessTableFn = vi.fn((_timeoutMs?: number): ReturnType<typeof processTree.observeOwnedProcessTable> => ({
      table: rootRunning ? liveTable : zombieTable,
    }));
    const dispose = () => disposeOwnedProcessTree({
      child, label: 'zombie descendant', waitClosed: async () => {}, isClosed: () => !rootRunning, killGraceMs,
      observeProcessTableFn,
      killFn(pid, signal) {
        expect(pid).toBe(-rootPid);
        if (!rootRunning) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        if (signal === 'SIGTERM') rootRunning = false;
      },
    });
    return { dispose, observeProcessTableFn, liveTable, zombieTable };
  }

  it('settles disposal when a remembered cross-group descendant is a zombie', async () => {
    const { dispose, observeProcessTableFn, liveTable, zombieTable } = zombieDescendantDisposal(0);
    await expect(dispose()).resolves.toBeUndefined();
    expect(observeProcessTableFn).toHaveBeenCalledTimes(2);
    expect(observeProcessTableFn).toHaveNthReturnedWith(1, { table: liveTable });
    expect(observeProcessTableFn).toHaveNthReturnedWith(2, { table: zombieTable });
  });

  it('waits for a remembered cross-group zombie to be reaped without signalling it', async () => {
    vi.useFakeTimers();
    const nativeKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const { dispose, observeProcessTableFn } = zombieDescendantDisposal(250);
      const settled = vi.fn();
      const done = dispose().then(settled);
      await vi.advanceTimersByTimeAsync(0);
      expect(observeProcessTableFn).toHaveBeenCalledTimes(3);
      expect(settled).not.toHaveBeenCalled();
      observeProcessTableFn.mockReturnValue({ table: new Map() });
      await vi.advanceTimersByTimeAsync(20);
      await expect(done).resolves.toBeUndefined();
      expect(settled).toHaveBeenCalledOnce();
      expect(observeProcessTableFn).toHaveBeenCalledTimes(4);
      expect(nativeKill).not.toHaveBeenCalled();
    } finally {
      nativeKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it('settles at the 250 ms reap deadline with a persistent zombie', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    try {
      const { dispose, observeProcessTableFn } = zombieDescendantDisposal(2_000);
      const settled = vi.fn();
      const done = dispose().then(() => settled(Date.now() - started));
      await vi.advanceTimersByTimeAsync(249);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toHaveBeenCalledExactlyOnceWith(250);
      expect(observeProcessTableFn).toHaveBeenLastCalledWith(10);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the remaining reap budget to ps and settles when ps times out', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const ps = vi.spyOn(childProcess, 'execFileSync');
    try {
      const { dispose, observeProcessTableFn, liveTable, zombieTable } = zombieDescendantDisposal(250);
      const budgets: number[] = [];
      ps.mockImplementation((_file, _args, options) => {
        const timeout = options?.timeout ?? 0;
        budgets.push(timeout);
        if (budgets.length === 1) {
          vi.setSystemTime(Date.now() + 215);
          return [...zombieTable.values()].map(entry =>
            `${entry.pid} ${entry.ppid} ${entry.pgid} ${'zombie' in entry ? 'Z' : 'S'} ${entry.start}`,
          ).join('\n');
        }
        vi.setSystemTime(Date.now() + timeout);
        throw Object.assign(new Error('ps stalled'), { code: 'ETIMEDOUT' });
      });
      // Keep the synthetic state during the signal and quiescence checks.
      // Use the real ps reader as soon as the reap wait supplies a deadline.
      observeProcessTableFn.mockImplementation(timeoutMs => timeoutMs === undefined
        ? { table: zombieTable }
        : processTree.observeOwnedProcessTable('ps', undefined, timeoutMs));
      observeProcessTableFn.mockReturnValueOnce({ table: liveTable });
      const settled = vi.fn();
      const done = dispose().then(() => settled(Date.now() - started));
      await vi.advanceTimersByTimeAsync(20);
      expect(budgets).toEqual([250, 15]);
      expect(settled).toHaveBeenCalledExactlyOnceWith(250);
      await done;
    } finally {
      ps.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a disposal whose last table read timed out still ends the remembered setsid grandchild on retry (#2105)', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-process-tree-retry-'));
    const receiptFile = path.join(workspaceDir, 'process-tree.json');
    const child = spawn(process.execPath, [DESCENDANT_FIXTURE, receiptFile, '0', '0', '', '1'], withOwnedProcessTree({ stdio: 'ignore', env: {} }));
    let closed = false;
    const closeReceipt = new Promise<void>((resolve) => child.once('close', () => { closed = true; resolve(); }));
    const receipt = await readReceipt(receiptFile, ['descendantPid', 'grandchildPid']);
    let reads = 0;
    const options = {
      child, waitClosed: () => closeReceipt, isClosed: () => closed, label: 'setsid fixture', termGraceMs: 300,
      // The read before the SIGTERM succeeds; the read before killing what left the group times out once.
      readProcessTableFn: () => {
        reads += 1;
        if (reads === 2) throw new Error('Process table ps: timed out after 2000 ms, exit unconfirmed');
        return readOwnedProcessTable();
      },
    };
    try {
      await expect(disposeOwnedProcessTree(options)).rejects.toMatchObject({ name: 'RuntimeDisposalFailure', message: expect.stringContaining('exit unconfirmed') });
      expect(processExists(receipt.grandchildPid)).toBe(true);
      const grandchild = captureProcessIdentity(receipt.grandchildPid);
      await disposeOwnedProcessTree(options);
      // The successful retry reads once to signal and again to confirm exit.
      expect(reads).toBeGreaterThanOrEqual(4);
      expectProcessNotLive(grandchild);
    } finally {
      reapAll([receipt.descendantPid, receipt.grandchildPid]);
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('a hung ps is SIGKILLed at its time limit and the disposal is refused before any group signal (#2105)', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-hung-ps-'));
    const fakePs = path.join(workspaceDir, 'ps');
    // Ignores SIGTERM like a ps stuck reading a wedged process; only SIGKILL ends it.
    await fs.writeFile(fakePs, "#!/bin/sh\ntrap '' TERM\nexec sleep 30\n", { mode: 0o755 });
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], withOwnedProcessTree({ stdio: 'ignore', env: {} }));
    await new Promise((resolve) => child.once('spawn', resolve));
    const signals: Array<[number, NodeJS.Signals | number]> = [];
    const started = Date.now();
    try {
      await expect(disposeOwnedProcessTree({
        child, waitClosed: () => new Promise(() => {}), isClosed: () => false, label: 'pi',
        killFn: (pid, signal) => { signals.push([pid, signal]); process.kill(pid, signal); },
        readProcessTableFn: () => readOwnedProcessTable('ps', fakePs),
      })).rejects.toMatchObject({ name: 'RuntimeDisposalFailure', stage: 'signal', message: expect.stringContaining('exit unconfirmed') });
      expect(Date.now() - started).toBeLessThan(4_000);
      expect(signals.filter(([pid, signal]) => pid < 0 && signal !== 0)).toEqual([]);
    } finally {
      reapAll([child.pid!]);
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  }, 10_000);
});
