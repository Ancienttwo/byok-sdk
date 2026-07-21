import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { defaultRunner, runIdempotent, runOrThrow, type IdempotentAbsence, type Runner } from './exec-runner';
import { sanitizeServiceName, type ServiceDefinition, type ServiceInstallOptions, type ServiceLifecycle, type ServiceProgram, type ServiceStatusResult } from './service-types';

/**
 * Genuine-failure text that must NEVER be reclassified as "service already
 * absent/stopped", checked before `WINSW_NOT_INSTALLED`'s/
 * `WINSW_ALREADY_STOPPED`'s own `patterns` (see `exec-runner.ts`'s
 * `IdempotentAbsence.neverAbsence`) — the same defense-in-depth applied to
 * the systemd bus-connect false-positive and launchd's unreachable-domain
 * false-positive (cross-model-review P1 #7, round 2), audited here for
 * parity even though no live Windows host was available to reproduce a
 * false match directly (see `generateWinswXml`'s own doc comment on why
 * this macOS dev box cannot execute WinSW/`sc.exe` at all — the
 * `windows-service-smoke` CI job is the real verification for this
 * platform).
 */
const WINSW_CONNECTIVITY_OR_PERMISSION_FAILURE: readonly RegExp[] = [
  /access is denied/i,
  /access denied/i,
  /permission denied/i,
  /being used by another process/i,
];

/**
 * What WinSW/`sc.exe` prints or exits with when the service isn't installed
 * at all — as opposed to a genuine failure (access denied, the exe
 * locked/busy, a WinSW/SCM fault), which must be surfaced rather than
 * treated the same way (see `uninstall()` below and cross-model-review P1
 * #7). Windows's own `ERROR_SERVICE_DOES_NOT_EXIST` is exit code 1060 (see
 * this same phrase/code already asserted in `status()`'s own test).
 */
const WINSW_NOT_INSTALLED: IdempotentAbsence = {
  codes: [1060],
  patterns: [/does not exist/i, /non-existent service/i],
  neverAbsence: WINSW_CONNECTIVITY_OR_PERMISSION_FAILURE,
};

/**
 * Superset of `WINSW_NOT_INSTALLED` used by the standalone `stop()` (see
 * below): tolerates EITHER "not installed at all" OR "installed but already
 * stopped" — Windows's own `ERROR_SERVICE_NOT_ACTIVE` is exit code 1062,
 * FormatMessage text "The service has not been started." (a long-stable,
 * well-documented Win32 SCM error code, distinct from and adjacent to
 * `ERROR_SERVICE_DOES_NOT_EXIST`'s 1060) — as opposed to a genuine failure
 * (access denied, the exe locked/busy), which must still be surfaced
 * (cross-model-review P1 #7, round 2, second half).
 */
const WINSW_ALREADY_STOPPED: IdempotentAbsence = {
  codes: [1062, ...(WINSW_NOT_INSTALLED.codes ?? [])],
  patterns: [/not running/i, /has not been started/i, ...WINSW_NOT_INSTALLED.patterns],
  neverAbsence: WINSW_CONNECTIVITY_OR_PERMISSION_FAILURE,
};

