import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/**
 * Issue #392 (parent #384 item 2): a daemon started by launchd or systemd
 * gets the service manager's minimal environment (launchd's default PATH is
 * `/usr/bin:/bin:/usr/sbin:/sbin`), not the user's. ADR-037 D2 lets every
 * runtime inherit the daemon's environment, which assumes the daemon's
 * environment IS the user's — so under a service, `claude`/`codex` installed
 * by Homebrew, nvm, bun or an official installer are `not-found`, and
 * rc-only settings (proxies, `ANTHROPIC_BASE_URL`, `CODEX_HOME`, ...) are
 * missing.
 *
 * #1095: this capture is also the base of every runtime environment
 * (`runtime/environment.ts`). {@link loginShellSnapshot} runs the passwd login
 * shell (`os.userInfo().shell`, never `$SHELL`) once per process as
 * `<shell> -i -l -c 'printf %s B; /usr/bin/env -0; printf %s E'`, with B and
 * E random per-run nonces, and keeps the NUL-separated entries found between
 * them. Bytes outside the frame — rc chatter on stdout — are ignored. The
 * capture is complete once the shell has exited and the end nonce has been
 * read; a background job the rc started may keep stdout open, so the capture
 * never waits for EOF after that. Caps: {@link LOGIN_SHELL_ENV_TIMEOUT_MS} and
 * {@link LOGIN_SHELL_ENV_MAX_BYTES}. However the capture ends, the shell's
 * whole process group is SIGKILLed.
 *
 * The shell does not start from this process's environment: an embedding
 * Host's own variables would come back out of `env -0`. It starts from
 * {@link LOGIN_SHELL_SEED_NAMES} copied from this process and `PATH` set to
 * {@link LOGIN_SHELL_SEED_PATH}, what launchd and login(1) give a session;
 * everything else in the snapshot is what the user's rc files produced.
 * `BYOK_*` names found in the capture are dropped: rc files never set SDK
 * control variables. The snapshot never changes `process.env`.
 *
 * `byok-agent start --service` additionally replaces `process.env` with the
 * snapshot (`lifecycle/service-environment.ts`). win32 has no login shell:
 * the snapshot source is `windows-session`, and the runtime environment takes
 * its baseline names from the live session environment.
 *
 * Every report of the result — `start` stdout, `audit.jsonl`, `status` —
 * carries only {@link ServiceEnvironmentStatus}: a source, a closed code,
 * the shell's basename and a duration. Never a variable name, value or path.
 */

export const LOGIN_SHELL_ENV_TIMEOUT_MS = 10_000;
export const LOGIN_SHELL_ENV_MAX_BYTES = 1024 * 1024;

/**
 * The names the login shell starts with, copied from this process: the
 * account and locale, where the shell finds its rc files (`ZDOTDIR`,
 * `XDG_*`), and the session sockets a login manager sets and no rc sets.
 * Every other variable of this process stays out of the capture.
 */
export const LOGIN_SHELL_SEED_NAMES: readonly string[] = Object.freeze([
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_*', 'TZ', 'ZDOTDIR', 'XDG_*',
  'SSH_AUTH_SOCK', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY',
]);

/** The login shell's starting `PATH`; `/etc/zprofile` (path_helper) and `/etc/profile` build the rest. */
export const LOGIN_SHELL_SEED_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/**
 * Shells known to accept `-i -l -c` and this nonce-framed printf/env command.
 * fish supports the same command; nu and a missing passwd entry are refused.
 */
const SUPPORTED_SHELLS = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'fish']);

export const SERVICE_ENVIRONMENT_UNAVAILABLE_CODES = [
  'unsupported-shell',
  'spawn-failed',
  'timeout',
  'output-too-large',
  'bad-frame',
  'shell-exit-nonzero',
] as const;

export type ServiceEnvironmentUnavailableCode = (typeof SERVICE_ENVIRONMENT_UNAVAILABLE_CODES)[number];

