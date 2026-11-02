import { describe, expect, it, vi } from 'vitest';
import { createServiceLifecycle } from '../lifecycle/create-service-lifecycle';
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

  it('classifies a Startup .cmd without the marker as foreign and never touches it', async () => {
    const { fs, events, lifecycle } = harness([false], 0, { [UNIT]: UNMARKED_UNIT });
    expect((await lifecycle.inspect()).state).toBe('foreign');
    await expect(lifecycle.stop()).rejects.toMatchObject({ code: 'service_unit_unmarked' });
    await expect(lifecycle.uninstall()).rejects.toMatchObject({ code: 'service_unit_unmarked' });
    expect(fs.files.get(UNIT)).toBe(UNMARKED_UNIT);
    expect(events.filter((event) => !event.startsWith('query:'))).toEqual([]);
  });

  it('stops by writing the stop marker, then running the stop program, then waiting for the launcher to exit', async () => {
    const { events, lifecycle } = harness([true, true, false]);
    await lifecycle.stop();
    expect(events).toEqual([`write:${MARKER}`, 'stop-program:C:\\acme\\stop.exe', 'query:true', 'query:true', 'query:false']);
  });

  it('keeps the stop marker and reports service_stop_failed when the stop program exits non-zero', async () => {
    const { fs, events, lifecycle } = harness([true], 1);
    await expect(lifecycle.stop()).rejects.toEqual(new ServiceUnitError('service_stop_failed'));
    expect(fs.files.has(MARKER)).toBe(true);
    expect(events.some((event) => event.startsWith('query:'))).toBe(false);
  });

  it('reports service_unload_timeout when the launcher outlives the stop deadline', async () => {
    const { lifecycle } = harness([true]);
    await expect(lifecycle.stop()).rejects.toEqual(new ServiceUnitError('service_unload_timeout'));
  });
});
