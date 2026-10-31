import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRunner, runIdempotent, runOrThrow, type IdempotentAbsence, type Runner } from '../util/exec-runner';
import { createManagedLifecycle, type ManagedLifecycleFs, type ManagedServiceLifecycle } from './managed-lifecycle';
import { SERVICE_REDIRECT_STDERR_FILENAME, SERVICE_REDIRECT_STDOUT_FILENAME } from './service-log';
import { sanitizeServiceName, type ServiceDefinition } from './service-types';
import { generateServiceLauncher, SERVICE_UNIT_MARKER, serviceLauncherPath } from './service-unit';

/** DI seam for tests — see `exec-runner.ts`'s `Runner` doc comment. */
export interface SystemdDeps {
  run?: Runner;
  fs?: ManagedLifecycleFs;
  homedir?: () => string;
}

/**
 * Genuine-failure text that must NEVER be reclassified as "unit already
 * absent", checked before `SYSTEMD_NOT_LOADED`'s own `patterns` (see
 * `exec-runner.ts`'s `IdempotentAbsence.neverAbsence`). The load-bearing one
 * is `Failed to connect to bus: No such file or directory` — the standard,
 * very common systemd message when there is no reachable `systemd --user`
 * D-Bus session for this uid (headless/SSH without `loginctl
 * enable-linger` — exactly where this daemon commonly runs). Its own
 * "No such file or directory" wording is textually indistinguishable from a
 * genuinely-absent unit's ENOENT unless the "connect to ... bus" prefix is
 * checked for and excluded first: without this, that bus-connect failure
 * was previously misread as "already absent", deleting the still-relevant
 * unit file out from under a service that may still be installed/running —
 * the exact orphan bug #7 was supposed to fix, reintroduced by this one
 * over-broad pattern (cross-model-review P1 #7, round 2).
 */
const SYSTEMD_CONNECTIVITY_OR_PERMISSION_FAILURE: readonly RegExp[] = [
  /failed to connect to.*bus/i,
  /connection refused/i,
  /access denied/i,
  /permission denied/i,
  /interactive authentication required/i,
];

/**
 * What `systemctl --user disable --now`/`systemctl --user stop` prints/exits
 * with when the unit isn't installed/loaded at all — as opposed to a
 * genuine failure (permission denied, no running `--user` instance, a
 * manager fault), which must be surfaced rather than treated the same way
 * (see `uninstall()`/`stop()` below and cross-model-review P1 #7).
 *
 * Deliberately does NOT include a bare "no such file or directory" pattern
 * (present in an earlier version of this fix): both genuine absence shapes
 * this module actually needs to tolerate — `stop` on an unloaded unit
 * ("Unit foo.service not loaded.") and `disable`/other unit-file lookups on
 * one that was never written ("Unit file foo.service does not exist.") —
 * are already covered by the two patterns below without it, while the bare
 * ENOENT string is ALSO exactly what a bus-connect failure produces (see
 * `SYSTEMD_CONNECTIVITY_OR_PERMISSION_FAILURE` above) — there is no
 * genuine-absence case this module relies on that only the bare pattern
 * would have caught.
 */
const SYSTEMD_NOT_LOADED: IdempotentAbsence = {
  patterns: [/not loaded/i, /does not exist/i],
  neverAbsence: SYSTEMD_CONNECTIVITY_OR_PERMISSION_FAILURE,
};

/**
 * True if `value` contains any C0 control character (newline, CR, NUL,
 * etc., code points below 32) or DEL (code point 127) - checked by
 * character code rather than a regex escape sequence for that range, so
 * there is no ambiguity about which literal bytes are being matched.
 */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/**
 * Rejects (rather than silently mangling or truncating) a value about to be
 * embedded in a generated systemd unit file if it contains any control
 * character. Unit files are line-oriented `Key=value` text: a raw newline
 * in `displayName`/`cwd`/a log path/an arg would split one logical
 * directive into two, letting an attacker- or mistake-controlled value
 * inject an ENTIRE ADDITIONAL, attacker-chosen unit directive
 * (cross-model-review P1 #8) — there is no escape sequence that makes an
 * embedded raw newline safe here, so this rejects outright rather than
 * attempting to neutralize it in place.
 */