/**
 * Where the runtime environment base came from. `inherited`: no snapshot has
 * been taken in this process yet. `windows-session`: win32, which has no login
 * shell.
 */
export type ServiceEnvironmentStatus =
  | { source: 'login-shell'; shell: string; durationMs: number }
  | { source: 'inherited' }
  | { source: 'windows-session' }
  | { source: 'unavailable'; code: ServiceEnvironmentUnavailableCode };

/** One process's login-shell capture. `env` is present exactly when `status.source` is `login-shell`. */
export interface LoginShellSnapshot {
  readonly status: ServiceEnvironmentStatus;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Timestamped closed environment observation shared by diagnostics and audit. */
export interface ServiceEnvironmentRecord {
  status: ServiceEnvironmentStatus;
  ts: string;
}

/**
 * Test seams for {@link captureLoginShellSnapshot} and `captureAndApply`.
 * Not part of the public API.
 *
 * @internal
 */
export interface ApplyLoginShellEnvironmentOptions {
  /** Test seam: an absolute shell path instead of the passwd shell. */
  shell?: string;
  /** Test seam: the environment the seed is copied from (and, for `captureAndApply`, the one replaced). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
  platform?: NodeJS.Platform;
}

let snapshot: Promise<LoginShellSnapshot> | undefined;
let snapshotSource: () => Promise<LoginShellSnapshot> = () => captureLoginShellSnapshot({});
let resolved: ServiceEnvironmentStatus = { source: 'inherited' };

/** Where this process's runtime environment base came from; `inherited` until {@link loginShellSnapshot} has resolved. */
export function serviceEnvironmentStatus(): ServiceEnvironmentStatus {
  return resolved;
}

/**
 * This process's login-shell snapshot, captured on the first call. Later
 * calls return the first call's result. Never throws.
 */
export function loginShellSnapshot(): Promise<LoginShellSnapshot> {
  snapshot ??= snapshotSource().then((result) => {
    resolved = result.status;
    return result;
  });
  return snapshot;
}

/**
 * Test seam: replaces how {@link loginShellSnapshot} obtains the snapshot and
 * forgets an earlier one; `undefined` restores the real capture.
 *
 * @internal
 */
export function setLoginShellSnapshotSource(source: (() => Promise<LoginShellSnapshot>) | undefined): void {
  snapshotSource = source ?? (() => captureLoginShellSnapshot({}));
  snapshot = undefined;
  resolved = { source: 'inherited' };
}

/**
 * Takes one snapshot without the once-per-process latch.
 *
 * @internal
 */
export async function captureLoginShellSnapshot(options: ApplyLoginShellEnvironmentOptions): Promise<LoginShellSnapshot> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return { status: { source: 'windows-session' } };
  const shell = options.shell ?? passwdShell();
  if (!shell || !path.isAbsolute(shell) || (options.shell === undefined && !SUPPORTED_SHELLS.has(path.basename(shell)))) {
    return { status: { source: 'unavailable', code: 'unsupported-shell' } };
  }
  const started = Date.now();
  const captured = await capture(shell, seedEnvironment(options.env ?? process.env), options.timeoutMs ?? LOGIN_SHELL_ENV_TIMEOUT_MS, options.maxBytes ?? LOGIN_SHELL_ENV_MAX_BYTES);
  if ('code' in captured) return { status: { source: 'unavailable', code: captured.code } };
  const env: Record<string, string> = {};
  for (const [name, value] of captured.entries) {
    if (!name.startsWith('BYOK_')) env[name] = value;
  }
  return { status: { source: 'login-shell', shell: path.basename(shell), durationMs: Date.now() - started }, env: Object.freeze(env) };
}


function seedEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const seed: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (LOGIN_SHELL_SEED_NAMES.some((pattern) => pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern)) seed[name] = value;
  }
  seed.PATH = LOGIN_SHELL_SEED_PATH;
  return seed;
}

