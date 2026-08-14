import { spawn as realSpawn, type spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { disposeOwnedProcessTree, requestOwnedProcessTreeTermination, type OwnedProcessTreeOptions } from '../adapters/process-tree';
import { isRuntimeDisposalFailure } from '../runtime-failure';

/**
 * The win32 disposal branch, exercised from POSIX CI through
 * `OwnedProcessTreeOptions`'s `platform`/`spawnFn` seams — the same
 * platform-override convention `util/secure-dir.ts` uses for its `icacls`
 * branch. Real-Windows coverage rides the existing windows-latest CI leg.
 *
 * Everything here is real: the "tree" is real spawned processes probed with
 * real `process.kill(pid, 0)`, and the taskkill stand-in is a real spawned
 * child that prints real taskkill message shapes on a real pipe. Only the
 * binary being taskkill is faked, because `taskkill` does not exist on POSIX.
 */

const spawned: ChildProcess[] = [];
/**
 * Close promises are created at spawn time, exactly like every real adapter
 * client does in its constructor. Attaching the listener later would miss a
 * `close` that already fired.
 */
const closePromises = new WeakMap<ChildProcess, Promise<void>>();

function spawnIdle(): ChildProcess {
  const child = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  spawned.push(child);
  closePromises.set(child, new Promise<void>((resolve) => child.once('close', () => resolve())));
  return child;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    if (child.pid === undefined || !processExists(child.pid)) continue;
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone between the probe and the cleanup.
    }
  }
});

/** taskkill's en-US shape; the parser reads only the integers and their co-occurrence. */
function successLine(pid: number, parentPid: number): string {
  return `SUCCESS: The process with PID ${pid} (child process of PID ${parentPid}) has been terminated.`;
}

interface TaskkillSweep {
  /** What this invocation prints, in taskkill's own child-before-parent order. */
  lines: string[];
  /** What this invocation actually terminates — deliberately independent of what it REPORTS. */
  terminates: number[];
  /** Never read by the implementation; present so the tests can prove that. */
  exitCode: number;
}

function taskkillStub(plan: (invocation: number, targetPid: number) => TaskkillSweep): {
  spawnFn: typeof spawn;
  targets: number[];
} {
  const targets: number[] = [];
  const spawnFn = ((_command: string, args: readonly string[]) => {
    const targetPid = Number(args[1]);
    targets.push(targetPid);
    const sweep = plan(targets.length, targetPid);
    const script = [
      `for (const pid of ${JSON.stringify(sweep.terminates)}) { try { process.kill(pid, 'SIGKILL'); } catch {} }`,
      `process.stdout.write(${JSON.stringify(`${sweep.lines.join('\r\n')}\r\n`)});`,
      `process.exitCode = ${sweep.exitCode};`,
    ].join('\n');
    return realSpawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  }) as unknown as typeof spawn;
  return { spawnFn, targets };
}

interface SeamOptions {
  child: ChildProcess;
  spawnFn: typeof spawn;
  killGraceMs: number;
  /** Left permanently false where the test needs the "exited, but close not yet observed" window. */
  isClosed?: () => boolean;
}

function win32Options(options: SeamOptions): OwnedProcessTreeOptions {
  const closed = closePromises.get(options.child)!;
  return {
    child: options.child,
    waitClosed: () => closed,
    isClosed: options.isClosed ?? (() => false),
    label: 'pi',
    platform: 'win32',
    spawnFn: options.spawnFn,
    killGraceMs: options.killGraceMs,
  };
}

