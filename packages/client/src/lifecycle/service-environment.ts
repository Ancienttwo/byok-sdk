import { captureLoginShellSnapshot, loginShellSnapshot, type ApplyLoginShellEnvironmentOptions, type ServiceEnvironmentStatus } from '../login-shell-environment';

/**
 * Issue #392: `byok-agent start --service` runs under a service manager's
 * minimal environment. {@link applyLoginShellEnvironment} replaces this
 * process's `process.env` with the login-shell snapshot
 * (`../login-shell-environment.ts`, the base of every runtime environment)
 * and puts back the `BYOK_*` values this process had, so that the daemon
 * resolves its own config and binaries as the user's terminal would.
 */

/** The `byok-agent start` flag generated service definitions pass. */
export const SERVICE_FLAG = '--service';

let applied: Promise<ServiceEnvironmentStatus> | undefined;

/**
 * Replaces `process.env` with this process's login-shell snapshot, keeping
 * this process's own `BYOK_*` values. Runs once per process: later calls
 * return the first call's result. On failure `process.env` is left exactly as
 * inherited. Never throws.
 */
export function applyLoginShellEnvironment(): Promise<ServiceEnvironmentStatus> {
  applied ??= loginShellSnapshot().then((result) => {
    if (result.env !== undefined) replaceEnvironment(process.env, result.env);
    return result.status;
  });
  return applied;
}


/**
 * {@link captureLoginShellSnapshot} followed by the replacement
 * {@link applyLoginShellEnvironment} makes, on `options.env`.
 *
 * @internal
 */
export async function captureAndApply(options: ApplyLoginShellEnvironmentOptions): Promise<ServiceEnvironmentStatus> {
  const result = await captureLoginShellSnapshot(options);
  if (result.env !== undefined) replaceEnvironment(options.env ?? process.env, result.env);
  return result.status;
}


function replaceEnvironment(env: NodeJS.ProcessEnv, snapshotEnv: Readonly<Record<string, string | undefined>>): void {
  const ownByok: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && name.startsWith('BYOK_')) ownByok[name] = value;
  }
  for (const name of Object.keys(env)) delete env[name];
  for (const [name, value] of Object.entries(snapshotEnv)) {
    if (value !== undefined) env[name] = value;
  }
  Object.assign(env, ownByok);
}

