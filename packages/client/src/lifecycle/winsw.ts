import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { defaultRunner, runIdempotent, runOrThrow, type IdempotentAbsence, type Runner } from './exec-runner';
import { createManagedLifecycle, type ManagedLifecycleFs, type ManagedServiceLifecycle } from './managed-lifecycle';
import { SERVICE_REDIRECT_LIMITS } from './service-log';
import { sanitizeServiceName, type ServiceDefinition, type ServiceProgram } from './service-types';
import { SERVICE_UNIT_MARKER } from './service-unit';

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

/**
 * `winsw install` on a service the SCM already has: Windows's own
 * `ERROR_SERVICE_EXISTS` is 1073. A re-install or repair keeps that
 * registration (it names only the stable `<id>.exe`) and restarts onto the
 * rewritten descriptor.
 */
const WINSW_ALREADY_INSTALLED: IdempotentAbsence = {
  codes: [1073],
  patterns: [/already exists/i, /already installed/i],
  neverAbsence: WINSW_CONNECTIVITY_OR_PERMISSION_FAILURE,
};

/**
 * Transient "the file is still mapped/held by the service process" errnos
 * an unlink can hit while racing the Windows SCM's async teardown: after
 * `winsw uninstall` returns, Windows releases the service process's image
 * section asynchronously, so deleting the service executable immediately
 * can lose that race and fail with `EPERM`/`EBUSY` — the exact
 * `windows-service-smoke` CI job flake (`EPERM: unlink
 * ...logs\byok-winsw-smoke-<pid>.exe` voiding an otherwise-passing run).
 * NOT a license to mask a real failure: errors outside this set, and
 * errors that persist past the retry budget below, are rethrown as-is, so
 * a genuinely locked exe still surfaces (same fail-closed stance as the
 * `neverAbsence` guards above).
 */
const RM_IMAGE_LOCK_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY']);

/**
 * Bounded retry budget for `rmWithImageLockRetry` below: 10 attempts with
 * a flat ~250ms wait between them (~2.3s worst case — a few seconds, far
 * longer than the teardown race needs to resolve, while keeping
 * `uninstall()`'s worst-case delay bounded). Deliberately NOT node's own
 * `fs.rm` `maxRetries`/`retryDelay` options: those are silently ignored
 * unless `recursive: true` is also passed, and the service exe/xml are
 * plain files.
 */
const RM_IMAGE_LOCK_MAX_ATTEMPTS = 10;
const RM_IMAGE_LOCK_BACKOFF_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `fs.rm(..., { force: true })` behind the bounded image-lock retry above
 * (`force: true` only suppresses ENOENT — it never retries anything). The
 * last error is rethrown unchanged once the budget is exhausted: a
 * genuinely locked exe must still fail `uninstall()` rather than be
 * reported as removed.
 */
async function rmWithImageLockRetry(fs: Pick<typeof fsp, 'rm'>, p: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await fs.rm(p, { force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (attempt >= RM_IMAGE_LOCK_MAX_ATTEMPTS || !code || !RM_IMAGE_LOCK_CODES.has(code)) {
        throw error;
      }
      await sleep(RM_IMAGE_LOCK_BACKOFF_MS);
    }
  }
}

