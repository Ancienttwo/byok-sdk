import { spawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adoptOwnedProcessTree,
  attachOwnedProcessGroupLedger,
  currentBootId,
  disposeOwnedProcessTree,
  reapOwnedProcessGroups,
  requestOwnedProcessTreeTermination,
  withOwnedProcessTree,
  type OwnedProcessGroupRecord,
} from '../adapters/process-tree';
import { OWNED_PROCESSES_DIRECTORY, OwnedProcessLedger, OwnedProcessResidueError } from '../daemon/owned-process-ledger';
import { readProcessTable } from '../runtime/oar-process-tree.js';

/**
 * #384 item 3 / #393: what a SIGKILLed daemon's owned runtime groups leave
 * behind on POSIX, and how the next owner of the store ends them. Every tree
 * here is a real process group.
 */

const spawned: ChildProcess[] = [];
const orphanGroups: number[] = [];
const detachers: Array<() => void> = [];
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-owned-pgroup-'));
});

afterEach(async () => {
  for (const detach of detachers.splice(0)) detach();
  for (const child of spawned.splice(0)) {
    if (child.pid !== undefined && groupAlive(child.pid)) process.kill(-child.pid, 'SIGKILL');
  }
  for (const pgid of orphanGroups.splice(0)) {
    if (groupAlive(pgid)) process.kill(-pgid, 'SIGKILL');
  }
  await fs.rm(root, { recursive: true, force: true });
});

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** The in-group tool shell runs `sleep 600; :`, so the sleep is the root's grandchild. */
const TOOL_SHELL = `sh -c 'sleep 600; :' &`;

/** A runtime tree this process owns: a detached group leader with an in-group tool shell. */
async function spawnOwnedTree(): Promise<{ child: ChildProcess; pgid: number; closed: Promise<void> }> {
  const child = spawn('/bin/sh', ['-c', `${TOOL_SHELL} echo $!; cat >/dev/null; wait`], withOwnedProcessTree({ stdio: ['pipe', 'pipe', 'ignore'] }));
  spawned.push(child);
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once('data', () => resolve());
    child.once('error', reject);
  });
  return { child, pgid: child.pid!, closed };
}

/**
 * What a dead daemon leaves: a group leader that is no longer this process's
 * child (re-parented, as after the daemon's SIGKILL), with an in-group tool
 * shell and a child in a session of its own. The root ignores stdin EOF.
 */
