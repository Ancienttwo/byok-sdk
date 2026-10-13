import { execFile, spawn as realSpawn, type ChildProcess, type spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptOwnedProcessTree, disposeOwnedProcessTree } from '../adapters/process-tree';
import {
  assignOwnedProcessToJob,
  isWin32JobObjectFailure,
  type JobObjectBindings,
  type Win32Handle,
} from '../adapters/win32-job-object';

/**
 * The win32 kill-on-close Job Object branch, exercised from POSIX through the
 * `bindings` seam — the same platform-override convention
 * `win32-process-tree-quiescence.test.ts` and `util/secure-dir.ts` use.
 * Real-Windows coverage rides the existing windows-latest CI leg; what is
 * verified here is the ABI payload, the one-job-per-tree rule and its release
 * only after disposal proves the tree gone, the fail-closed behaviour of every
 * step, and handle hygiene.
 *
 * The last case leaves the fake behind entirely: it proves from a REAL
 * non-win32 subprocess that adopting a tree never even resolves `koffi`.
 */

/** The first job a fake table creates; every later one gets the next address. */
const JOB_HANDLE: Win32Handle = 0x1000n;
const PROCESS_HANDLE: Win32Handle = 0x2000n;
const NULL_HANDLE: Win32Handle = 0n;

type Step = 'CreateJobObjectW' | 'SetInformationJobObject' | 'OpenProcess' | 'AssignProcessToJobObject';

interface RecordedCall {
  name: string;
  args: readonly unknown[];
}

function fakeBindings(failure?: { step: Step; win32Code: number }): {
  bindings: JobObjectBindings;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const record = (name: string, ...args: unknown[]): void => {
    calls.push({ name, args });
  };
  let jobs = 0;
  const bindings: JobObjectBindings = {
    createJobObjectW(attributes, name) {
      record('CreateJobObjectW', attributes, name);
      if (failure?.step === 'CreateJobObjectW') return NULL_HANDLE;
      jobs += 1;
      return (JOB_HANDLE as bigint) + BigInt(jobs - 1);
    },
    setInformationJobObject(job, infoClass, info, infoLength) {
      record('SetInformationJobObject', job, infoClass, Buffer.from(info), infoLength);
      return failure?.step === 'SetInformationJobObject' ? 0 : 1;
    },
    openProcess(desiredAccess, inheritHandle, pid) {
      record('OpenProcess', desiredAccess, inheritHandle, pid);
      return failure?.step === 'OpenProcess' ? NULL_HANDLE : PROCESS_HANDLE;
    },
    assignProcessToJobObject(job, processHandle) {
      record('AssignProcessToJobObject', job, processHandle);
      return failure?.step === 'AssignProcessToJobObject' ? 0 : 1;
    },
    closeHandle(handle) {
      record('CloseHandle', handle);
      return 1;
    },
    getLastError() {
      record('GetLastError');
      return failure?.win32Code ?? 0;
    },
  };
  return { bindings, calls };
}

function names(calls: RecordedCall[]): string[] {
  return calls.filter((call) => call.name !== 'GetLastError').map((call) => call.name);
}

const spawned: ChildProcess[] = [];

function spawnIdle(): ChildProcess {
  const child = realSpawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  spawned.push(child);
  return child;
}

afterEach(() => {
  for (const child of spawned.splice(0)) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
});

