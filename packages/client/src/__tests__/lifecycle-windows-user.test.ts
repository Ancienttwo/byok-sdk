import { describe, expect, it, vi } from 'vitest';
import { createServiceLifecycle } from '../lifecycle/create-service-lifecycle';
import { createWindowsUserLifecycle, resolveWindowsUserSid } from '../lifecycle/windows-user';
import { COMMAND_TIMEOUT_MS, PlatformCommandTimeoutError } from '../util/command-timeouts';
import { SERVICE_UNIT_MARKER, ServiceUnitError } from '../lifecycle/service-unit';
import type { ServiceDefinition } from '../lifecycle/service-types';
import type { RunResult } from '../util/exec-runner';
import { memoryServiceFs, UNMARKED_UNIT } from './support/service-fs';
import { useInProcessServiceLifecycleGate } from './support/service-lifecycle-gate';

useInProcessServiceLifecycleGate();

const STARTUP = 'C:\\Users\\Jo Smith\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup';
const UNIT = `${STARTUP}\\acme-agent.cmd`;
const LAUNCHER = 'C:\\Users\\Jo Smith\\.byok\\acme\\service\\acme-agent.launcher.cmd';
const MARKER = 'C:\\Users\\Jo Smith\\.byok\\acme\\service\\acme-agent.stopped';

