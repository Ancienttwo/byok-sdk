import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRunner, runIdempotent, runOrThrow, type IdempotentAbsence, type Runner } from './exec-runner';
import { sanitizeServiceName, type ServiceDefinition, type ServiceInstallOptions, type ServiceLifecycle, type ServiceProgram, type ServiceStatusResult } from './service-types';

/**
 * What `launchctl bootout` prints/exits with when there was nothing loaded
 * to boot out — as opposed to a genuine failure (permission denied, a
 * malformed domain target, launchd itself misbehaving), which must be
 * surfaced rather than treated the same way (see `uninstall()` below and
 * cross-model-review P1 #7).
 */
const LAUNCHD_NOT_LOADED: IdempotentAbsence = {
  patterns: [/no such process/i, /could not find (specified )?service/i, /domain.*(not found|does not exist)/i, /not loaded/i],
};

/** DI seam for tests — see `exec-runner.ts`'s `Runner` doc comment for why a mocked `run` is enough to unit-test all of this file's install/uninstall/start/stop/status logic on any host OS. */
export interface LaunchdDeps {
  run?: Runner;
  fs?: Pick<typeof fsp, 'mkdir' | 'writeFile' | 'rm' | 'stat'>;
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
 * Generates a launchd LaunchAgent plist for `label` running `program`,
 * logging to `logDir`. Pure/no I/O — unit-tested directly for exact content
 * shape.
 *
 * - `RunAtLoad`: true — starts immediately on `launchctl bootstrap`.
 * - `KeepAlive.SuccessfulExit: false` — the standard, widely-documented
 *   launchd idiom for "restart only on crash/non-zero-or-signaled exit, do
 *   NOT restart after a clean `exit(0)`". This is the crash-restart M3-4
 *   asks for, delegated entirely to launchd — nothing in this SDK
 *   supervises the process itself.
 * - `ThrottleInterval: 10` — matches the WinSW recipe's `onfailure delay="10
 *   sec"` (see `winsw.ts`) so a crash-looping process backs off at a
 *   comparable rate on every platform, rather than launchd's own default
 *   (which is already 10s, but left implicit is easy to mistake for
 *   "unthrottled").
 * - `StandardOutPath`/`StandardErrorPath` under `logDir` — this is what M3-4
 *   asks for explicitly ("StandardOut/Error paths under storeDir"), unlike
 *   `systemd.ts`'s unit (which ALSO writes append-mode log files under
 *   `logDir` for cross-platform parity, even though systemd's own native
 *   idiom is the journal).
 */
export function generateLaunchdPlist(def: { label: string; program: ServiceProgram; logDir: string }): string {
  const { label, program, logDir } = def;
  const args = [program.command, ...program.args];
  const cwd = program.cwd ?? os.homedir();
  const outLog = path.join(logDir, `${label}.out.log`);
  const errLog = path.join(logDir, `${label}.err.log`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${plistString(label)}
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    ${plistString(a)}`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  ${plistString(cwd)}
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
  const plistPath = () => path.join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const domainTarget = () => `gui/${getuid()}`;
  const serviceTarget = () => `${domainTarget()}/${label}`;

  async function fileExists(p: string): Promise<boolean> {
    try {
      await fs.stat(p);
      return true;
    } catch {
      return false;
    }
  }

  async function writePlist(program: ServiceProgram): Promise<void> {
    const xml = generateLaunchdPlist({ label, program, logDir: def.logDir });
    await fs.mkdir(path.dirname(plistPath()), { recursive: true });
    await fs.mkdir(def.logDir, { recursive: true });
    await fs.writeFile(plistPath(), xml, 'utf8');
  }

  async function install(opts: ServiceInstallOptions = {}): Promise<void> {
    await writePlist(opts.program ?? def.program);
    // Best-effort: clear any stale prior load first (e.g. a re-install)
    // — "not currently loaded" is an expected, ignorable outcome, not a
    // real failure (see `exec-runner.ts`'s `RunResult` doc comment).
    await run('launchctl', ['bootout', serviceTarget()]);
    await runOrThrow(run, 'launchctl', ['bootstrap', domainTarget(), plistPath()], 'launchctl bootstrap');
    await runOrThrow(run, 'launchctl', ['enable', serviceTarget()], 'launchctl enable');
    // RunAtLoad already starts it on bootstrap; kickstart -k guarantees a
    // fresh start even if bootstrap raced with a leftover instance.
    // Best-effort: RunAtLoad is the load-bearing guarantee here.
    await run('launchctl', ['kickstart', '-k', serviceTarget()]);
  }

  async function uninstall(): Promise<void> {
    // Tolerant of "wasn't loaded" (fine — nothing to stop/unregister), but a
    // REAL failure (permission denied, launchd itself misbehaving) must NOT
    // be masked: only delete the plist once we know the job is actually
    // gone from the domain, so a still-running job never loses its control
    // file and becomes an orphan nobody can stop/uninstall
    // (cross-model-review P1 #7).
    await runIdempotent(run, 'launchctl', ['bootout', serviceTarget()], 'launchctl bootout', LAUNCHD_NOT_LOADED);
    await fs.rm(plistPath(), { force: true });
  }

  async function start(): Promise<void> {
    if (!(await fileExists(plistPath()))) {
      throw new Error(`service "${label}" is not installed (no plist at ${plistPath()}) — call install() first`);
    }
    await run('launchctl', ['bootstrap', domainTarget(), plistPath()]); // best-effort — "already bootstrapped" is fine
    await runOrThrow(run, 'launchctl', ['kickstart', '-k', serviceTarget()], 'launchctl kickstart');
  }

  async function stop(): Promise<void> {
    await run('launchctl', ['bootout', serviceTarget()]); // best-effort — tolerant of "already stopped"
  }

  async function status(): Promise<ServiceStatusResult> {
    const installed = await fileExists(plistPath());
    const result = await run('launchctl', ['print', serviceTarget()]);
    const detail = result.stdout || result.stderr;
    const running = result.code === 0 && /\bstate\s*=\s*running\b/i.test(detail);
    return { installed, running, detail };
  }

  return { install, uninstall, start, stop, status };
}