function passwdShell(): string | undefined {
  try {
    return os.userInfo().shell ?? undefined;
  } catch {
    return undefined;
  }
}

function capture(
  shell: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ entries: Array<[string, string]> } | { code: ServiceEnvironmentUnavailableCode }> {
  const begin = `B${randomBytes(16).toString('hex')}`;
  const end = `E${randomBytes(16).toString('hex')}`;
  const endBytes = Buffer.from(end, 'utf8');
  // Nonces are hex, so they need no quoting in any POSIX shell. `/usr/bin/env`
  // by absolute path: the rc may rearrange PATH; the point is to print what
  // the rc produced, not to depend on it.
  const script = `printf %s ${begin}; /usr/bin/env -0; printf %s ${end}`;
  return new Promise((resolve) => {
    let settled = false;
    let output = Buffer.alloc(0);
    // The end nonce has been read: the dump is complete, stop reading.
    let framed = false;
    // stdout reached EOF without the end nonce.
    let drained = false;
    // `undefined` until the shell itself has exited.
    let exitCode: number | null | undefined;
    let child: ReturnType<typeof spawn> | undefined;
    const finish = (result: { entries: Array<[string, string]> } | { code: ServiceEnvironmentUnavailableCode }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // `detached` made the shell a process-group leader: this reaches
      // whatever the rc started in that group and left running — a
      // background job still holding stdout open, or one that outlived the
      // shell — on every outcome, success included.
      try {
        if (child?.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
      child?.stdout?.destroy();
      resolve(result);
    };
    // The result is known once the shell has exited AND the frame is either
    // complete or can no longer arrive. Waiting for stdout `close` instead
    // would wait for every process sharing the pipe — an rc's `sleep 30 &`
    // would turn a complete dump into a timeout.
    const settle = (): void => {
      if (exitCode === undefined) return;
      if (exitCode !== 0) {
        finish({ code: 'shell-exit-nonzero' });
        return;
      }
      if (!framed && !drained) return;
      finish(parseFrame(output.toString('utf8'), begin, end));
    };
    const timer = setTimeout(() => finish({ code: 'timeout' }), timeoutMs);
    try {
      child = spawn(shell, ['-i', '-l', '-c', script], { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    } catch {
      finish({ code: 'spawn-failed' });
      return;
    }
    child.on('error', () => finish({ code: 'spawn-failed' }));
    child.stdout!.on('data', (chunk: Buffer) => {
      if (framed || settled) return;
      if (output.length + chunk.length > maxBytes) {
        finish({ code: 'output-too-large' });
        return;
      }
      // Search only the bytes that can contain a nonce ending in this chunk.
      const from = Math.max(0, output.length - endBytes.length + 1);
      output = Buffer.concat([output, chunk]);
      if (output.indexOf(endBytes, from) >= 0) {
        framed = true;
        settle();
      }
    });
    child.stdout!.on('end', () => {
      drained = true;
      settle();
    });
    child.on('exit', (code) => {
      exitCode = code;
      settle();
    });
  });
}

function parseFrame(stdout: string, begin: string, end: string): { entries: Array<[string, string]> } | { code: 'bad-frame' } {
  const start = stdout.indexOf(begin);
  const stop = stdout.lastIndexOf(end);
  if (start < 0 || stop < 0 || stop < start + begin.length || stdout.indexOf(begin, start + 1) >= 0) return { code: 'bad-frame' };
  const body = stdout.slice(start + begin.length, stop);
  if (body.length === 0 || !body.endsWith('\0')) return { code: 'bad-frame' };
  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const entry of body.slice(0, -1).split('\0')) {
    const separator = entry.indexOf('=');
    if (separator <= 0) return { code: 'bad-frame' };
    const name = entry.slice(0, separator);
    if (seen.has(name)) return { code: 'bad-frame' };
    seen.add(name);
    entries.push([name, entry.slice(separator + 1)]);
  }
  return { entries };
}