function assertNoControlChars(value: string, field: string): void {
  if (hasControlChar(value)) {
    throw new Error(
      `systemd unit ${field} must not contain control characters (newline/CR/etc.) — refusing to generate a unit file that could inject an unintended directive (got ${JSON.stringify(value)})`,
    );
  }
}

/**
 * Escapes a literal `%` as systemd's own documented `%%` — systemd expands
 * `%`-prefixed specifiers (`%h`, `%n`, `%i`, ...) in unit file directive
 * values (`systemd.unit(5)`'s "Specifiers" section), so a raw `%` in a
 * supposedly-verbatim path/name would otherwise risk being silently
 * reinterpreted rather than passed through as written
 * (cross-model-review P1 #8).
 */
function escapeSystemdPercent(value: string): string {
  return value.replace(/%/g, '%%');
}

/**
 * systemd unit-file quoting (`systemd.syntax(7)`): `ExecStart=` is
 * whitespace-tokenized like a shell command line unless quoted. Every
 * token is wrapped in double quotes and has embedded backslashes/quotes
 * escaped — unconditionally, not just when a token happens to contain
 * whitespace — so there is no "does this need quoting" judgment call that
 * could get a space-containing config path wrong. Per
 * `systemd.service(5)`'s "Command Lines" section, `ExecStart=` ALSO expands
 * `%`-specifiers and `$FOO`/`${FOO}` environment variables in the raw
 * command line before tokenizing — both neutralized here too (`$` doubled
 * to `$$`, systemd's own documented escape for a literal dollar sign; `%`
 * doubled to `%%`) so `program.command`/`program.args` reach the process
 * exactly as given (see `service-types.ts`'s `ServiceProgram.args` doc
 * comment: "passed verbatim"), never silently rewritten by systemd
 * (cross-model-review P1 #8). A control character (e.g. an embedded
 * newline) is rejected outright — see `assertNoControlChars`; a quoted
 * string still can't survive an embedded newline in a line-oriented unit
 * file.
 */
function quoteSystemdArg(value: string): string {
  assertNoControlChars(value, 'program.command/program.args entry');
  const escaped = escapeSystemdPercent(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, () => '$$');
  return `"${escaped}"`;
}

/**
 * Generates a systemd user unit for `name` that runs only the stable
 * `launcherPath` (#1097), logging to `logDir`. Pure/no I/O — unit-tested
 * directly for exact content shape, and (locally, when `systemd-analyze` is
 * available) verified with `systemd-analyze verify` — see
 * `templates/service/systemd/README.md`.
 *
 * `Restart=always` + `RestartPreventExitStatus=0` + `RestartSec=10` is the
 * exit-code contract in `exit-codes.ts`: any exit but 0 restarts.
 * `StandardOutput`/`StandardError` append to redirect files under `logDir`
 * that receive only early-boot crash output; the daemon writes its own
 * rotated log (`service-log.ts`). The journal (`journalctl --user -u
 * <name>`) still records the unit's output alongside.
 */
export function generateSystemdUnit(def: { name: string; displayName: string; launcherPath: string; workingDirectory: string; logDir: string }): string {
  const { name, displayName, launcherPath, workingDirectory, logDir } = def;
  // Every interpolated value is validated/escaped BEFORE being written into
  // the template below — never after — so there is no path that emits an
  // unchecked value into the generated unit file (cross-model-review P1
  // #8). `name` is checked here too even though every real caller already
  // ran it through `sanitizeServiceName` (see `service-types.ts`), since
  // this is a directly exported, directly unit-tested pure function that
  // must be safe on its own, not just when called via
  // `createSystemdLifecycle`.
  assertNoControlChars(name, 'name');
  assertNoControlChars(displayName, 'displayName');
  assertNoControlChars(workingDirectory, 'workingDirectory');
  const outLog = path.join(logDir, SERVICE_REDIRECT_STDOUT_FILENAME);
  const errLog = path.join(logDir, SERVICE_REDIRECT_STDERR_FILENAME);
  assertNoControlChars(outLog, 'logDir');
  assertNoControlChars(errLog, 'logDir');
  return `# ${SERVICE_UNIT_MARKER}
[Unit]
Description=${escapeSystemdPercent(displayName)}

[Service]
Type=simple
ExecStart=${quoteSystemdArg(launcherPath)}
WorkingDirectory=${escapeSystemdPercent(workingDirectory)}
Restart=always
RestartPreventExitStatus=0
RestartSec=10
StandardOutput=append:${escapeSystemdPercent(outLog)}
StandardError=append:${escapeSystemdPercent(errLog)}

[Install]
WantedBy=default.target
`;
}