/** DI seam for tests — see `exec-runner.ts`'s `Runner` doc comment. */
export interface WinswDeps {
  run?: Runner;
  fs?: ManagedLifecycleFs & Pick<typeof fsp, 'copyFile'>;
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
 * On Windows the SCM registration is the unit and names only the stable
 * `<id>.exe` (#1097); this descriptor, which WinSW reads at every start, is
 * the launcher. The {@link SERVICE_UNIT_MARKER} comment marks it as ours.
 *
 * Each argument becomes its own `<argument>` element (WinSW's supported
 * repeatable-element form) rather than a single space-joined `<arguments>`
 * string — this sidesteps shell-style quoting entirely for a config path
 * containing spaces (WinSW launches `<executable>` directly, no shell
 * involved).
 *
 * `<onfailure action="restart">` fires on a non-zero exit only: the
 * exit-code contract in `exit-codes.ts`. `<log mode="roll-by-size">` bounds
 * WinSW's stdout/stderr redirect the same way the daemon's start bounds the
 * launchd/systemd one (`SERVICE_REDIRECT_LIMITS`).
 * `<startmode>Automatic</startmode>` mirrors launchd's `RunAtLoad`/systemd's
 * `WantedBy=default.target`.
 */
export function generateWinswXml(def: { id: string; displayName: string; program: ServiceProgram; logDir: string }): string {
  const { id, displayName, program, logDir } = def;
  const argXml = program.args.map((a) => `  <argument>${xmlEscape(a)}</argument>`).join('\n');
  const cwdXml = program.cwd ? `\n  <workingdirectory>${xmlEscape(program.cwd)}</workingdirectory>` : '';
  return `<!-- ${SERVICE_UNIT_MARKER} -->
<service>
  <id>${xmlEscape(id)}</id>
  <name>${xmlEscape(displayName)}</name>
  <description>${xmlEscape(displayName)} (managed by @byok-sdk/client)</description>
  <executable>${xmlEscape(program.command)}</executable>
${argXml}${cwdXml}
  <logpath>${xmlEscape(logDir)}</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>${SERVICE_REDIRECT_LIMITS.maxBytes / 1024}</sizeThreshold>
    <keepFiles>${SERVICE_REDIRECT_LIMITS.maxFiles}</keepFiles>
  </log>
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
 * it in place.
 *
 * `status()` queries `sc.exe` (the real Windows SCM query tool, always
 * present) rather than parsing WinSW's own `status` subcommand text.
 */
export function createWinswLifecycle(def: ServiceDefinition, deps: WinswDeps = {}): ManagedServiceLifecycle {
  const run = deps.run ?? defaultRunner;
  const fs = deps.fs ?? fsp;

  const windows = def.windows;
  if (!windows) {
    throw new Error('WinSW service lifecycle requires `ServiceDefinition.windows.winswBin` (the product-bundled WinSW executable path)');
  }
  const winswBin = windows.winswBin;
  const id = sanitizeServiceName(def.name);
  const installDir = windows.installDir ?? def.logDir;
  const exePath = path.join(installDir, `${id}.exe`);
  const xmlPath = path.join(installDir, `${id}.xml`);

  async function fileExists(p: string): Promise<boolean> {
    try {
      await fs.readFile(p);
      return true;
    } catch {
      return false;
    }
  }

  /** The installed `<id>.exe` against `winswBin`. Only a missing `<id>.exe` is not an error. */
  async function installedWrapper(): Promise<'exact' | 'missing' | 'differs'> {
    let installed;
    try {
      installed = await fs.readFile(exePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return 'missing';
      throw error;
    }
    return Buffer.from(await fs.readFile(winswBin)).equals(Buffer.from(installed)) ? 'exact' : 'differs';
  }

  /**
   * Stops the service before a missing or differing `<id>.exe` is replaced.
   * WinSW v2 loads only the same-basename `<id>.xml`, so the installed exe is
   * the only stop path, and it runs only while the SCM reports it RUNNING.
   * Otherwise the SCM must report the service STOPPED or not installed
   * (1060); a pending, paused, unparsed or denied query fails closed before
   * anything is written.
   */
  async function stopForWrapperReplacement(wrapper: 'missing' | 'differs'): Promise<void> {
    const result = await run('sc.exe', ['query', id]);
    const detail = [result.stdout, result.stderr].map((stream) => stream.trim()).filter(Boolean).join('\n');
    const denied = WINSW_CONNECTIVITY_OR_PERMISSION_FAILURE.some((pattern) => pattern.test(detail));
    const match = result.code === 0 ? /\bSTATE\s*:\s*(\d+)\s+(\w+)/i.exec(detail) : null;
    const state = match ? `${match[1]} ${match[2]!.toUpperCase()}` : undefined;
    if (!denied && wrapper === 'differs' && state === '4 RUNNING') {
      await runIdempotent(run, exePath, ['stopwait'], 'winsw stopwait', WINSW_ALREADY_STOPPED);
      return;
    }
    if (!denied && (state === '1 STOPPED' || result.code === 1060)) return;
    const problem = wrapper === 'missing' ? 'is missing' : 'differs from winswBin';
    throw new Error(
      `winsw wrapper ${exePath} ${problem}; service "${id}" must be stopped in the Service Control Manager before repair (sc.exe query exit ${result.code}): ${detail}`,
    );
  }

  return createManagedLifecycle(def, {
    serviceName: id,
    unitPath: xmlPath,
    launcherPath: exePath,
    files: () => [{ path: xmlPath, content: generateWinswXml({ id, displayName: def.displayName ?? def.name, program: def.program, logDir: def.logDir }) }],
    async prepare() {
      // `<id>.exe` is the running service's own image. `stopwait`, unlike
      // `stop`, returns only once the SCM reports the service stopped, and
      // the image is rewritten only when its bytes differ, so a descriptor
      // repair never writes over the wrapper. A missing or differing wrapper
      // is never run unless the SCM reports it running.
      const wrapper = await installedWrapper();
      if (await fileExists(xmlPath)) {
        if (wrapper === 'exact') await runIdempotent(run, exePath, ['stopwait'], 'winsw stopwait', WINSW_ALREADY_STOPPED);
        else await stopForWrapperReplacement(wrapper);
      }
      await fs.mkdir(installDir, { recursive: true });
      if (wrapper !== 'exact') await fs.copyFile(winswBin, exePath);
    },
    async preparedArtifactsExact() {
      return (await installedWrapper()) === 'exact';
    },
    async activate() {
      await runIdempotent(run, exePath, ['install'], 'winsw install', WINSW_ALREADY_INSTALLED);
      await runOrThrow(run, exePath, ['start'], 'winsw start');
    },
    async deactivate() {
      // Tolerant of "wasn't running/installed", but a REAL failure (access
      // denied, the exe locked/busy, a WinSW/SCM fault) at EITHER step must
      // NOT be masked: the exe+xml are only deleted once the service is
      // stopped and unregistered (cross-model-review P1 #7).
      await runIdempotent(run, exePath, ['stop'], 'winsw stop', WINSW_NOT_INSTALLED);
      await runIdempotent(run, exePath, ['uninstall'], 'winsw uninstall', WINSW_NOT_INSTALLED);
    },
    async removeFiles() {
      await rmWithImageLockRetry(fs, exePath);
      await rmWithImageLockRetry(fs, xmlPath);
    },
    async start() {
      await runOrThrow(run, exePath, ['start'], 'winsw start');
    },
    async stop() {
      // Tolerant of "already stopped/not installed", but a REAL failure
      // must be surfaced rather than reported as "stopped" (P1 #7, round 2).
      await runIdempotent(run, exePath, ['stop'], 'winsw stop', WINSW_ALREADY_STOPPED);
    },
    async query() {
      const result = await run('sc.exe', ['query', id]);
      const detail = (result.stdout || result.stderr).trim();
      const running = result.code === 0 && /\bSTATE\b.*\bRUNNING\b/i.test(detail);
      // Finding P1 #2 (residual, round 3): a clean "does not exist" (1060)
      // is determinate; a query the SCM could not answer is not — see
      // `service-types.ts`'s `ServiceStatusResult.determinate`.
      const determinate = running || !WINSW_CONNECTIVITY_OR_PERMISSION_FAILURE.some((pattern) => pattern.test(detail));
      return { running, determinate, detail };
    },
  }, fs);
}