describe('win32 kill-on-close job object', () => {
  it('creates the tree job with the kill-on-close extended limit and assigns the process', async () => {
    const { bindings, calls } = fakeBindings();

    const treeJob = await assignOwnedProcessToJob(4242, { bindings });

    expect(names(calls)).toEqual([
      'CreateJobObjectW',
      'SetInformationJobObject',
      'OpenProcess',
      'AssignProcessToJobObject',
      'CloseHandle',
    ]);

    // CreateJobObjectW(NULL, NULL): unnamed, default security.
    expect(calls[0]?.args).toEqual([null, null]);

    const [job, infoClass, info, infoLength] = calls[1]?.args as [Win32Handle, number, Buffer, number];
    expect(job).toBe(JOB_HANDLE);
    expect(infoClass).toBe(9); // JobObjectExtendedLimitInformation
    expect(info.length).toBe(144); // sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION), x64
    expect(infoLength).toBe(144);
    expect(info.readUInt32LE(16)).toBe(0x00002000); // LimitFlags @16 = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    // Nothing else in the structure may be set: any other limit would be an
    // unrequested constraint on every runtime the daemon ever spawns.
    const withoutFlags = Buffer.from(info);
    withoutFlags.writeUInt32LE(0, 16);
    expect(withoutFlags.equals(Buffer.alloc(144))).toBe(true);

    // PROCESS_SET_QUOTA (0x0100) | PROCESS_TERMINATE (0x0001), no handle inheritance.
    expect(calls[2]?.args).toEqual([0x0101, 0, 4242]);
    expect(calls[3]?.args).toEqual([JOB_HANDLE, PROCESS_HANDLE]);
    // The process handle is released; the JOB holds the process afterwards.
    expect(calls[4]?.args).toEqual([PROCESS_HANDLE]);

    // The job handle stays open until the owner releases it, then closes once.
    treeJob.release();
    treeJob.release();
    expect(calls.slice(5)).toEqual([{ name: 'CloseHandle', args: [JOB_HANDLE] }]);
  });

  it('creates a fresh job per tree, and releasing one tree closes only its own job', async () => {
    const { bindings, calls } = fakeBindings();

    const first = await assignOwnedProcessToJob(11, { bindings });
    const second = await assignOwnedProcessToJob(22, { bindings });

    expect(names(calls).filter((name) => name === 'CreateJobObjectW')).toHaveLength(2);
    expect(names(calls).filter((name) => name === 'SetInformationJobObject')).toHaveLength(2);
    expect(calls.filter((call) => call.name === 'AssignProcessToJobObject').map((call) => call.args)).toEqual([
      [0x1000n, PROCESS_HANDLE],
      [0x1001n, PROCESS_HANDLE],
    ]);
    expect(calls.filter((call) => call.name === 'OpenProcess').map((call) => call.args[2])).toEqual([11, 22]);

    const before = calls.length;
    first.release();
    expect(calls.slice(before)).toEqual([{ name: 'CloseHandle', args: [0x1000n] }]);
    second.release();
    expect(calls.slice(before)).toEqual([
      { name: 'CloseHandle', args: [0x1000n] },
      { name: 'CloseHandle', args: [0x1001n] },
    ]);
  });

  it.each([
    { step: 'CreateJobObjectW' as const, win32Code: 5 },
    { step: 'SetInformationJobObject' as const, win32Code: 87 },
    { step: 'OpenProcess' as const, win32Code: 87 },
    { step: 'AssignProcessToJobObject' as const, win32Code: 5 },
  ])('fails closed at $step carrying the Win32 error code', async ({ step, win32Code }) => {
    const { bindings } = fakeBindings({ step, win32Code });

    const error = await assignOwnedProcessToJob(7, { bindings }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(isWin32JobObjectFailure(error)).toBe(true);
    expect(error).toMatchObject({ name: 'Win32JobObjectFailure', step, win32Code });
  });

  it('closes the empty job and the process handle when the assignment itself fails', async () => {
    const { bindings, calls } = fakeBindings({ step: 'AssignProcessToJobObject', win32Code: 5 });

    await expect(assignOwnedProcessToJob(7, { bindings })).rejects.toThrow();

    expect(names(calls)).toEqual([
      'CreateJobObjectW',
      'SetInformationJobObject',
      'OpenProcess',
      'AssignProcessToJobObject',
      'CloseHandle',
      'CloseHandle',
    ]);
    // The job holds no process, so closing it ends nothing.
    expect(calls.at(-2)?.args).toEqual([JOB_HANDLE]);
    expect(calls.at(-1)?.args).toEqual([PROCESS_HANDLE]);
  });

  it('closes the empty job when the process cannot be opened', async () => {
    const { bindings, calls } = fakeBindings({ step: 'OpenProcess', win32Code: 87 });

    await expect(assignOwnedProcessToJob(7, { bindings })).rejects.toThrow();

    expect(names(calls)).toEqual(['CreateJobObjectW', 'SetInformationJobObject', 'OpenProcess', 'CloseHandle']);
    expect(calls.at(-1)?.args).toEqual([JOB_HANDLE]);
  });

  it('closes and never caches a job whose kill-on-close limit could not be set', async () => {
    const { bindings, calls } = fakeBindings({ step: 'SetInformationJobObject', win32Code: 87 });

    await expect(assignOwnedProcessToJob(7, { bindings })).rejects.toThrow();
    expect(calls.at(-1)).toEqual({ name: 'CloseHandle', args: [JOB_HANDLE] });

    // A cached unlimited job would be a silent downgrade to no backstop at all,
    // so the next attempt must start over rather than reuse it.
    await expect(assignOwnedProcessToJob(8, { bindings })).rejects.toThrow();
    expect(names(calls).filter((name) => name === 'CreateJobObjectW')).toHaveLength(2);
  });
});

describe('adoption routes to the job object on win32 only', () => {
  it('propagates an assignment failure so the caller can refuse to publish', async () => {
    const child = spawnIdle();
    const failure = new Error('assignment denied');

    await expect(adoptOwnedProcessTree({
      child,
      label: 'probe',
      platform: 'win32',
      jobObject: { assign: () => Promise.reject(failure) },
    })).rejects.toBe(failure);
  });

  it('never reaches the job object off win32', async () => {
    const child = spawnIdle();
    let assigned = 0;

    await adoptOwnedProcessTree({
      child,
      label: 'probe',
      platform: 'linux',
      jobObject: {
        assign: () => {
          assigned += 1;
          return Promise.resolve({ release() {} });
        },
      },
    });

    expect(assigned).toBe(0);
  });
});

/**
 * The kernel rule behind #385's Windows flake, modelled through the bindings
 * seam. An EMPTY job becomes, at its first assignment, a nested child of the
 * job its first process is in at that moment; a job whose parent chain holds a
 * closed job refuses every later assignment with ERROR_INVALID_PARAMETER (87);
 * a process already in a job can join another only inside its own chain (else
 * ERROR_ACCESS_DENIED, 5). A Node or Bun runtime root puts itself into a
 * kill-on-close job of its own at its first spawn (libuv's global job), which
 * this model calls the root's private job. All three rules were measured on
 * windows-latest under both CI tokens before being written down here.
 */
function nestingKernel() {
  interface Job { parent: string | undefined; nested: boolean; closed: boolean }
  const jobs = new Map<string, Job>([['daemon-libuv', { parent: undefined, nested: true, closed: false }]]);
  const immediate = new Map<number, string>();
  let lastError = 0;
  let created = 0;
  const chain = (id: string | undefined): string[] => {
    const ids: string[] = [];
    for (let at = id; at !== undefined; at = jobs.get(at)!.parent) ids.push(at);
    return ids;
  };
  const bindings: JobObjectBindings = {
    createJobObjectW() {
      created += 1;
      const id = `tree-${created}`;
      jobs.set(id, { parent: undefined, nested: false, closed: false });
      return id;
    },
    setInformationJobObject: () => 1,
    openProcess: (_access, _inherit, pid) => pid,
    assignProcessToJobObject(job, processHandle) {
      const target = jobs.get(job as string)!;
      const pid = processHandle as number;
      const current = immediate.get(pid)!;
      if (!target.nested) {
        target.parent = current;
        target.nested = true;
      } else if (chain(job as string).some((id) => jobs.get(id)!.closed)) {
        lastError = 87;
        return 0;
      } else if (!chain(job as string).includes(current)) {
        lastError = 5;
        return 0;
      }
      immediate.set(pid, job as string);
      return 1;
    },
    closeHandle(handle) {
      const job = jobs.get(handle as string);
      if (job) job.closed = true;
      return 1;
    },
    getLastError: () => lastError,
  };
  return {
    bindings,
    /** A root the daemon just spawned: libuv put it in the daemon's own job. */
    spawn(pid: number) {
      immediate.set(pid, 'daemon-libuv');
    },
    /** The root reached its first spawn: it is now in a private job of its own. */
    rootSpawnsItsFirstChild(pid: number) {
      const id = `private-${pid}`;
      jobs.set(id, { parent: immediate.get(pid), nested: true, closed: false });
      immediate.set(pid, id);
    },
    /** The root exited: its private job's only handle closed with it. */
    rootExits(pid: number) {
      jobs.get(`private-${pid}`)!.closed = true;
    },
    isOpen: (job: string) => !jobs.get(job)!.closed,
  };
}

describe('per-tree jobs survive a first root that nested its job under a private one (#385 Windows flake)', () => {
  it('control: a shared job nested under an exited root\'s private job refuses every later root with 87', () => {
    const kernel = nestingKernel();
    const shared = kernel.bindings.createJobObjectW(null, null);
    kernel.spawn(101);
    kernel.rootSpawnsItsFirstChild(101);
    expect(kernel.bindings.assignProcessToJobObject(shared, 101)).toBe(1);
    kernel.rootExits(101);

    kernel.spawn(102);
    expect(kernel.bindings.assignProcessToJobObject(shared, 102)).toBe(0);
    expect(kernel.bindings.getLastError()).toBe(87);
  });

  it('a late first assignment no longer poisons later adoptions', async () => {
    const kernel = nestingKernel();
    // The first adoption lands only after the root already joined its private
    // job — the cold `koffi` load measured 44.6 ms on windows-latest.
    kernel.spawn(101);
    kernel.rootSpawnsItsFirstChild(101);
    const first = await assignOwnedProcessToJob(101, { bindings: kernel.bindings });
    kernel.rootExits(101);
    first.release();

    for (const pid of [102, 103, 104]) {
      kernel.spawn(pid);
      const job = await assignOwnedProcessToJob(pid, { bindings: kernel.bindings });
      job.release();
    }

    // And a live root assigned late — already in its private job — is still taken.
    kernel.spawn(105);
    kernel.rootSpawnsItsFirstChild(105);
    await expect(assignOwnedProcessToJob(105, { bindings: kernel.bindings })).resolves.toBeDefined();
  });

  it('releasing one tree leaves another tree\'s job open and assignable', async () => {
    const kernel = nestingKernel();
    kernel.spawn(201);
    kernel.spawn(202);
    const a = await assignOwnedProcessToJob(201, { bindings: kernel.bindings });
    await assignOwnedProcessToJob(202, { bindings: kernel.bindings });

    a.release();

    expect(kernel.isOpen('tree-1')).toBe(false);
    expect(kernel.isOpen('tree-2')).toBe(true);
    // The surviving tree's job still accepts its own descendants' chain.
    expect(kernel.bindings.assignProcessToJobObject('tree-2', 202)).toBe(1);
  });
});

/** taskkill stand-in: a real child that kills `terminates` and prints taskkill's success line for the root. */
function taskkillStub(terminates: (rootPid: number) => number[]): typeof spawn {
  return ((_command: string, args: readonly string[]) => {
    const rootPid = Number(args[1]);
    const script = [
      `for (const pid of ${JSON.stringify(terminates(rootPid))}) { try { process.kill(pid, 'SIGKILL'); } catch {} }`,
      `process.stdout.write(${JSON.stringify(`SUCCESS: The process with PID ${rootPid} (child process of PID ${process.pid}) has been terminated.\r\n`)});`,
    ].join('\n');
    return realSpawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  }) as unknown as typeof spawn;
}

describe('the tree job is released only once disposal proves the tree gone', () => {
  function adoptedRoot(): { child: ChildProcess; closed: Promise<void>; releases: () => number; assign: { assign(pid: number): Promise<{ release(): void }> }; settle: () => void } {
    const child = spawnIdle();
    const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
    let released = 0;
    let settle!: () => void;
    const assigned = new Promise<void>((resolve) => { settle = resolve; });
    return {
      child, closed, settle,
      releases: () => released,
      assign: { assign: async () => { await assigned; return { release: () => { released += 1; } }; } },
    };
  }

  function win32Dispose(child: ChildProcess, closed: Promise<void>, spawnFn: typeof spawn, killGraceMs = 2_000) {
    return disposeOwnedProcessTree({ child, waitClosed: () => closed, isClosed: () => false, label: 'probe', platform: 'win32', spawnFn, killGraceMs });
  }

  it('releases the job after the measured quiescence and close, and only once', async () => {
    const root = adoptedRoot();
    root.settle();
    await adoptOwnedProcessTree({ child: root.child, label: 'probe', platform: 'win32', jobObject: root.assign });
    expect(root.releases()).toBe(0);

    await win32Dispose(root.child, root.closed, taskkillStub((pid) => [pid]));
    expect(root.releases()).toBe(1);

    await win32Dispose(root.child, root.closed, taskkillStub((pid) => [pid]));
    expect(root.releases()).toBe(1);
  });

  it('keeps the job open when disposal cannot prove the tree gone', async () => {
    const root = adoptedRoot();
    root.settle();
    await adoptOwnedProcessTree({ child: root.child, label: 'probe', platform: 'win32', jobObject: root.assign });

    // taskkill reports the root but terminates nothing: quiescence is never reached.
    await expect(win32Dispose(root.child, root.closed, taskkillStub(() => []), 200)).rejects.toThrow(/did not quiesce/);
    expect(root.releases()).toBe(0);
  });

  it('releases a job whose assignment settled after disposal had already proved the tree gone', async () => {
    const root = adoptedRoot();
    const adoption = adoptOwnedProcessTree({ child: root.child, label: 'probe', platform: 'win32', jobObject: root.assign });

    await win32Dispose(root.child, root.closed, taskkillStub((pid) => [pid]));
    expect(root.releases()).toBe(0);

    root.settle();
    await adoption;
    expect(root.releases()).toBe(1);
  });
});

/**
 * The isolation claim is "POSIX never loads koffi", and only a real process can
 * witness it: vitest's module graph is already resolved, and the module is
 * reached through a dynamic import a registry snapshot in the wrong worker
 * would miss. The subprocess records every import specifier it resolves.
 */
describe('koffi stays unreachable off win32', () => {
  const HOOK = fileURLToPath(new URL('./fixtures/ts-source-resolve-hook.mjs', import.meta.url));
  const HELPER = fileURLToPath(new URL('./fixtures/koffi-isolation-helper.mjs', import.meta.url));
  const execFileAsync = promisify(execFile);

  async function resolvedSpecifiers(platform: string, useDefaultJobObject: '0' | '1'): Promise<{
    stdout: string;
    specifiers: string[];
  }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-koffi-isolation-'));
    const log = path.join(dir, 'resolve.log');
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--import', HOOK, HELPER, platform, useDefaultJobObject],
        { env: { ...process.env, BYOK_RESOLVE_LOG: log } },
      );
      const recorded = await fs.readFile(log, 'utf8');
      return { stdout, specifiers: recorded.split('\n').filter((line) => line.length > 0) };
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  it('resolves neither the job-object module nor koffi when adopting on linux', async () => {
    const { stdout, specifiers } = await resolvedSpecifiers('linux', '0');

    expect(stdout.trim()).toBe('adopted');
    expect(specifiers).toContain('../../adapters/process-tree.ts');
    expect(specifiers.filter((specifier) => specifier === 'koffi')).toEqual([]);
    expect(specifiers.filter((specifier) => /win32-job-object/.test(specifier))).toEqual([]);
  });

  it('control: the same recorder does see them when the win32 branch is taken', async () => {
    const { specifiers } = await resolvedSpecifiers('win32', '1');

    expect(specifiers).toContain('./win32-job-object');
    expect(specifiers).toContain('koffi');
  });
});
