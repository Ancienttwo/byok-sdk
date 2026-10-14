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
 * D2 itself is unchanged: a child's environment is still the daemon's minus
 * `CLAUDECODE` and `BYOK_*` (`daemon/environment.ts`). This module only
 * changes where the daemon's environment comes from, once per process:
 * {@link applyLoginShellEnvironment} runs the passwd login shell
 * (`os.userInfo().shell`, never `$SHELL`) once as
 * `<shell> -i -l -c 'printf %s B; /usr/bin/env -0; printf %s E'`, with B and
 * E random per-run nonces, and replaces `process.env` with the NUL-separated
 * entries found between them. Bytes outside the frame — rc chatter on stdout
 * — are ignored. The capture is complete once the shell has exited and the
 * end nonce has been read; a background job the rc started may keep stdout
 * open, so the capture never waits for EOF after that. Caps:
 * {@link LOGIN_SHELL_ENV_TIMEOUT_MS} and {@link LOGIN_SHELL_ENV_MAX_BYTES}.
 * However the capture ends, the shell's whole process group is SIGKILLed.
 *
 * The shell gets this process's environment minus `BYOK_*`, so rc files
 * never see SDK control variables. `BYOK_*` names found in the capture are
 * dropped and the `BYOK_*` values this process had before the capture are
 * put back: rc files never set SDK control variables either.
 *
 * `byok-agent start --service` calls it first ({@link SERVICE_FLAG}; the
 * launchd plist, systemd unit and WinSW XML pass that flag). An embedding Host started
 * outside a terminal (an Electron app launched from the Dock has launchd's
 * PATH too) calls the same function at its own startup.
 *
 * Every report of the result — `start` stdout, `audit.jsonl`, `status` —
 * carries only {@link ServiceEnvironmentStatus}: a source, a closed code,
 * the shell's basename and a duration. Never a variable name, value or path.
 */

/** The `byok-agent start` flag generated service definitions pass. */
export const SERVICE_FLAG = '--service';

export const LOGIN_SHELL_ENV_TIMEOUT_MS = 10_000;
export const LOGIN_SHELL_ENV_MAX_BYTES = 1024 * 1024;

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

export type ServiceEnvironmentStatus =
  | { source: 'login-shell'; shell: string; durationMs: number }
  | { source: 'inherited' }
  | { source: 'unavailable'; code: ServiceEnvironmentUnavailableCode };

/** Timestamped closed environment observation shared by diagnostics and audit. */
export interface ServiceEnvironmentRecord {
  status: ServiceEnvironmentStatus;
  ts: string;
}

/**
 * Test seams for {@link captureAndApply}. Not part of the public API:
 * {@link applyLoginShellEnvironment} takes no options.
 *
 * @internal
 */
export interface ApplyLoginShellEnvironmentOptions {
  /** Test seam: an absolute shell path instead of the passwd shell. */
  shell?: string;
  /** Test seam: the environment to replace. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
  platform?: NodeJS.Platform;
}

let applied: Promise<ServiceEnvironmentStatus> | undefined;
let resolved: ServiceEnvironmentStatus = { source: 'inherited' };

/** What {@link applyLoginShellEnvironment} did in this process; `inherited` until it has run. */
export function serviceEnvironmentStatus(): ServiceEnvironmentStatus {
  return resolved;
}

/**
 * Captures the login-shell environment and replaces `process.env` with it.
 * Runs once per process: later calls return the first call's result. On
 * failure `process.env` is left exactly as inherited. Never throws. win32
 * has no login shell: the result is `inherited`.
 */
export function applyLoginShellEnvironment(): Promise<ServiceEnvironmentStatus> {
  applied ??= captureAndApply({}).then((status) => {
    resolved = status;
    return status;
  });
  return applied;
}

/**
 * The capture-and-replace step without the once-per-process latch; for
 * tests and for {@link applyLoginShellEnvironment} only.
 *
 * @internal
 */
export async function captureAndApply(options: ApplyLoginShellEnvironmentOptions): Promise<ServiceEnvironmentStatus> {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return { source: 'inherited' };
  const env = options.env ?? process.env;
  const shell = options.shell ?? passwdShell();
  if (!shell || !path.isAbsolute(shell) || (options.shell === undefined && !SUPPORTED_SHELLS.has(path.basename(shell)))) {
    return { source: 'unavailable', code: 'unsupported-shell' };
  }
  const ownByok: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name.startsWith('BYOK_')) ownByok[name] = value;
  }
  const started = Date.now();
  const captured = await capture(shell, env, options.timeoutMs ?? LOGIN_SHELL_ENV_TIMEOUT_MS, options.maxBytes ?? LOGIN_SHELL_ENV_MAX_BYTES);
  if ('code' in captured) return { source: 'unavailable', code: captured.code };
  for (const name of Object.keys(env)) delete env[name];
  for (const [name, value] of captured.entries) {
    if (!name.startsWith('BYOK_')) env[name] = value;
  }
  Object.assign(env, ownByok);
  return { source: 'login-shell', shell: path.basename(shell), durationMs: Date.now() - started };
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
  // The daemon's own `BYOK_*` values never reach the rc; they are put back
  // after the capture (`captureAndApply`).
  const shellEnv: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('BYOK_')) shellEnv[name] = value;
  }
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
      child = spawn(shell, ['-i', '-l', '-c', script], { env: shellEnv, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
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
