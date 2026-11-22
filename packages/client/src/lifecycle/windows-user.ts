import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { COMMAND_TIMEOUT_MS, PlatformCommandTimeoutError } from '../util/command-timeouts.js';
import { type Runner } from '../util/exec-runner.js';
import { defaultRunner, launchUnit, runBounded } from './platform-command.js';
import { createManagedLifecycle, type ManagedLifecycleFs, type ManagedServiceLifecycle } from './managed-lifecycle.js';
import { sanitizeServiceName, type ServiceDefinition, type ServiceManagerQuery, type ServiceProgram } from './service-types.js';
import { cmdQuote, generateWindowsUserLauncher, SERVICE_UNIT_MARKER, serviceLauncherPath, serviceStateDir, ServiceUnitError } from './service-unit.js';

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

/**
 * The Host's stop program's exit code; `null` when it could not run or ended
 * on a signal. One that outlives its bound has its tree terminated and
 * rejects with `PlatformCommandTimeoutError`: whether it stopped the service
 * is unknown.
 */
async function runStopProgram(program: ServiceProgram): Promise<number | null> {
  try {
    return (await runBounded(program.command, program.args, COMMAND_TIMEOUT_MS.hostStop, { cwd: program.cwd })).code;
  } catch (error) {
    if (error instanceof PlatformCommandTimeoutError) throw error;
    return null;
  }
}

/**
 * PowerShell that prints the pid of every `cmd.exe` whose command line names
 * `launcherPath`. A non-elevated query reads an empty command line for other
 * users' and elevated processes; those cannot be this user's launcher, so they
 * are skipped rather than failing the query (#2452). A WMI error still fails it.
 */
function launcherQuery(launcherPath: string): string {
  const literal = launcherPath.replaceAll("'", "''");
  return `$ErrorActionPreference = 'Stop'; $p = '${literal}'; Get-CimInstance Win32_Process -Filter 'Name=''cmd.exe''' | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($p, [StringComparison]::OrdinalIgnoreCase) -ge 0 } | ForEach-Object { $_.ProcessId }`;
}

async function queryLauncher(launcherPath: string, run: Runner) {
  const result = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', launcherQuery(launcherPath)]);
  const pids = result.stdout.split(/\s+/u).filter(Boolean);
  const determinate = result.code === 0 && result.stderr.trim() === '' && pids.every(pid => /^[1-9]\d*$/u.test(pid));
  return { running: determinate && pids.length > 0, determinate,
    detail: !determinate ? (result.stderr || result.stdout).trim() : pids.length > 0 ? `launcher running (pid ${pids.join(', ')})` : 'launcher not running',
    code: result.code };
}

const WINDOWS_SID_RE = /^S-1-\d+(?:-\d+)+$/u;
let currentWindowsSid: string | undefined;

/** Resolves the current user's SID; `undefined` when it cannot be read. @internal */
export type WindowsSidResolver = () => Promise<string | undefined> | string | undefined;

/** {@link WindowsUserDeps} plus the SID seam, kept off the public type. @internal */
export interface WindowsUserInternalDeps extends WindowsUserDeps {
  getWindowsSid?: WindowsSidResolver;
}

/**
 * The current Windows user's SID, which scopes a `windows-user` registration
 * to the user whose launchers a query can see (#2452). `undefined` off
 * Windows or when it cannot be read. A query that outlives its bound rejects
 * with `PlatformCommandTimeoutError`, so `install()` reports the timeout
 * rather than recording no SID. The process's own SID, read with the default
 * runner, is cached.
 *
 * @internal
 */
export async function resolveWindowsUserSid(
  { run = defaultRunner, platform = process.platform }: Pick<WindowsUserDeps, 'run'> & { platform?: NodeJS.Platform } = {},
): Promise<string | undefined> {
  if (platform !== 'win32') return undefined;
  const cacheable = run === defaultRunner && platform === process.platform;
  if (cacheable && currentWindowsSid !== undefined) return currentWindowsSid;
  let result;
  try {
    result = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value']);
  } catch (error) {
    if (error instanceof PlatformCommandTimeoutError) throw error;
    return undefined;
  }
  const sid = result.code === 0 ? result.stdout.trim() : '';
  if (!WINDOWS_SID_RE.test(sid)) return undefined;
  if (cacheable) currentWindowsSid = sid;
  return sid;
}

/** Check the launcher path a user-scope install registers for this store. @internal */
export async function queryWindowsUserService(launcherPath: string, { run = defaultRunner }: WindowsUserDeps = {}): Promise<ServiceManagerQuery> {
  const { running, determinate, detail } = await queryLauncher(launcherPath, run);
  return { running, determinate, detail };
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
 * - `stop()` writes the stop marker; while a launcher runs, it runs the
 *   Host's `stop` program (a non-zero exit is `service_stop_failed` and the
 *   marker stays), then waits for the launcher to exit
 *   (`service_unload_timeout`). With no launcher running it runs nothing
 *   more, so `stop()` and `uninstall()` work without the program (#2279).
 * - `status()` reports the launcher process, found by its command line.
 */
export function createWindowsUserLifecycle(def: ServiceDefinition, deps: WindowsUserInternalDeps = {}, gateRoot?: string): ManagedServiceLifecycle {
  const windows = def.windows;
  if (windows?.scope !== 'user') throw new Error("Windows user-scope lifecycle requires `ServiceDefinition.windows.scope: 'user'`");
  const hostStop = windows.stop;
  const run = deps.run ?? defaultRunner;
  const fs = deps.fs ?? fsp;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stopProgram = deps.runStopProgram ?? runStopProgram;
  const launch = deps.launchUnit ?? launchUnit;
  const getWindowsSid = deps.getWindowsSid ?? (() => resolveWindowsUserSid());

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

  async function launcherRunning(): Promise<boolean> {
    const result = await queryLauncher(launcherPath, run);
    if (!result.determinate) throw new Error(`launcher process query failed (exit ${result.code}): ${result.detail}`);
    return result.running;
  }

  async function start(): Promise<void> {
    await fs.rm(stopMarker, { force: true });
    if (await launcherRunning()) return;
    await launch(unitPath);
  }

  async function stop(): Promise<void> {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(stopMarker, '', 'utf8');
    // With the marker written no launcher starts the program again, so with
    // none running the service is stopped. The Host's stop program is not run
    // then: it may live under a `current` an earlier uninstall removed, and a
    // retried uninstall must still finish (#2279).
    if (!(await launcherRunning())) return;
    if ((await stopProgram(hostStop)) !== 0) throw new ServiceUnitError('service_stop_failed');
    const deadline = now() + WINDOWS_USER_STOP_TIMEOUT_MS;
    while (await launcherRunning()) {
      if (now() >= deadline) throw new ServiceUnitError('service_unload_timeout');
      await sleep(LAUNCHER_POLL_MS);
    }
  }

  return createManagedLifecycle(def, {
    serviceName: name,
    async registration() {
      const sid = await getWindowsSid();
      return { manager: 'windows-user', launcher: launcherPath, ...(sid === undefined ? {} : { sid }) };
    },
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
    query: () => queryWindowsUserService(launcherPath, { run }),
  }, fs, gateRoot);
}
