import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRunner, runIdempotent, runOrThrow, type IdempotentAbsence, type Runner } from './exec-runner';
import { createManagedLifecycle, type ManagedLifecycleFs } from './managed-lifecycle';
import { SERVICE_REDIRECT_STDERR_FILENAME, SERVICE_REDIRECT_STDOUT_FILENAME } from './service-log';
import { sanitizeServiceName, type ServiceDefinition, type ServiceLifecycle } from './service-types';
import { generateServiceLauncher, SERVICE_UNIT_MARKER, serviceLauncherPath } from './service-unit';

/**
 * Genuine-failure text that must NEVER be reclassified as "job already
 * absent", checked before `LAUNCHD_NOT_LOADED`'s own `patterns` (see
 * `exec-runner.ts`'s `IdempotentAbsence.neverAbsence`). Both verified
 * directly against real `launchctl` output on macOS (Darwin 25.5.0):
 * `launchctl bootout system/<id>` as a non-root user → `Boot-out failed: 1:
 * Operation not permitted` (a real permission failure); `launchctl bootout
 * gui/1/<id>` (uid 1 has no active GUI session — the same "headless box"
 * shape as systemd's missing `--user` D-Bus session) → `Could not find
 * domain for user gui: 1`, exit 112 — launchd cannot even ask whether the
 * job is loaded, which is a REAL failure to surface, not evidence it's
 * absent (cross-model-review P1 #7, round 2 — the same re-orphan shape as
 * the systemd bus failure, for launchd).
 */
const LAUNCHD_CONNECTIVITY_OR_PERMISSION_FAILURE: readonly RegExp[] = [
  /operation not permitted/i,
  /could not find domain/i,
  /permission denied/i,
  /access denied/i,
];

/**
 * What `launchctl bootout`/`launchctl stop` prints/exits with when there was
 * nothing loaded to boot out — as opposed to a genuine failure (permission
 * denied, an unreachable GUI domain, launchd itself misbehaving), which must
 * be surfaced rather than treated the same way (see `uninstall()`/`stop()`
 * below and cross-model-review P1 #7). `/no such process/i` is verified
 * directly against real `launchctl bootout` output for a job that was never
 * loaded (`Boot-out failed: 3: No such process`, exit 3).
 *
 * Deliberately does NOT include a bare "domain...not found/does not exist"
 * pattern (present in an earlier version of this fix): it never matched any
 * verified real "not loaded" output, and an unreachable/nonexistent GUI
 * domain is exactly the genuine-failure shape `LAUNCHD_CONNECTIVITY_OR_PERMISSION_FAILURE`
 * above exists to catch, not evidence of absence.
 */
const LAUNCHD_NOT_LOADED: IdempotentAbsence = {
  patterns: [/no such process/i, /could not find (specified )?service/i, /not loaded/i],
  neverAbsence: LAUNCHD_CONNECTIVITY_OR_PERMISSION_FAILURE,
};

