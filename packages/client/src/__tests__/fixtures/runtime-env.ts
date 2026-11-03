import { composeRuntimeEnvironment, type RuntimeEnvironment, type WindowsLogonRegistry, type WindowsRegistryString } from '../../runtime/environment';
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

/**
 * The unit suite's logon registry on win32: a machine key holding the live
 * `PATH` and `PATHEXT`, read at every build, and an empty user key, so the
 * base `PATH` is the live one, as {@link TEST_LOGIN_SHELL_SNAPSHOT} makes it
 * elsewhere. The registry read itself is covered by `environment.test.ts`.
 */
export function testWindowsLogonRegistry(live: Readonly<Record<string, string | undefined>> = process.env): WindowsLogonRegistry {
  return {
    source: 'registry',
    get machine() {
      const machine = new Map<string, WindowsRegistryString>();
      for (const [name, value] of Object.entries(live)) {
        const upper = name.toUpperCase();
        if (value !== undefined && (upper === 'PATH' || upper === 'PATHEXT')) machine.set(upper, { expand: false, value });
      }
      return machine;
    },
    user: new Map(),
  };
}

/** The default runtime environment, with its report, an adapter builds over {@link TEST_LOGIN_SHELL_SNAPSHOT}, from `live`. */
export function testRuntimeEnvironment(live: Readonly<Record<string, string | undefined>> = process.env, platform?: NodeJS.Platform): RuntimeEnvironment {
  return composeRuntimeEnvironment({ policy: {}, snapshot: { status: TEST_LOGIN_SHELL_SNAPSHOT.status, env: live }, windowsLogon: testWindowsLogonRegistry(live), live, ...(platform === undefined ? {} : { platform }) });
}

/** The `env` of {@link testRuntimeEnvironment}. */
export function testRuntimeEnv(live: Readonly<Record<string, string | undefined>> = process.env, platform?: NodeJS.Platform): Record<string, string> {
  return testRuntimeEnvironment(live, platform).env;
}