describe('win32 measured process-tree quiescence', () => {
  it('resolves when taskkill exits non-zero for a root that is already dead — the exit status is not the receipt', async () => {
    const root = spawnIdle();
    const rootPid = root.pid!;
    // Killed out of band: taskkill will report "not found" and exit 128, which
    // is quiescence, not a failed request (the regression 44517be first fixed,
    // now held without any exit-status interpretation at all).
    process.kill(rootPid, 'SIGKILL');
    await closePromises.get(root)!;

    const { spawnFn, targets } = taskkillStub(() => ({
      lines: [`ERROR: The process "${rootPid}" not found.`],
      terminates: [],
      exitCode: 128,
    }));

    await expect(disposeOwnedProcessTree(win32Options({ child: root, spawnFn, killGraceMs: 400 }))).resolves.toBeUndefined();
    expect(targets).toEqual([rootPid]);
  });

  it('reports stage:signal only when taskkill cannot be spawned', async () => {
    const root = spawnIdle();
    const spawnFn = (() => realSpawn('byok-nonexistent-taskkill-binary', [], { stdio: ['ignore', 'pipe', 'pipe'] })) as unknown as typeof spawn;

    const failure = await disposeOwnedProcessTree(win32Options({ child: root, spawnFn, killGraceMs: 400 }))
      .then(() => undefined, (error: unknown) => error);

    expect(isRuntimeDisposalFailure(failure)).toBe(true);
    expect((failure as { stage: string }).stage).toBe('signal');
    expect(processExists(root.pid!)).toBe(true);
  });

  it('fails with stage:quiescence naming how many walked pids were still alive', async () => {
    const root = spawnIdle();
    const descendant = spawnIdle();
    const grandchild = spawnIdle();
    const { spawnFn, targets } = taskkillStub(() => ({
      // Reports the whole tree, terminates nothing: a liar taskkill must not
      // be able to buy quiescence with its own report.
      lines: [
        successLine(grandchild.pid!, descendant.pid!),
        successLine(descendant.pid!, root.pid!),
        successLine(root.pid!, process.pid),
      ],
      terminates: [],
      exitCode: 0,
    }));

    const failure = await disposeOwnedProcessTree(win32Options({ child: root, spawnFn, killGraceMs: 400 }))
      .then(() => undefined, (error: unknown) => error);

    expect(isRuntimeDisposalFailure(failure)).toBe(true);
    expect((failure as { stage: string }).stage).toBe('quiescence');
    expect((failure as Error).message).toMatch(/3 of 3 walked process ids were still alive/);
    // Re-swept at half the grace against every still-live pid.
    expect(targets.length).toBeGreaterThan(1);
  });

  it('merges pids first reported by the half-grace re-sweep into the measured set', async () => {
    const root = spawnIdle();
    const late = spawnIdle();
    const { spawnFn } = taskkillStub((invocation) => (invocation === 1
      ? { lines: [successLine(root.pid!, process.pid)], terminates: [], exitCode: 0 }
      // The re-sweep discovers `late` and kills only the root: without the
      // merge the set would drain to empty here and wrongly resolve.
      : { lines: [successLine(late.pid!, root.pid!), successLine(root.pid!, process.pid)], terminates: [root.pid!], exitCode: 0 }));

    const failure = await disposeOwnedProcessTree(win32Options({ child: root, spawnFn, killGraceMs: 400 }))
      .then(() => undefined, (error: unknown) => error);

    expect(isRuntimeDisposalFailure(failure)).toBe(true);
    expect((failure as { stage: string }).stage).toBe('quiescence');
    expect((failure as Error).message).toMatch(/1 of 2 walked process ids were still alive/);
  });

  it('does not resolve until every walked pid reports ESRCH, then still waits for close', async () => {
    const root = spawnIdle();
    const descendant = spawnIdle();
    const grandchild = spawnIdle();
    const lines = [
      successLine(grandchild.pid!, descendant.pid!),
      successLine(descendant.pid!, root.pid!),
      successLine(root.pid!, process.pid),
    ];
    const { spawnFn } = taskkillStub((invocation) => ({
      lines,
      // Only the re-sweep actually reaps, so a resolve before it would prove
      // the poll was not measuring.
      terminates: invocation === 1 ? [] : [grandchild.pid!, descendant.pid!, root.pid!],
      exitCode: 0,
    }));

    const startedAt = Date.now();
    await expect(disposeOwnedProcessTree(win32Options({ child: root, spawnFn, killGraceMs: 800 }))).resolves.toBeUndefined();

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(400);
    for (const pid of [root.pid!, descendant.pid!, grandchild.pid!]) expect(processExists(pid)).toBe(false);
  });

  it('still sweeps when the root has already closed, so its descendants stay measured', async () => {
    const root = spawnIdle();
    const descendant = spawnIdle();
    const rootPid = root.pid!;
    // The root exits on its own — the natural-exit path, where a closed-child
    // short-circuit would skip the walk entirely and resolve without ever
    // measuring the descendant Windows just orphaned.
    process.kill(rootPid, 'SIGKILL');
    await closePromises.get(root)!;

    const { spawnFn, targets } = taskkillStub(() => ({
      lines: [successLine(descendant.pid!, rootPid), successLine(rootPid, process.pid)],
      terminates: [],
      exitCode: 0,
    }));

    const failure = await disposeOwnedProcessTree(win32Options({
      child: root,
      spawnFn,
      killGraceMs: 400,
      isClosed: () => true,
    })).then(() => undefined, (error: unknown) => error);

    expect(targets.length).toBeGreaterThan(0);
    expect(isRuntimeDisposalFailure(failure)).toBe(true);
    expect((failure as { stage: string }).stage).toBe('quiescence');
    expect((failure as Error).message).toMatch(/1 of 2 walked process ids were still alive/);
    expect(processExists(descendant.pid!)).toBe(true);
  });

  it('measures the pid set an earlier interrupt recorded, without walking again', async () => {
    const root = spawnIdle();
    const descendant = spawnIdle();
    const { spawnFn, targets } = taskkillStub(() => ({
      lines: [successLine(descendant.pid!, root.pid!), successLine(root.pid!, process.pid)],
      terminates: [descendant.pid!, root.pid!],
      exitCode: 0,
    }));
    const options = win32Options({ child: root, spawnFn, killGraceMs: 400 });

    await requestOwnedProcessTreeTermination(options); // what an adapter's kill() fires
    expect(targets).toEqual([root.pid]);

    await expect(disposeOwnedProcessTree(options)).resolves.toBeUndefined();

    // Exactly one walk total: disposal measured the interrupt's recorded set.
    expect(targets).toEqual([root.pid]);
    for (const pid of [root.pid!, descendant.pid!]) expect(processExists(pid)).toBe(false);
  });

  it('merges a still-in-flight interrupt sweep with disposal own walk into one set', async () => {
    const root = spawnIdle();
    const descendant = spawnIdle();
    const { spawnFn, targets } = taskkillStub(() => ({
      lines: [successLine(descendant.pid!, root.pid!), successLine(root.pid!, process.pid)],
      terminates: [],
      exitCode: 0,
    }));
    const options = win32Options({ child: root, spawnFn, killGraceMs: 400 });

    // kill() does not await, so disposal starting before the request flips
    // `requested` legitimately issues a SECOND taskkill against the same root.
    // Both writes land in the same Set, so the measured set is their union —
    // two pids, not four.
    const interrupt = requestOwnedProcessTreeTermination(options);
    const failure = await disposeOwnedProcessTree(options).then(() => undefined, (error: unknown) => error);
    await interrupt;

    expect(targets.slice(0, 2)).toEqual([root.pid, root.pid]);
    expect(isRuntimeDisposalFailure(failure)).toBe(true);
    expect((failure as Error).message).toMatch(/2 of 2 walked process ids were still alive/);
  });

  it('never accepts this daemon pid from the root line taskkill prints', async () => {
    const root = spawnIdle();
    const { spawnFn } = taskkillStub(() => ({
      // The root's line names THIS process as its parent. Accepting it would
      // make quiescence unreachable, since this process is trivially alive.
      lines: [successLine(root.pid!, process.pid)],
      terminates: [root.pid!],
      exitCode: 0,
    }));

    await expect(disposeOwnedProcessTree(win32Options({ child: root, spawnFn, killGraceMs: 400 }))).resolves.toBeUndefined();
    expect(processExists(process.pid)).toBe(true);
  });
});