/** DI seam for tests — see `exec-runner.ts`'s `Runner` doc comment for why a mocked `run` is enough to unit-test all of this file's install/uninstall/start/stop/status logic on any host OS. */
export interface LaunchdDeps {
  run?: Runner;
  fs?: ManagedLifecycleFs;
  homedir?: () => string;
  /** Defaults to `process.getuid` — macOS/Linux only; this module is never constructed on `win32` (see `create-service-lifecycle.ts`). */
  getuid?: () => number;
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function plistString(value: string): string {
  return `<string>${escapeXml(value)}</string>`;
}

/**
 * Generates a launchd LaunchAgent plist for `label` that runs only the
 * stable `launcherPath` (#1097), logging to `logDir`. Pure/no I/O.
 *
 * - The {@link SERVICE_UNIT_MARKER} comment marks the plist as ours; see `service-unit.ts`.
 * - `RunAtLoad`: true — starts immediately on `launchctl bootstrap`.
 * - `KeepAlive.SuccessfulExit: false` — restart after any exit but 0, the
 *   exit-code contract in `exit-codes.ts`. Nothing in this SDK supervises
 *   the process itself.
 * - `ThrottleInterval: 10` — matches systemd `RestartSec=10` and WinSW's
 *   first `onfailure` delay.
 * - `StandardOutPath`/`StandardErrorPath` receive only early-boot crash
 *   output; the daemon writes its own rotated log (`service-log.ts`).
 */
export function generateLaunchdPlist(def: { label: string; launcherPath: string; workingDirectory: string; logDir: string }): string {
  const { label, launcherPath, workingDirectory, logDir } = def;
  const outLog = path.join(logDir, SERVICE_REDIRECT_STDOUT_FILENAME);
  const errLog = path.join(logDir, SERVICE_REDIRECT_STDERR_FILENAME);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${SERVICE_UNIT_MARKER} -->
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${plistString(label)}
  <key>ProgramArguments</key>
  <array>
    ${plistString(launcherPath)}
  </array>
  <key>WorkingDirectory</key>
  ${plistString(workingDirectory)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  ${plistString(outLog)}
  <key>StandardErrorPath</key>
  ${plistString(errLog)}
</dict>
</plist>
`;
}

/**
 * macOS LaunchAgent lifecycle, built on the modern `launchctl` subcommand
 * interface (`bootstrap`/`bootout`/`enable`/`kickstart`/`print`, targeting
 * `gui/<uid>` — the per-user GUI domain LaunchAgents run in — rather than
 * the legacy `load`/`unload`/`start`/`stop`).
 *
 * `start`/`stop` mapping (a real nuance worth documenting, not an arbitrary
 * choice): `KeepAlive` means a plain signal-kill (`launchctl kill`) would
 * just have launchd immediately restart the job — that's the crash-restart
 * feature working exactly as designed, but it means "kill" can't implement
 * a genuine "stop" on its own. `bootout` (fully unloading the job from the
 * domain) is the only primitive that stops it without KeepAlive fighting
 * back, so `stop()` = `bootout` and `start()` = `bootstrap` again (reload
 * from the still-on-disk plist) — not `kickstart`, which only force-restarts
 * an ALREADY-loaded job.
 */
export function createLaunchdLifecycle(def: ServiceDefinition, deps: LaunchdDeps = {}): ServiceLifecycle {
  const run = deps.run ?? defaultRunner;
  const fs = deps.fs ?? fsp;
  const homedir = deps.homedir ?? (() => os.homedir());
  const getuid =
    deps.getuid ??
    (() => {
      if (typeof process.getuid !== 'function') {
        throw new Error('launchd lifecycle requires a POSIX uid (process.getuid unavailable) — this module only runs on macOS');
      }
      return process.getuid();
    });

  const label = sanitizeServiceName(def.name);
  const plistPath = path.join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const launcherPath = serviceLauncherPath(def.storeDir, label, 'darwin');
  const domainTarget = () => `gui/${getuid()}`;
  const serviceTarget = () => `${domainTarget()}/${label}`;

  return createManagedLifecycle(def, {
    serviceName: label,
    unitPath: plistPath,
    launcherPath,
    files: () => [
      { path: plistPath, content: generateLaunchdPlist({ label, launcherPath, workingDirectory: homedir(), logDir: def.logDir }) },
      { path: launcherPath, content: generateServiceLauncher(def.program), mode: 0o755 },
    ],
    async activate() {
      // Best-effort: clear any stale prior load first (e.g. a re-install)
      // — "not currently loaded" is an expected, ignorable outcome, not a
      // real failure (see `exec-runner.ts`'s `RunResult` doc comment).
      await run('launchctl', ['bootout', serviceTarget()]);
      await runOrThrow(run, 'launchctl', ['bootstrap', domainTarget(), plistPath], 'launchctl bootstrap');
      await runOrThrow(run, 'launchctl', ['enable', serviceTarget()], 'launchctl enable');
      // RunAtLoad already starts it on bootstrap; kickstart -k guarantees a
      // fresh start even if bootstrap raced with a leftover instance.
      // Best-effort: RunAtLoad is the load-bearing guarantee here.
      await run('launchctl', ['kickstart', '-k', serviceTarget()]);
    },
    async deactivate() {
      // Tolerant of "wasn't loaded", but a REAL failure (permission denied,
      // launchd itself misbehaving) must NOT be masked: the plist is only
      // deleted once the job is gone from the domain, so a still-running
      // job never loses its control file (cross-model-review P1 #7).
      await runIdempotent(run, 'launchctl', ['bootout', serviceTarget()], 'launchctl bootout', LAUNCHD_NOT_LOADED);
    },
    async removeFiles() {
      await fs.rm(plistPath, { force: true });
      await fs.rm(launcherPath, { force: true });
    },
    async start() {
      await run('launchctl', ['bootstrap', domainTarget(), plistPath]); // best-effort — "already bootstrapped" is fine
      await runOrThrow(run, 'launchctl', ['kickstart', '-k', serviceTarget()], 'launchctl kickstart');
    },
    async stop() {
      // Tolerant of "already stopped/not loaded", but a REAL failure
      // (permission denied, an unreachable GUI domain) must be surfaced
      // rather than silently reported as "stopped" (P1 #7, round 2).
      await runIdempotent(run, 'launchctl', ['bootout', serviceTarget()], 'launchctl bootout', LAUNCHD_NOT_LOADED);
    },
    async query() {
      const result = await run('launchctl', ['print', serviceTarget()]);
      const detail = result.stdout || result.stderr;
      const running = result.code === 0 && /\bstate\s*=\s*running\b/i.test(detail);
      // Finding P1 #2 (residual, round 3): an unreachable GUI domain or a
      // permission failure on THIS query is not evidence of "not running";
      // see `service-types.ts`'s `ServiceStatusResult.determinate`.
      const determinate = running || !LAUNCHD_CONNECTIVITY_OR_PERMISSION_FAILURE.some((pattern) => pattern.test(detail));
      return { running, determinate, detail };
    },
  }, fs);
}
