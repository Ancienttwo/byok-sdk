import type { RuntimeTaskInput } from '../types';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { isRuntimeDisposalFailure } from '../runtime-failure';
import { OWNED_TREE_OBSERVE_MS, adoptOwnedProcessTree, disposeOwnedProcessTree, withOwnedProcessTree } from '../adapters/process-tree';
import { startPreparedOperation } from './fixtures/prepared-operation';

const PI_FIXTURE = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));
const CLAUDE_FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const CODEX_FIXTURE = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const DESCENDANT_FIXTURE = fileURLToPath(new URL('./fixtures/process-tree-descendant.mjs', import.meta.url));

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
    if (!processExists(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // A process that exited between the probe and cleanup is already safe.
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
    const offer: RuntimeTaskInput = { instruction: 'stay alive' };
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
      await session.close();
      if (process.platform !== 'win32') expect(Date.now() - startedAt).toBeGreaterThanOrEqual(650);
      for (const pid of allPids(receipt)) expect(processExists(pid)).toBe(false);
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
      expect(processExists(child.pid!)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      reapAll([child.pid!]);
    }
  });

  it('Pi close resolves only after its real root, descendant and grandchild are all gone', async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-process-tree-'));
    const receiptFile = path.join(workspaceDir, 'process-tree.json');
    const offer: RuntimeTaskInput = { instruction: 'stay alive' };
    const adapter = new PiAdapter({ resolveBin: () => ({ command: PI_FIXTURE, source: 'package' }) });
    const session = await startPreparedOperation(adapter, offer, {
      workspaceDir,
      env: { ...process.env, FAKE_PI_PROCESS_TREE_FILE: receiptFile },
    });
    const receipt = await readReceipt(receiptFile);

    try {
      for (const pid of allPids(receipt)) expect(processExists(pid)).toBe(true);
      await session.interrupt();
      await session.close();
      for (const pid of allPids(receipt)) expect(processExists(pid)).toBe(false);
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
    const offer: RuntimeTaskInput = { instruction: 'stay alive' };
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
        for (const pid of recorded) expect(processExists(pid)).toBe(false);
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
    const offer: RuntimeTaskInput = { instruction: 'stay alive' };
    const session = await startPreparedOperation(adapter(), offer, {
      workspaceDir,
      env: { ...process.env, ...env(receiptFile) },
    });
    const receipt = await readReceipt(receiptFile);

    try {
      for (const pid of allPids(receipt)) expect(processExists(pid)).toBe(true);
      await session.interrupt();
      await session.close();
      for (const pid of allPids(receipt)) expect(processExists(pid)).toBe(false);
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
      expect(pids.map(processExists)).toEqual([false, false]);
    } finally {
      vi.unstubAllEnvs();
      reapAll(pids);
      await fs.rm(workspaceDir, { recursive: true, force: true });
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
});