/**
 * Linux systemd **user** service lifecycle (`~/.config/systemd/user/`,
 * `systemctl --user ...`) — deliberately not a system-wide unit under
 * `/etc/systemd/system/`, so install/uninstall never needs root, matching
 * launchd's per-user LaunchAgent (not a system Daemon) and WinSW's
 * per-machine Windows Service the same way each platform's own idiomatic
 * "run this in the background for me" mechanism works.
 *
 * Requires a running systemd **user instance** for this user (normal on any
 * desktop/login-manager session, and on modern systemd with
 * `loginctl enable-linger` for a headless box) — a bare container with no
 * systemd user session at all will fail every `systemctl --user` call here
 * with a clear error surfaced from `runOrThrow`, not a silent no-op.
 */
export function createSystemdLifecycle(def: ServiceDefinition, deps: SystemdDeps = {}): ManagedServiceLifecycle {
  const run = deps.run ?? defaultRunner;
  const fs = deps.fs ?? fsp;
  const homedir = deps.homedir ?? (() => os.homedir());

  const name = sanitizeServiceName(def.name);
  const unitName = `${name}.service`;
  const unitPath = path.join(homedir(), '.config', 'systemd', 'user', unitName);
  const launcherPath = serviceLauncherPath(def.storeDir, name, 'linux');

  return createManagedLifecycle(def, {
    serviceName: name,
    unitPath,
    launcherPath,
    files: () => [
      { path: unitPath, content: generateSystemdUnit({ name, displayName: def.displayName ?? def.name, launcherPath, workingDirectory: homedir(), logDir: def.logDir }) },
      { path: launcherPath, content: generateServiceLauncher(def.program), mode: 0o755 },
    ],
    async activate() {
      await runOrThrow(run, 'systemctl', ['--user', 'daemon-reload'], 'systemctl daemon-reload');
      // `enable` survives logout/reboot (given linger); `restart` starts a
      // stopped unit and reloads a running one onto the rewritten launcher.
      await runOrThrow(run, 'systemctl', ['--user', 'enable', unitName], 'systemctl enable');
      await runOrThrow(run, 'systemctl', ['--user', 'restart', unitName], 'systemctl restart');
    },
    async deactivate() {
      // Tolerant of "wasn't installed/running", but a REAL failure
      // (permission denied, no running `--user` instance, a manager fault)
      // must NOT be masked: the unit file is only deleted once it is
      // disabled/stopped or was never there (cross-model-review P1 #7).
      await runIdempotent(run, 'systemctl', ['--user', 'disable', '--now', unitName], 'systemctl disable --now', SYSTEMD_NOT_LOADED);
    },
    async removeFiles() {
      await fs.rm(unitPath, { force: true });
      await fs.rm(launcherPath, { force: true });
      await run('systemctl', ['--user', 'daemon-reload']); // best-effort — no control file left to protect at this point
    },
    async start() {
      await runOrThrow(run, 'systemctl', ['--user', 'start', unitName], 'systemctl start');
    },
    async stop() {
      // Tolerant of "already stopped/not loaded", but a REAL failure must
      // be surfaced rather than reported as "stopped" (P1 #7, round 2).
      await runIdempotent(run, 'systemctl', ['--user', 'stop', unitName], 'systemctl stop', SYSTEMD_NOT_LOADED);
    },
    async query() {
      const result = await run('systemctl', ['--user', 'is-active', unitName]);
      const detail = (result.stdout || result.stderr).trim();
      const running = result.code === 0 && detail === 'active';
      // Finding P1 #2 (residual, round 3): a bus-connect/permission failure
      // on THIS query is not evidence of "inactive"; see
      // `service-types.ts`'s `ServiceStatusResult.determinate`.
      const determinate = running || !SYSTEMD_CONNECTIVITY_OR_PERMISSION_FAILURE.some((pattern) => pattern.test(detail));
      return { running, determinate, detail };
    },
  }, fs);
}