async function spawnOrphanedTree(): Promise<{ pgid: number; toolPid: number; sessionPid: number }> {
  const pids = path.join(root, `tree-${Math.random().toString(16).slice(2)}.json`);
  const rootScript = `${TOOL_SHELL} tool=$!; perl -MPOSIX -e 'POSIX::setsid(); exec "sleep", "600"' & printf '{"pgid":%d,"toolPid":%d,"sessionPid":%d}' $$ $tool $! > "$0.tmp"; mv "$0.tmp" "$0"; wait`;
  const launcher = spawn('/bin/sh', ['-c', `perl -e 'setpgrp(0, 0); exec @ARGV' /bin/sh -c "$1" "$2" </dev/null >/dev/null 2>&1 &`, 'launcher', rootScript, pids], { stdio: 'ignore' });
  await new Promise<void>((resolve) => launcher.once('exit', () => resolve()));
  for (;;) {
    try {
      const tree = JSON.parse(await fs.readFile(pids, 'utf8')) as { pgid: number; toolPid: number; sessionPid: number };
      orphanGroups.push(tree.pgid, tree.sessionPid);
      return tree;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/** A dead writer: no process holds this pid with this start time. */
const DEAD_WRITER = { writerPid: 999_999, writerStart: 'not a start time' };

/** What a SIGKILLed daemon's ledger holds for `pgid`. */
function recordFor(pgid: number): OwnedProcessGroupRecord {
  const entry = readProcessTable().get(pgid);
  if (entry === undefined) throw new Error('fixture root is not in the process table');
  return { pgid, rootStart: entry.start, bootId: currentBootId(), ...DEAD_WRITER };
}

/** A start time later than any process now running, in this platform's table format. */
const FUTURE_START = process.platform === 'linux' ? '999999999999999' : 'Fri Jan  1 00:00:00 2100';

function synthetic(pgid: number, rootStart: string): OwnedProcessGroupRecord {
  return { pgid, rootStart, bootId: currentBootId(), ...DEAD_WRITER };
}

const NOTHING = { found: 0, terminated: 0, survived: 0, liveWriter: 0, survivors: [] };

function attachRecorder(): { adopted: OwnedProcessGroupRecord[]; disposed: OwnedProcessGroupRecord[] } {
  const seen = { adopted: [] as OwnedProcessGroupRecord[], disposed: [] as OwnedProcessGroupRecord[] };
  detachers.push(attachOwnedProcessGroupLedger({
    adopted: async (record) => { seen.adopted.push(record); },
    disposed: async (record) => { seen.disposed.push(record); },
  }));
  return seen;
}

async function ledgerFiles(): Promise<string[]> {
  try {
    return await fs.readdir(path.join(root, OWNED_PROCESSES_DIRECTORY));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

describe.skipIf(process.platform === 'win32')('owned runtime process groups after a daemon SIGKILL (#384, #393)', () => {
  it('adoption records only the group id and root start time, and the disposal receipt removes it', async () => {
    const seen = attachRecorder();
    const tree = await spawnOwnedTree();
    await adoptOwnedProcessTree({ child: tree.child, label: 'fixture' });
    const table = readProcessTable();
    expect(seen.adopted).toEqual([{
      pgid: tree.pgid, rootStart: table.get(tree.pgid)!.start, bootId: currentBootId(),
      writerPid: process.pid, writerStart: table.get(process.pid)!.start,
    }]);
    expect(seen.disposed).toEqual([]);

    const options = { child: tree.child, waitClosed: () => tree.closed, isClosed: () => tree.child.exitCode !== null || tree.child.signalCode !== null, label: 'fixture' };
    await requestOwnedProcessTreeTermination(options);
    await disposeOwnedProcessTree(options);
    expect(groupAlive(tree.pgid)).toBe(false);
    expect(seen.disposed).toEqual(seen.adopted);
  });

  it('an unreadable process table fails the adoption instead of skipping the record', async () => {
    attachRecorder();
    const tree = await spawnOwnedTree();
    await expect(adoptOwnedProcessTree({ child: tree.child, label: 'fixture', readProcessTableFn: () => new Map() }))
      .rejects.toThrow('the process table is unreadable');
  });

  it('a running root missing from the table fails the adoption; an exited one records nothing', async () => {
    const seen = attachRecorder();
    const running = await spawnOwnedTree();
    const withoutRoot = () => new Map([...readProcessTable()].filter(([pid]) => pid !== running.pgid));
    await expect(adoptOwnedProcessTree({ child: running.child, label: 'fixture', readProcessTableFn: withoutRoot }))
      .rejects.toThrow('its root is missing from the process table');

    const exited = spawn('/bin/sh', ['-c', 'exit 0'], withOwnedProcessTree({ stdio: 'ignore' }));
    await new Promise<void>((resolve) => exited.once('exit', () => resolve()));
    await adoptOwnedProcessTree({ child: exited, label: 'fixture' });
    expect(seen.adopted).toEqual([]);
  });

  it('a ledger write failure fails the adoption', async () => {
    detachers.push(attachOwnedProcessGroupLedger({
      adopted: async () => { throw new Error('ledger unavailable'); },
      disposed: async () => {},
    }));
    const tree = await spawnOwnedTree();
    await expect(adoptOwnedProcessTree({ child: tree.child, label: 'fixture' })).rejects.toThrow('ledger unavailable');
  });

  it('the store ledger writes one 0600 file per group with no path or command, and removes it on disposal', async () => {
    const ledger = new OwnedProcessLedger(root);
    detachers.push(attachOwnedProcessGroupLedger(ledger));
    const tree = await spawnOwnedTree();
    await adoptOwnedProcessTree({ child: tree.child, label: 'fixture' });
    const [name] = await ledgerFiles();
    const file = path.join(root, OWNED_PROCESSES_DIRECTORY, name!);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    const raw = await fs.readFile(file, 'utf8');
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['bootId', 'pgid', 'recordedAt', 'rootStart', 'version', 'writerPid', 'writerStart']);
    expect(raw).not.toContain(root);
    expect(raw).not.toMatch(/sleep|\/bin\/sh|fixture/u);

    const options = { child: tree.child, waitClosed: () => tree.closed, isClosed: () => tree.child.exitCode !== null || tree.child.signalCode !== null, label: 'fixture' };
    await requestOwnedProcessTreeTermination(options);
    await disposeOwnedProcessTree(options);
    expect(await ledgerFiles()).toEqual([]);
  });

  it('reconcile ends a crashed run’s group — in-group grandchild and own-session child included — and empties the ledger', async () => {
    const tree = await spawnOrphanedTree();
    const ledger = new OwnedProcessLedger(root);
    await ledger.adopted(recordFor(tree.pgid));
    // The root ignored EOF and is not this process's child: nothing here owns it.
    expect(readProcessTable().get(tree.pgid)?.ppid).not.toBe(process.pid);

    expect(await ledger.reconcile()).toEqual({ recorded: 1, found: 1, terminated: 1, survived: 0, liveWriter: 0 });
    expect(groupAlive(tree.pgid)).toBe(false);
    expect(processAlive(tree.toolPid)).toBe(false);
    expect(processAlive(tree.sessionPid)).toBe(false);
    expect(await ledgerFiles()).toEqual([]);
  });

  it('ends what still carries the pgid after the root itself is gone', async () => {
    const tree = await spawnOrphanedTree();
    const record = recordFor(tree.pgid);
    process.kill(tree.pgid, 'SIGKILL');
    await expect.poll(() => readProcessTable().has(tree.pgid)).toBe(false);
    expect(processAlive(tree.toolPid)).toBe(true);
    expect(groupAlive(tree.pgid)).toBe(true);

    expect(await reapOwnedProcessGroups([record])).toEqual({ ...NOTHING, found: 1, terminated: 1, ended: [record] });
    expect(groupAlive(tree.pgid)).toBe(false);
  });

  it('a leaderless group holding a process older than the recorded root is not ours: no signal', async () => {
    const tree = await spawnOrphanedTree();
    process.kill(tree.pgid, 'SIGKILL');
    await expect.poll(() => readProcessTable().has(tree.pgid)).toBe(false);
    // The recorded root claims to have started after every process now in the group.
    const record = synthetic(tree.pgid, FUTURE_START);
    expect(await reapOwnedProcessGroups([record])).toEqual({ ...NOTHING, ended: [record] });
    expect(processAlive(tree.toolPid)).toBe(true);
    expect(groupAlive(tree.pgid)).toBe(true);
  });

  it('a record from an earlier boot is declared ended without any signal', async () => {
    const tree = await spawnOrphanedTree();
    const record = { ...recordFor(tree.pgid), bootId: 'an-earlier-boot' };
    const ledger = new OwnedProcessLedger(root);
    await ledger.adopted(record);
    expect(await ledger.reconcile()).toEqual({ recorded: 1, found: 0, terminated: 0, survived: 0, liveWriter: 0 });
    expect(processAlive(tree.pgid)).toBe(true);
    expect(processAlive(tree.toolPid)).toBe(true);
    expect(await ledgerFiles()).toEqual([]);
  });

  it('signals nothing when the leader pid now belongs to a different process', async () => {
    const tree = await spawnOrphanedTree();
    // Same pid, different start time: what a reused pid looks like.
    const reused = synthetic(tree.pgid, 'Thu Jan  1 00:00:00 1970');
    expect(await reapOwnedProcessGroups([reused])).toEqual({ ...NOTHING, ended: [reused] });
    expect(processAlive(tree.pgid)).toBe(true);
    expect(processAlive(tree.toolPid)).toBe(true);
    expect(processAlive(tree.sessionPid)).toBe(true);
  });

  it('a record whose writer process still runs is left alone and kept, even in another store\u2019s ledger', async () => {
    const tree = await spawnOrphanedTree();
    const table = readProcessTable();
    const live = { ...recordFor(tree.pgid), writerPid: process.pid, writerStart: table.get(process.pid)!.start };
    const ledger = new OwnedProcessLedger(root);
    await ledger.adopted(live);
    expect(await ledger.reconcile()).toEqual({ recorded: 1, found: 0, terminated: 0, survived: 0, liveWriter: 1 });
    expect(groupAlive(tree.pgid)).toBe(true);
    expect(await ledgerFiles()).toHaveLength(1);
  });

  it('a group that is already gone is confirmed ended and its record dropped', async () => {
    const tree = await spawnOrphanedTree();
    const ledger = new OwnedProcessLedger(root);
    await ledger.adopted(recordFor(tree.pgid));
    process.kill(-tree.pgid, 'SIGKILL');
    await expect.poll(() => groupAlive(tree.pgid)).toBe(false);
    expect(await ledger.reconcile()).toEqual({ recorded: 1, found: 0, terminated: 0, survived: 0, liveWriter: 0 });
    expect(await ledgerFiles()).toEqual([]);
  });

  it('a surviving group refuses reconciliation and keeps every record for the next attempt', async () => {
    const records = [synthetic(4242, 'Tue Oct 13 10:00:00 2026'), synthetic(4343, 'Tue Oct 13 10:00:01 2026')];
    const refusing = new OwnedProcessLedger(root, {
      reap: async () => ({ found: 2, terminated: 1, survived: 1, liveWriter: 0, ended: [records[0]!], survivors: [records[1]!] }),
    });
    for (const record of records) await refusing.adopted(record);
    const before = (await ledgerFiles()).sort();
    const refusal = await refusing.reconcile().catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(OwnedProcessResidueError);
    // The message names the surviving record by full path and the operator remedy.
    expect((refusal as Error).message).toContain(path.join(root, OWNED_PROCESSES_DIRECTORY));
    expect((refusal as Error).message).toContain('Verify the processes are gone, then delete');
    expect((await ledgerFiles()).sort()).toEqual(before);

    const reaped: Array<readonly OwnedProcessGroupRecord[]> = [];
    const next = new OwnedProcessLedger(root, {
      reap: async (groups) => { reaped.push(groups); return { ...NOTHING, ended: [...groups] }; },
    });
    expect(await next.reconcile()).toEqual({ recorded: 2, found: 0, terminated: 0, survived: 0, liveWriter: 0 });
    expect([...reaped[0]!].sort((a, b) => a.pgid - b.pgid)).toEqual(records);
    expect(await ledgerFiles()).toEqual([]);
  });

  it('a corrupt record fails closed', async () => {
    const ledger = new OwnedProcessLedger(root);
    await ledger.adopted(synthetic(4242, 'Tue Oct 13 10:00:00 2026'));
    const [name] = await ledgerFiles();
    const file = path.join(root, OWNED_PROCESSES_DIRECTORY, name!);
    await fs.writeFile(file, '{"pgid":4242}');
    await expect(ledger.reconcile()).rejects.toThrow(`${file} is corrupt; verify the recorded processes are gone, then delete ${file}`);
    expect(await ledgerFiles()).toEqual([name]);
  });

  it('win32 is unchanged: adoption records nothing and the reaper signals nothing', async () => {
    const seen = attachRecorder();
    const tree = await spawnOwnedTree();
    const assigned: number[] = [];
    await adoptOwnedProcessTree({
      child: tree.child,
      label: 'fixture',
      platform: 'win32',
      jobObject: { assign: async (pid) => { assigned.push(pid); } },
    });
    expect(assigned).toEqual([tree.pgid]);
    expect(seen.adopted).toEqual([]);
    const orphan = await spawnOrphanedTree();
    expect(await reapOwnedProcessGroups([recordFor(orphan.pgid)], { platform: 'win32' })).toEqual({ ...NOTHING, ended: [] });
    expect(groupAlive(orphan.pgid)).toBe(true);
  });
});
