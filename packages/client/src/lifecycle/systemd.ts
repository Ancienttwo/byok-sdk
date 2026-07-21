import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRunner, runOrThrow, type Runner } from './exec-runner';
import { sanitizeServiceName, type ServiceDefinition, type ServiceInstallOptions, type ServiceLifecycle, type ServiceProgram, type ServiceStatusResult } from './service-types';

/** DI seam for tests — see `exec-runner.ts`'s `Runner` doc comment. */
export interface SystemdDeps {
  run?: Runner;
  fs?: Pick<typeof fsp, 'mkdir' | 'writeFile' | 'rm' | 'stat'>;
  homedir?: () => string;
}

/**
 * systemd unit-file quoting (`systemd.syntax(7)`): `ExecStart=` is
 * whitespace-tokenized like a shell command line unless quoted. Every
 * token is wrapped in double quotes and has embedded backslashes/quotes
 * escaped — unconditionally, not just when a token happens to contain
 * whitespace — so there is no "does this need quoting" judgment call that
 * could get a space-containing config path wrong.
 */
function quoteSystemdArg(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Generates a systemd user unit for `name` running `program`, logging to
 * `logDir`. Pure/no I/O — unit-tested directly for exact content shape, and
 * (locally, when `systemd-analyze` is available) verified with
 * `systemd-analyze verify` — see `templates/service/systemd/README.md`.
 *
 * `Restart=on-failure` + `RestartSec=10` is the crash-restart M3-4 asks for,
 * delegated entirely to systemd. `StandardOutput`/`StandardError` are
 * pointed at append-mode files under `logDir` for parity with the launchd
 * plist's `StandardOutPath`/`StandardErrorPath` and the WinSW `<logpath>` —
 * systemd's own native idiom (the journal, `journalctl --user -u <name>`)
 * still works unconditionally alongside this (systemd always journals
 * unit's output; explicitly setting `StandardOutput=append:...` needs
 * systemd >= 240, present on every currently-supported distro this SDK
 * targets) and is documented in the README as the alternative.
 */
export function generateSystemdUnit(def: { name: string; displayName: string; program: ServiceProgram; logDir: string }): string {
  const { name, displayName, program, logDir } = def;
  const execStart = [program.command, ...program.args].map(quoteSystemdArg).join(' ');
  const cwd = program.cwd ?? os.homedir();
  const outLog = path.join(logDir, `${name}.out.log`);
  const errLog = path.join(logDir, `${name}.err.log`);
  return `[Unit]
Description=${displayName}

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${cwd}
Restart=on-failure
RestartSec=10
StandardOutput=append:${outLog}
StandardError=append:${errLog}

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
export function createSystemdLifecycle(def: ServiceDefinition, deps: SystemdDeps = {}): ServiceLifecycle {
  const run = deps.run ?? defaultRunner;
  const fs = deps.fs ?? fsp;
  const homedir = deps.homedir ?? (() => os.homedir());

  const name = sanitizeServiceName(def.name);
  const unitName = `${name}.service`;
  const unitPath = () => path.join(homedir(), '.config', 'systemd', 'user', unitName);

  async function fileExists(p: string): Promise<boolean> {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  async function writeUnit(program: ServiceProgram): Promise<void> {
    const unit = generateSystemdUnit({ name, displayName: def.displayName ?? def.name, program, logDir: def.logDir });
    await fs.mkdir(path.dirname(unitPath()), { recursive: true });
    await fs.mkdir(def.logDir, { recursive: true });
    await fs.writeFile(unitPath(), unit, 'utf8');
  }

  async function install(opts: ServiceInstallOptions = {}): Promise<void> {
    await writeUnit(opts.program ?? def.program);
    await runOrThrow(run, 'systemctl', ['--user', 'daemon-reload'], 'systemctl daemon-reload');
    // `enable --now` both enables (survives logout/reboot, given linger)
    // AND starts in one call.
    await runOrThrow(run, 'systemctl', ['--user', 'enable', '--now', unitName], 'systemctl enable --now');
  }

  async function uninstall(): Promise<void> {
    await run('systemctl', ['--user', 'disable', '--now', unitName]); // best-effort — fine if not installed/running
    await fs.rm(unitPath(), { force: true });
    await run('systemctl', ['--user', 'daemon-reload']); // best-effort
  }

  async function start(): Promise<void> {
    if (!(await fileExists(unitPath()))) {
      throw new Error(`service "${name}" is not installed (no unit file at ${unitPath()}) — call install() first`);
    }
    await runOrThrow(run, 'systemctl', ['--user', 'start', unitName], 'systemctl start');
  }

  async function stop(): Promise<void> {
    await run('systemctl', ['--user', 'stop', unitName]); // best-effort — tolerant of "already stopped"
  }

  async function status(): Promise<ServiceStatusResult> {
    const installed = await fileExists(unitPath());
    const result = await run('systemctl', ['--user', 'is-active', unitName]);
    const detail = (result.stdout || result.stderr).trim();
    return { installed, running: result.code === 0 && detail === 'active', detail };
  }

  return { install, uninstall, start, stop, status };
}
