import { execFile, spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { defaultRunner, type Runner } from '../util/exec-runner';
import { resolveSystemTool } from '../util/system-tool';
import { createManagedLifecycle, type ManagedLifecycleFs, type ManagedServiceLifecycle } from './managed-lifecycle';
import { sanitizeServiceName, type ServiceDefinition, type ServiceProgram } from './service-types';
import { cmdQuote, generateWindowsUserLauncher, SERVICE_UNIT_MARKER, serviceLauncherPath, serviceStateDir, ServiceUnitError } from './service-unit';

/** DI seams for tests; the real ones start Windows processes. */
export interface WindowsUserDeps {
  /** Runs the launcher process query (PowerShell). */
  run?: Runner;
  fs?: ManagedLifecycleFs;
  /** `%APPDATA%`, the root of the user's Startup folder. Default: `process.env.APPDATA`. */
  appData?: () => string | undefined;
  /** Runs the Host's stop program and resolves its exit code. */
  runStopProgram?: (program: ServiceProgram) => Promise<number | null>;
  /** Runs the Startup unit once, detached, as Explorer does at logon. */
  launchUnit?: (unitPath: string) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** How long `stop()` waits for the launcher to exit after the stop program before `service_unload_timeout`. */
export const WINDOWS_USER_STOP_TIMEOUT_MS = 30_000;
const LAUNCHER_POLL_MS = 500;

/** The user's Startup folder under `%APPDATA%`. `GetFolderPath('Startup')` is empty before the first interactive logon, so the path is built, and created on install. */
export function windowsStartupDir(appData: string): string {
  return path.win32.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

/**
 * The Startup `.cmd` (#1337): Explorer runs it at logon. Its first line
 * carries {@link SERVICE_UNIT_MARKER}. `start "" /min` keeps every inner
 * quote, so a launcher path with spaces stays one word (`conhost
 * --headless` drops them).
 */
export function generateWindowsStartupUnit(launcherPath: string): string {
  // The outer `cmd /c "..."` leaves the path unquoted while the Startup line is
  // parsed, so these split it; a Windows user name may contain `&` and `^`.
  if (/[&^|<>]/u.test(launcherPath)) {
    throw new Error(`Windows launcher path must not contain &, ^, |, < or > (got ${JSON.stringify(launcherPath)})`);
  }
  return `@REM ${SERVICE_UNIT_MARKER}\r\n@start "" /min cmd.exe /d /c "${cmdQuote(launcherPath)}"\r\n`;
}

function runStopProgram(program: ServiceProgram): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(program.command, program.args, { cwd: program.cwd, windowsHide: true }, (error) => {
      resolve(error === null ? 0 : typeof error.code === 'number' ? error.code : null);
    });
  });
}

/** Runs the unit the way Explorer does; the launcher it starts outlives this process. */
function launchUnit(unitPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // cmd /c strips the outer pair of quotes, leaving the quoted path.
    const child = spawn(resolveSystemTool('cmd'), ['/d', '/c', `"${cmdQuote(unitPath)}"`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Startup unit ${unitPath} exited ${code}`));
    });
  });
}

/** PowerShell that prints the pid of every `cmd.exe` whose command line names `launcherPath`. */
function launcherQuery(launcherPath: string): string {
  const literal = launcherPath.replaceAll("'", "''");
  return `$p = '${literal}'; Get-CimInstance Win32_Process -Filter 'Name=''cmd.exe''' | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($p, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { $_.ProcessId }`;
}

/**
 * Windows logon autostart without the SCM or an administrator (#1337,
 * probe: `docs/researches/2026-11-02-windows-user-autostart-probe.md`).
 * The unit is `<name>.cmd` in the user's Startup folder; it starts the batch
 * launcher, which reruns the program after a non-zero exit until
 * `<storeDir>\service\<name>.stopped` exists.
 *
 * - `start()` removes the stop marker and runs the unit, unless a launcher
 *   is already running.
 * - `stop()` writes the stop marker, runs the Host's `stop` program (a
 *   non-zero exit is `service_stop_failed` and the marker stays), then
 *   waits for the launcher to exit (`service_unload_timeout`).
 * - `status()` reports the launcher process, found by its command line.
 */
export function createWindowsUserLifecycle(def: ServiceDefinition, deps: WindowsUserDeps = {}): ManagedServiceLifecycle {
  const windows = def.windows;
  if (windows?.scope !== 'user') throw new Error("Windows user-scope lifecycle requires `ServiceDefinition.windows.scope: 'user'`");
  const hostStop = windows.stop;
  const run = deps.run ?? defaultRunner;
  const fs = deps.fs ?? fsp;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stopProgram = deps.runStopProgram ?? runStopProgram;
  const launch = deps.launchUnit ?? launchUnit;

  const appData = (deps.appData ?? (() => process.env.APPDATA))();
  if (appData === undefined || !path.win32.isAbsolute(appData)) {
    throw new Error('Windows user-scope lifecycle requires %APPDATA% to be an absolute path (the Startup folder lives under it)');
  }
  const name = sanitizeServiceName(def.name);
  const unitPath = path.win32.join(windowsStartupDir(appData), `${name}.cmd`);
  const launcherPath = serviceLauncherPath(def.storeDir, name, 'win32');
  const stateDir = serviceStateDir(def.storeDir, 'win32');
  const stopMarker = path.win32.join(stateDir, `${name}.stopped`);
  // Generated now, so a value `cmd.exe` cannot carry fails at construction.
  const unit = generateWindowsStartupUnit(launcherPath);
  const launcher = generateWindowsUserLauncher(def.program, stopMarker);

  async function launcherQueryResult() {
    const result = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', launcherQuery(launcherPath)]);
    const pids = result.code === 0 ? result.stdout.split(/\s+/u).filter(Boolean) : [];
    return { ...result, pids };
  }

  async function launcherRunning(): Promise<boolean> {
    const result = await launcherQueryResult();
    if (result.code !== 0) throw new Error(`launcher process query failed (exit ${result.code}): ${(result.stderr || result.stdout).trim()}`);
    return result.pids.length > 0;
  }

  async function start(): Promise<void> {
    await fs.rm(stopMarker, { force: true });
    if (await launcherRunning()) return;
    await launch(unitPath);
  }

  async function stop(): Promise<void> {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(stopMarker, '', 'utf8');
    if ((await stopProgram(hostStop)) !== 0) throw new ServiceUnitError('service_stop_failed');
    const deadline = now() + WINDOWS_USER_STOP_TIMEOUT_MS;
    while (await launcherRunning()) {
      if (now() >= deadline) throw new ServiceUnitError('service_unload_timeout');
      await sleep(LAUNCHER_POLL_MS);
    }
  }

  return createManagedLifecycle(def, {
    serviceName: name,
    unitPath,
    launcherPath,
    files: () => [
      { path: unitPath, content: unit },
      { path: launcherPath, content: launcher },
    ],
    async prepare() {
      // cmd.exe reads a running batch file by offset, so it is never rewritten under a live launcher.
      if (await launcherRunning()) await stop();
    },
    activate: start,
    deactivate: stop,
    async removeFiles() {
      await fs.rm(unitPath, { force: true });
      await fs.rm(launcherPath, { force: true });
      await fs.rm(stopMarker, { force: true });
    },
    start,
    stop,
    async query() {
      const result = await launcherQueryResult();
      if (result.code !== 0) return { running: false, determinate: false, detail: (result.stderr || result.stdout).trim() };
      const running = result.pids.length > 0;
      return { running, determinate: true, detail: running ? `launcher running (pid ${result.pids.join(', ')})` : 'launcher not running' };
    },
  }, fs);
}
