/**
 * The process exit-code contract of `byok-agent` and its helper
 * executables (#394, #1097). Every exit status the source uses is a key
 * here; `exit-codes.test.ts` scans `src/bin` and fails on any other.
 *
 * `service` is what a service manager does when the process exits with
 * that status. Only 0 stops a service, and every generated unit says so:
 * launchd `KeepAlive.SuccessfulExit = false`, systemd `Restart=always` with
 * `RestartPreventExitStatus=0`, WinSW `<onfailure action="restart">` (which
 * fires on a non-zero exit only). A service runs `start --service`, which
 * exits only 0 (stopped or halted) or 1 (crashed).
 */
export const EXIT_CODE_CONTRACT = Object.freeze({
  0: { meaning: 'success: a command finished, or the daemon stopped or (under --service) halted', service: 'stop' },
  1: { meaning: 'failure: a command failed, or the daemon crashed', service: 'restart' },
  2: { meaning: 'upgrade check --store: a store would be refused', service: 'restart' },
  78: { meaning: 'EX_CONFIG: the daemon halted outside --service, or a helper refused its configuration', service: 'restart' },
} as const);

export type ExitCode = keyof typeof EXIT_CODE_CONTRACT;
export type ServiceExitDisposition = (typeof EXIT_CODE_CONTRACT)[ExitCode]['service'];

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;
export const EXIT_CONFIG = 78;

/** What a service manager does after `code`; a status outside the contract (a signal, an unknown code) restarts. */
export function serviceExitDisposition(code: number): ServiceExitDisposition {
  return code === EXIT_SUCCESS ? 'stop' : 'restart';
}

/** How `start` ended without crashing; a crash is a throw and exits {@link EXIT_FAILURE}. */
export interface DaemonExitOutcome { readonly kind: 'stopped' | 'halted' }

/**
 * `start`'s exit status: 0 for a stop, {@link EXIT_CONFIG} for a halt (a
 * restart cannot fix it). Under `--service` a halt exits 0, the one status
 * every supported service manager leaves stopped.
 */
export function daemonExitCode(outcome: DaemonExitOutcome, service: boolean): ExitCode {
  if (outcome.kind === 'stopped' || service) return EXIT_SUCCESS;
  return EXIT_CONFIG;
}