/** DI seam for tests — see `exec-runner.ts`'s `Runner` doc comment. */
export interface WinswDeps {
  run?: Runner;
  fs?: Pick<typeof fsp, 'mkdir' | 'writeFile' | 'rm' | 'stat' | 'copyFile'>;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * Generates a WinSW (https://github.com/winsw/winsw) service descriptor XML
 * for `id` running `program`, logging to `logDir`. Pure/no I/O — unit-tested
 * directly for exact content shape; the REAL proof this is valid WinSW XML
 * is the `windows-service-smoke` CI job (`.github/workflows/ci.yml`), which
 * actually runs `winsw install` against generated output on a real
 * `windows-latest` runner — this macOS dev box cannot execute WinSW at all.
 *
 * Each argument becomes its own `<argument>` element (WinSW's supported
 * repeatable-element form) rather than a single space-joined `<arguments>`
 * string — this sidesteps shell-style quoting entirely for a config path
 * containing spaces, the exact same concern the pi adapter's
 * `execFile`-without-`shell` note raises for Windows (see
 * `templates/packaging/sea/README.md`'s "Windows note": WinSW itself
 * launches `<executable>` directly, no shell involved, so an unescaped
 * space in a single `<arguments>` string would be split in the wrong
 * place — one `<argument>` per token has no such ambiguity).
 *
 * `<onfailure action="restart" delay="10 sec"/>` (with a second, longer
 * backoff on repeated failure) is the crash-restart M3-4 asks for,
 * delegated entirely to WinSW/the Windows SCM — nothing in this SDK
 * supervises the process itself. `<startmode>Automatic</startmode>` mirrors
 * launchd's `RunAtLoad`/systemd's `WantedBy=default.target`: the service
 * also starts automatically on the next machine boot, not just right now.
 */
export function generateWinswXml(def: { id: string; displayName: string; program: ServiceProgram; logDir: string }): string {
  const { id, displayName, program, logDir } = def;
  const argXml = program.args.map((a) => `  <argument>${xmlEscape(a)}</argument>`).join('\n');
  const cwdXml = program.cwd ? `\n  <workingdirectory>${xmlEscape(program.cwd)}</workingdirectory>` : '';
  return `<service>
  <id>${xmlEscape(id)}</id>
  <name>${xmlEscape(displayName)}</name>
  <description>${xmlEscape(displayName)} (managed by byok-agent; see templates/service/winsw/README.md)</description>
  <executable>${xmlEscape(program.command)}</executable>
${argXml}${cwdXml}
  <logpath>${xmlEscape(logDir)}</logpath>
  <log mode="roll"></log>
  <startmode>Automatic</startmode>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
</service>
`;
}

/**
 * Windows Service lifecycle via WinSW — the standard, widely-used .NET
 * service wrapper that gives any exe/command real Windows Service Control
 * Manager (SCM) integration (crash-restart, logging, boot autostart)
 * without this SDK hand-rolling the SCM protocol in Node (which has no
 * native control-handler support in core — the reason a wrapper is needed
 * at all).
 *
 * Decision-6 boundary: the product supplies the WinSW binary
 * (`def.windows.winswBin`); this module only generates the correct config
 * and drives install/uninstall/start/stop/status around it. WinSW's own
 * convention is that its executable and XML config share a basename in the
 * same directory (`<id>.exe` + `<id>.xml`), so `install()` copies the
 * product-supplied binary into place under that name rather than invoking
 * it in place — this is the version-agnostic approach documented across
 * WinSW v2/v3, unlike relying on a specific `--config` CLI flag that may
 * differ between major versions.
 *
 * `status()` queries `sc.exe` (the real Windows SCM query tool, always
 * present) rather than parsing WinSW's own `status` subcommand text —
 * authoritative ground truth independent of WinSW's own output, and the
 * exact tool `templates/service/winsw/smoke-test.mjs` / the CI job also
 * assert against.
 */
export function createWinswLifecycle(def: ServiceDefinition, deps: WinswDeps = {}): ServiceLifecycle {
  const run = deps.run ?? defaultRunner;
  const fs = deps.fs ?? fsp;

  const windows = def.windows;
  if (!windows) {
    throw new Error('WinSW service lifecycle requires `ServiceDefinition.windows.winswBin` (the product-bundled WinSW executable path)');
  }
  // Captured as their own bindings (not read off `windows` again below) so
  // TS's narrowing of the `if (!windows) throw` above — which does not
  // survive into the nested `writeFiles` closure — doesn't matter.
  const winswBin = windows.winswBin;
  const id = sanitizeServiceName(def.name);
  const installDir = windows.installDir ?? def.logDir;
  const exePath = path.join(installDir, `${id}.exe`);
  const xmlPath = path.join(installDir, `${id}.xml`);

  async function fileExists(p: string): Promise<boolean> {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  async function writeFiles(program: ServiceProgram): Promise<void> {
    const xml = generateWinswXml({ id, displayName: def.displayName ?? def.name, program, logDir: def.logDir });
    await fs.mkdir(installDir, { recursive: true });
    await fs.mkdir(def.logDir, { recursive: true });
    await fs.copyFile(winswBin, exePath);
    await fs.writeFile(xmlPath, xml, 'utf8');
  }

  async function install(opts: ServiceInstallOptions = {}): Promise<void> {
    await writeFiles(opts.program ?? def.program);
    await runOrThrow(run, exePath, ['install'], 'winsw install');
    await runOrThrow(run, exePath, ['start'], 'winsw start');
  }

  async function uninstall(): Promise<void> {
    // Tolerant of "wasn't running/installed" (fine), but a REAL failure
    // (access denied, the exe locked/busy, a WinSW/SCM fault) at EITHER
    // step must NOT be masked: only delete the exe+xml once we know the
    // service is actually stopped and unregistered (or was never there),
    // so a still-running service never loses its control files and
    // becomes an orphan nobody can stop/uninstall (cross-model-review P1
    // #7).
    await runIdempotent(run, exePath, ['stop'], 'winsw stop', WINSW_NOT_INSTALLED);
    await runIdempotent(run, exePath, ['uninstall'], 'winsw uninstall', WINSW_NOT_INSTALLED);
    await fs.rm(exePath, { force: true });
    await fs.rm(xmlPath, { force: true });
  }

  async function start(): Promise<void> {
    if (!(await fileExists(xmlPath))) {
      throw new Error(`service "${id}" is not installed (no config at ${xmlPath}) — call install() first`);
    }
    await runOrThrow(run, exePath, ['start'], 'winsw start');
  }

  async function stop(): Promise<void> {
    // Tolerant of "already stopped/not installed" (fine — nothing to
    // stop), but a REAL failure (access denied, the exe locked/busy, an SCM
    // fault) must be surfaced rather than silently reported as "stopped"
    // (cross-model-review P1 #7, round 2, second half).
    await runIdempotent(run, exePath, ['stop'], 'winsw stop', WINSW_ALREADY_STOPPED);
  }

  async function status(): Promise<ServiceStatusResult> {
    const installed = await fileExists(xmlPath);
    const result = await run('sc.exe', ['query', id]);
    const detail = (result.stdout || result.stderr).trim();
    const running = result.code === 0 && /\bSTATE\b.*\bRUNNING\b/i.test(detail);
    return { installed, running, detail };
  }

  return { install, uninstall, start, stop, status };
}
