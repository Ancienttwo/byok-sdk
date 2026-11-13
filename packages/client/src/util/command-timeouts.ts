import type { ChildProcess } from 'node:child_process';

/**
 * The bound, in ms, on each kind of platform command (#1971). `winsw` covers
 * WinSW's `start`/`stop`/`stopwait`, which wait on the SCM (and `stop` on the
 * service's own `stoptimeout`); `platform` covers every `launchctl`,
 * `systemctl`, `sc.exe`, PowerShell and `icacls` run. `disposal` bounds the
 * cleanup of a timed-out command's process tree, and `rootExit` the wait for
 * a killed root process to exit.
 */
export const COMMAND_TIMEOUT_MS = { platform: 30_000, winsw: 120_000, hostStop: 60_000, launch: 30_000, disposal: 10_000, rootExit: 2_000 } as const;

/**
 * A platform command outlived its bound and was stopped. Whether it took
 * effect is UNKNOWN: a job may have been bootstrapped or a service registered
 * before the stop. It never means the change did not happen and is never
 * idempotent absence.
 *
 * Only `exitConfirmed: true` guarantees the command (its process tree, or the
 * killed root where only the root is stopped) has exited. `false` means its
 * cleanup failed or did not finish in time, and it may still be running and
 * still change the service. A Host branches on the error's code first, then
 * on this field: retrying while it is `false` can race the old command. The
 * SDK keeps no later ownership of such a process; deciding when to retry,
 * and recovering, is the Host's job.
 */
export class PlatformCommandTimeoutError extends Error {
  constructor(message: string, readonly exitConfirmed: boolean, options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * SIGKILLs `child` alone (never its tree) after its bound and resolves the
 * timeout to reject with: `exitConfirmed` only when it exited within the
 * `rootExit` bound. A `kill()` that fails, or no exit in time, is unconfirmed.
 */
export function stopRoot(child: ChildProcess, label: string): Promise<PlatformCommandTimeoutError> {
  return new Promise((resolve) => {
    const settle = (exitConfirmed: boolean): void => {
      clearTimeout(grace);
      resolve(new PlatformCommandTimeoutError(`${label} timed out`, exitConfirmed));
    };
    const grace = setTimeout(() => settle(false), COMMAND_TIMEOUT_MS.rootExit);
    if (child.exitCode !== null || child.signalCode !== null) return settle(true);
    child.once('exit', () => settle(true));
    if (!child.kill('SIGKILL')) settle(false);
  });
}