function def(overrides: Partial<ServiceDefinition> = {}): ServiceDefinition {
  return {
    name: 'acme-agent',
    program: { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\acme\\current\\byok-agent.mjs', 'start', '--service'], cwd: 'C:\\acme' },
    storeDir: 'C:\\Users\\Jo Smith\\.byok\\acme',
    logDir: 'C:\\Users\\Jo Smith\\.byok\\acme\\service-logs',
    owner: 'app',
    windows: { scope: 'user', stop: { command: 'C:\\acme\\stop.exe', args: ['--now'] } },
    ...overrides,
  };
}

/** A lifecycle whose launcher query answers from `alive` (one entry per query, the last repeats). */
function harness(alive: boolean[], stopExit = 0, initial: Record<string, string> = {}) {
  const fs = memoryServiceFs(initial);
  const events: string[] = [];
  let clock = 0;
  const run = vi.fn(async (command: string): Promise<RunResult> => {
    expect(command).toBe('powershell');
    const up = alive.length > 1 ? alive.shift()! : alive[0]!;
    events.push(`query:${up}`);
    return { code: 0, stdout: up ? '4242\r\n' : '', stderr: '' };
  });
  fs.writeFile.mockImplementation(async (file: string, content: string) => { events.push(`write:${file}`); fs.files.set(file, content); });
  const lifecycle = createServiceLifecycle(def(), {
    platform: 'win32',
    deps: {
      fs,
      run,
      appData: () => 'C:\\Users\\Jo Smith\\AppData\\Roaming',
      runStopProgram: async (program) => { events.push(`stop-program:${program.command}`); return stopExit; },
      launchUnit: async (unitPath) => { events.push(`launch:${unitPath}`); },
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    },
  });
  return { fs, events, lifecycle };
}

describe('lifecycle/windows-user (#1337)', () => {
  it('installs a marked Startup .cmd that starts the batch launcher with start /min, and launches it', async () => {
    const { fs, events, lifecycle } = harness([false]);
    await lifecycle.install();

    expect(fs.files.get(UNIT)).toBe(`@REM ${SERVICE_UNIT_MARKER}\r\n@start "" /min cmd.exe /d /c ""${LAUNCHER}""\r\n`);
    expect(fs.files.get(LAUNCHER)).toBe([
      '@echo off',
      `REM ${SERVICE_UNIT_MARKER}`,
      'cd /d "C:\\acme" || exit /b 1',
      ':run',
      `if exist "${MARKER}" exit /b 0`,
      'call "C:\\Program Files\\nodejs\\node.exe" "C:\\acme\\current\\byok-agent.mjs" "start" "--service"',
      'if %ERRORLEVEL% EQU 0 exit /b 0',
      'ping -n 11 127.0.0.1 >nul',
      'goto run',
      '',
    ].join('\r\n'));
    expect(events.at(-1)).toBe(`launch:${UNIT}`);
    expect(await lifecycle.inspect()).toMatchObject({ state: 'exact', unitPath: UNIT, launcherPath: LAUNCHER });
  });

  it.each(['say "hi"', '100%', 'line\nbreak'])('refuses a program value cmd.exe cannot carry (%j) at construction', (arg) => {
    expect(() => createServiceLifecycle(def({ program: { command: 'C:\\node.exe', args: [arg] } }), {
      platform: 'win32', deps: { appData: () => 'C:\\AppData' },
    })).toThrow(/must not contain/);
  });

  it('refuses a store path the Startup line would split (& in the user name) at construction', () => {
    expect(() => createServiceLifecycle(def({ storeDir: 'C:\\Users\\R&D\\.byok\\acme' }), {
      platform: 'win32', deps: { appData: () => 'C:\\AppData' },
    })).toThrow(/must not contain/);
  });

  it('classifies a Startup .cmd without the marker as foreign and never touches it', async () => {
    const { fs, events, lifecycle } = harness([false], 0, { [UNIT]: UNMARKED_UNIT });
    expect((await lifecycle.inspect()).state).toBe('foreign');
    await expect(lifecycle.stop()).rejects.toMatchObject({ code: 'service_unit_unmarked' });
    await expect(lifecycle.uninstall()).rejects.toMatchObject({ code: 'service_unit_unmarked' });
    expect(fs.files.get(UNIT)).toBe(UNMARKED_UNIT);
    expect(events.filter((event) => !event.startsWith('query:'))).toEqual([]);
  });

  it('stops by writing the stop marker, then running the stop program while a launcher runs, then waiting for the launcher to exit', async () => {
    const { events, lifecycle } = harness([true, true, false]);
    await lifecycle.stop();
    expect(events).toEqual([`write:${MARKER}`, 'query:true', 'stop-program:C:\\acme\\stop.exe', 'query:true', 'query:false']);
  });

  it('with no launcher running, stop and uninstall write the stop marker and run no stop program: it may live under a removed current (#2279)', async () => {
    const { fs, events, lifecycle } = harness([false], 1);
    await lifecycle.stop();
    expect([events, fs.files.has(MARKER)]).toEqual([[`write:${MARKER}`, 'query:false'], true]);
    await lifecycle.install();
    await lifecycle.uninstall();
    expect([events.filter((event) => event.startsWith('stop-program')), fs.files.has(UNIT)]).toEqual([[], false]);
  });

  it('keeps the stop marker and reports service_stop_failed when the stop program exits non-zero', async () => {
    const { fs, events, lifecycle } = harness([true], 1);
    await expect(lifecycle.stop()).rejects.toEqual(new ServiceUnitError('service_stop_failed'));
    expect(fs.files.has(MARKER)).toBe(true);
    expect(events).toEqual([`write:${MARKER}`, 'query:true', 'stop-program:C:\\acme\\stop.exe']);
  });

  it('reports service_unload_timeout when the launcher outlives the stop deadline', async () => {
    const { lifecycle } = harness([true]);
    await expect(lifecycle.stop()).rejects.toEqual(new ServiceUnitError('service_unload_timeout'));
  });

  it('#2452: the launcher query skips unreadable command lines and still fails closed on a WMI error', async () => {
    const run = vi.fn(async (): Promise<RunResult> => ({ code: 1, stdout: '', stderr: 'Get-CimInstance : Access denied' }));
    const lifecycle = createServiceLifecycle(def(), { platform: 'win32', deps: { fs: memoryServiceFs(), run, appData: () => 'C:\\Users\\Jo Smith\\AppData\\Roaming' } });
    expect(await lifecycle.status()).toMatchObject({ running: false, determinate: false });
    const script = (run.mock.calls[0] as unknown as [string, string[]])[1].at(-1)!;
    expect(script).toMatch(/^\$ErrorActionPreference = 'Stop'; /u);
    expect(script).toContain('Where-Object { $_.CommandLine -and ');
    expect(script).not.toContain('throw');
  });

  it.each([
    ['records the resolved user SID', 'S-1-5-21-1004336348-1177238915-682003330-1001', { sid: 'S-1-5-21-1004336348-1177238915-682003330-1001' }],
    ['omits the SID when it cannot be resolved', undefined, {}],
  ])('#2452: install %s in the owner record', async (_name, sid, expected) => {
    const fs = memoryServiceFs();
    const lifecycle = createWindowsUserLifecycle(def(), {
      fs,
      run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
      appData: () => 'C:\\Users\\Jo Smith\\AppData\\Roaming',
      launchUnit: async () => {},
      getWindowsSid: async () => sid,
    });
    await lifecycle.install();
    const record = [...fs.files].find(([file]) => file.endsWith('lifecycle-owner.json'))![1];
    expect(JSON.parse(record).registration).toEqual({ manager: 'windows-user', launcher: LAUNCHER, ...expected });
  });

  describe('#2452: resolveWindowsUserSid', () => {
    const SID = 'S-1-5-21-1004336348-1177238915-682003330-1001';
    const answer = (result: RunResult | Error) => vi.fn(async (): Promise<RunResult> => {
      if (result instanceof Error) throw result;
      return result;
    });

    it('reads the current identity with PowerShell and returns the trimmed SID', async () => {
      const run = answer({ code: 0, stdout: `${SID}\r\n`, stderr: '' });
      expect(await resolveWindowsUserSid({ run, platform: 'win32' })).toBe(SID);
      expect(run).toHaveBeenCalledExactlyOnceWith('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value']);
    });

    it.each([
      ['malformed output', { code: 0, stdout: 'S-1-5\r\n', stderr: '' }],
      ['a non-zero exit', { code: 1, stdout: SID, stderr: 'failed' }],
      ['a failed start', new Error('spawn powershell ENOENT')],
    ])('returns undefined for %s and caches nothing', async (_name, result) => {
      expect(await resolveWindowsUserSid({ run: answer(result), platform: 'win32' })).toBeUndefined();
      const next = answer({ code: 0, stdout: SID, stderr: '' });
      expect(await resolveWindowsUserSid({ run: next, platform: 'win32' })).toBe(SID);
      expect(next).toHaveBeenCalledOnce();
    });

    it('rethrows a command timeout', async () => {
      const timeout = new PlatformCommandTimeoutError('powershell timed out', true);
      await expect(resolveWindowsUserSid({ run: answer(timeout), platform: 'win32' })).rejects.toBe(timeout);
    });

    it('returns undefined off Windows without running anything', async () => {
      const run = answer({ code: 0, stdout: SID, stderr: '' });
      expect(await resolveWindowsUserSid({ run, platform: 'linux' })).toBeUndefined();
      expect(run).not.toHaveBeenCalled();
    });
  });

  it('#2452: install reports a timed-out SID lookup as service_command_timeout and records no owner', async () => {
    const fs = memoryServiceFs();
    const timeout = new PlatformCommandTimeoutError('powershell timed out', false);
    const lifecycle = createWindowsUserLifecycle(def(), {
      fs,
      run: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
      appData: () => 'C:\\Users\\Jo Smith\\AppData\\Roaming',
      launchUnit: async () => {},
      getWindowsSid: async () => { throw timeout; },
    });
    await expect(lifecycle.install()).rejects.toMatchObject({ name: 'ServiceUnitError', code: 'service_command_timeout', exitConfirmed: false, cause: timeout });
    expect([...fs.files.keys()].some(file => file.endsWith('lifecycle-owner.json'))).toBe(false);
  });

  it('#1971: the default Host stop program runs within the hostStop bound', async () => {
    const stop = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };
    const lifecycle = createServiceLifecycle(def({ windows: { scope: 'user', stop } }), {
      platform: 'win32',
      deps: { fs: memoryServiceFs(), run: vi.fn(async () => ({ code: 0, stdout: '4242', stderr: '' })), appData: () => 'C:\\Users\\Jo Smith\\AppData\\Roaming' },
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    try {
      let settled = false;
      const stopped = lifecycle.stop().catch((error: unknown) => error).finally(() => (settled = true));
      // The bound is armed once the command has started.
      await vi.waitUntil(() => vi.getTimerCount() > 0);
      await vi.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS.hostStop - 500);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(500);
      expect(await stopped).toMatchObject({ name: 'ServiceUnitError', code: 'service_command_timeout', exitConfirmed: true, cause: expect.any(PlatformCommandTimeoutError) });
    } finally {
      vi.useRealTimers();
    }
  });
});
