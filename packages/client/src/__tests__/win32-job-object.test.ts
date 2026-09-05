import { execFile, spawn as realSpawn, type ChildProcess } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptOwnedProcessTree } from '../adapters/process-tree';
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
 * verified here is the ABI payload, the one-job-per-daemon rule, the
 * fail-closed behaviour of every step, and handle hygiene.
 *
 * The last case leaves the fake behind entirely: it proves from a REAL
 * non-win32 subprocess that adopting a tree never even resolves `koffi`.
 */

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
  const bindings: JobObjectBindings = {
    createJobObjectW(attributes, name) {
      record('CreateJobObjectW', attributes, name);
      return failure?.step === 'CreateJobObjectW' ? NULL_HANDLE : JOB_HANDLE;
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
  it('creates the daemon job with the kill-on-close extended limit and assigns the process', async () => {
    const { bindings, calls } = fakeBindings();

    await assignOwnedProcessToJob(4242, { bindings });

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
  });

  it('reuses one daemon-wide job across assignments', async () => {
    const { bindings, calls } = fakeBindings();

    await assignOwnedProcessToJob(11, { bindings });
    await assignOwnedProcessToJob(22, { bindings });

    expect(names(calls).filter((name) => name === 'CreateJobObjectW')).toHaveLength(1);
    expect(names(calls).filter((name) => name === 'SetInformationJobObject')).toHaveLength(1);
    expect(names(calls).filter((name) => name === 'AssignProcessToJobObject')).toHaveLength(2);
    expect(calls.filter((call) => call.name === 'OpenProcess').map((call) => call.args[2])).toEqual([11, 22]);
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

  it('closes the process handle even when the assignment itself fails', async () => {
    const { bindings, calls } = fakeBindings({ step: 'AssignProcessToJobObject', win32Code: 5 });

    await expect(assignOwnedProcessToJob(7, { bindings })).rejects.toThrow();

    expect(names(calls)).toEqual([
      'CreateJobObjectW',
      'SetInformationJobObject',
      'OpenProcess',
      'AssignProcessToJobObject',
      'CloseHandle',
    ]);
    expect(calls.at(-1)?.args).toEqual([PROCESS_HANDLE]);
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
          return Promise.resolve();
        },
      },
    });

    expect(assigned).toBe(0);
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
