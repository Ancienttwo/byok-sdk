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

/**
 * The Agent-home lease writer identity of every test process (#2348): a fixed
 * machine digest, boot and PID namespace, so no test reads this machine's
 * identifier. Process start times and signals stay real, so a killed child
 * process is told from a live one. A child process that writes lease markers
 * installs it too (a `.mjs` child gets TEST_LEASE_WRITER_IDENTITY from its
 * parent), or the parent would read its markers as another host's.
 */
export const TEST_LEASE_WRITER_IDENTITY = {
  host: '0'.repeat(64),
  boot: process.platform === 'win32' ? '1700000000' : '00000000-0000-4000-8000-000000000000',
  pidNamespace: 'pid:[4026531836]',
} as const;

export async function installTestLeaseWriterProbe(): Promise<void> {
  // Imported here, not at the top: the setup file loads this module before a
  // test file's vi.mock calls apply, and a static import would bind the
  // writer's command runner to the unmocked node:child_process.
  const { setAgentHomeLeaseWriterProbeForTests, systemAgentHomeLeaseWriterProbe } = await import('../../agent-home-writer');
  setAgentHomeLeaseWriterProbeForTests({
    ...systemAgentHomeLeaseWriterProbe,
    host: async () => TEST_LEASE_WRITER_IDENTITY.host,
    boot: async () => TEST_LEASE_WRITER_IDENTITY.boot,
    pidNamespace: async () => TEST_LEASE_WRITER_IDENTITY.pidNamespace,
  });
}
