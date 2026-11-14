import { captureLoginShellSnapshot, loginShellSnapshot, pinLiveHome, type ApplyLoginShellEnvironmentOptions, type ServiceEnvironmentStatus } from '../login-shell-environment.js';

/**
 * Issue #392: `byok-agent start --service` runs under a service manager's
 * minimal environment. {@link applyLoginShellEnvironment} replaces this
 * process's `process.env` with the login-shell snapshot
 * (`../login-shell-environment.ts`, the base of every runtime environment)
 * and puts back the `HOME` and `BYOK_*` values this process had, so that the
 * daemon resolves its own config and binaries as the user's terminal would.
 *
 * `HOME` is the home the service manager gave the job (the launchd plist pins
 * the lifecycle's home, #2017), so an rc that resets it cannot move the daemon
 * to another home; `pinLiveHome` is the same rule a default runtime
 * environment applies to tasks (#2084). Only the daemon's `HOME` and `BYOK_*`
 * are pinned: `PATH`, `XDG_*` and other values an rc derives from a different
 * home stay as the rc set them.
 */

/** The `byok-agent start` flag generated service definitions pass. */
export const SERVICE_FLAG = '--service';

let applied: Promise<ServiceEnvironmentStatus> | undefined;

/**
 * Replaces `process.env` with this process's login-shell snapshot, keeping
 * this process's own `HOME` and `BYOK_*` values. Runs once per process: later calls
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
  const live = { ...env };
  for (const name of Object.keys(env)) delete env[name];
  for (const [name, value] of Object.entries(snapshotEnv)) {
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(live)) {
    if (value !== undefined && name.startsWith('BYOK_')) env[name] = value;
  }
  pinLiveHome(env, live);
}
