import { composeRuntimeEnvironment } from '../../runtime/environment';
import type { LoginShellSnapshot } from '../../login-shell-environment';

/**
 * The unit suite's login-shell snapshot: the live `process.env` itself, so a
 * test that puts a fake CLI on `PATH` reaches it through the real adapters.
 * The capture itself is covered by `service-environment.test.ts` and the e2e
 * suite, which spawn real login shells.
 */
export const TEST_LOGIN_SHELL_SNAPSHOT: LoginShellSnapshot = Object.freeze({
  status: Object.freeze({ source: 'login-shell', shell: 'test', durationMs: 0 }),
  get env() { return process.env; },
});

/** The default runtime environment an adapter builds over {@link TEST_LOGIN_SHELL_SNAPSHOT}, from `live`. */
export function testRuntimeEnv(live: Readonly<Record<string, string | undefined>> = process.env, platform?: NodeJS.Platform): Record<string, string> {
  return composeRuntimeEnvironment({ policy: {}, snapshot: { status: TEST_LOGIN_SHELL_SNAPSHOT.status, env: live }, live, ...(platform === undefined ? {} : { platform }) });
}
