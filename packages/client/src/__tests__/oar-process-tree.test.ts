import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { descendantsOf, killEntries, readProcessTable, type ProcessEntry } from '../runtime/oar-process-tree.js';

// Ported from OAR v0.37.0 tests/process-tree.test.ts (6d1589d) for the vendored
// shared/executable/process-tree.ts that src/adapters/process-tree.ts calls.

const posix = process.platform !== 'win32';
const SLEEP = ['-e', 'setTimeout(() => {}, 60000)'];
// A leader in a session of its own that reports a member of its group: a process only the group signal reaches.
const LEADER = String.raw`
  const member = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", env: {} });
  member.once("spawn", () => { process.stdout.write(member.pid + "\n"); });
  setTimeout(() => {}, 60000);
`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function gone(pid: number, withinMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (alive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

/** A Node process sleeping for a minute; `detached` puts it in a session of its own. */
function sleeper(options: { readonly detached?: boolean } = {}): ChildProcess {
  return spawn(process.execPath, SLEEP, { stdio: 'ignore', env: {}, detached: options.detached === true });
}

/** Run `body` with the children started; SIGKILL them (and `extra` pids) afterwards. */
async function withChildren(children: readonly ChildProcess[], body: (pids: readonly number[], extra: number[]) => Promise<void>): Promise<void> {
  const extra: number[] = [];
  try {
    await Promise.all(children.map(async (child) => once(child, 'spawn')));
    await body(children.map((child) => child.pid ?? 0), extra);
  } finally {
    for (const child of children) child.kill('SIGKILL');
    for (const pid of extra) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Gone. */ }
    }
  }
}

function entry(pid: number, ppid: number): ProcessEntry {
  return { pid, ppid, pgid: pid, start: '0' };
}

const sorted = (pids: number[]): number[] => [...pids].sort((left, right) => left - right);

describe('OAR process table', () => {
  it('descendantsOf finds children and theirs, nothing above or beside, and ends on a cycle', () => {
    const table = new Map([
      entry(10, 1), entry(11, 10), entry(12, 10), entry(13, 12), entry(20, 1), entry(21, 20),
      // A table read across a pid reuse can loop; the walk still ends.
      entry(30, 31), entry(31, 30),
    ].map((process) => [process.pid, process] as const));
    expect(sorted(descendantsOf(table, 10).map(({ pid }) => pid))).toEqual([11, 12, 13]);
    expect(descendantsOf(table, 13)).toEqual([]);
    expect(descendantsOf(table, 30).map(({ pid }) => pid)).toEqual([31]);
    expect(descendantsOf(table, 99)).toEqual([]);
  });

  it.skipIf(!posix)('shows this process and children it just started, the detached one in its own group', async () => {
    await withChildren([sleeper(), sleeper({ detached: true })], async ([attached = 0, detached = 0]) => {
      const table = readProcessTable();
      const [host, child, session] = [table.get(process.pid), table.get(attached), table.get(detached)];
      expect(host && child && session).toBeTruthy();
      expect([child!.ppid, child!.pgid]).toEqual([process.pid, host!.pgid]);
      expect([session!.ppid, session!.pgid]).toEqual([process.pid, detached]);
      const below = new Set(descendantsOf(table, process.pid).map(({ pid }) => pid));
      expect(below.has(attached) && below.has(detached)).toBe(true);
      // The start time names the process: the same in a second read.
      expect(readProcessTable().get(attached)?.start).toBe(child!.start);
    });
  });

  it.skipIf(!posix)('killEntries spares a pid whose start time differs: it may be another process by now', async () => {
    await withChildren([sleeper({ detached: true })], async ([pid = 0]) => {
      const table = readProcessTable();
      const current = table.get(pid);
      expect(current).toBeDefined();
      killEntries([{ ...current!, start: `${current!.start}-earlier` }], table);
      expect(await gone(pid, 300)).toBe(false);
      killEntries([current!], readProcessTable());
      expect(await gone(pid)).toBe(true);
    });
  });

  it.skipIf(!posix)('killEntries takes each entry\'s process group too, never the host or its group', async () => {
    const leader = spawn(process.execPath, ['-e', LEADER], { stdio: ['ignore', 'pipe', 'ignore'], env: {}, detached: true });
    const reported = once(leader.stdout!, 'data');
    await withChildren([leader, sleeper(), sleeper()], async ([leaderPid = 0, target = 0, sibling = 0], extra) => {
      const data: unknown[] = await reported;
      const member = Number(String(data[0]));
      extra.push(member);
      const table = readProcessTable();
      const [host, leaderEntry, targetEntry] = [table.get(process.pid), table.get(leaderPid), table.get(target)];
      expect(host && leaderEntry && targetEntry).toBeTruthy();
      expect([targetEntry!.pgid, table.get(member)?.pgid]).toEqual([host!.pgid, leaderPid]);
      killEntries([host!, leaderEntry!, targetEntry!], table);
      expect([await gone(leaderPid), await gone(member), await gone(target)]).toEqual([true, true, true]);
      expect(await gone(sibling, 300)).toBe(false);
    });
  });
});
