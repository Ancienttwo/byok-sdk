import { spawn } from 'node:child_process';
import { readSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SqliteProviderProfileStore } from './sqlite-profile-store';
import { ProviderProfileRefSchema, ProviderModelCapabilitySchema, type ModelProviderProfile } from './provider-profile';
import { assertExactProviderProfileBinding, type ExactProviderProfileBinding } from './provider-profile-binding';
import { assertProviderCustodyIdle, readProviderCustodySnapshot, projectKeysPiInheritedEnvironment } from './pi-provider-launcher-core';
import { assertSharedSecretValue, type SecretStore } from './secret-store';

const absolute = z.string().refine(path.isAbsolute).refine(value => !value.includes('\0'));
const Binding = z.object({ profileRef: ProviderProfileRefSchema, profileRevision: z.string().regex(/^(?:0|[1-9][0-9]{0,19})$/u),
  profileHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u), modelId: z.string().min(1), requiredCapabilities: z.array(ProviderModelCapabilitySchema).max(8) }).strict();
const RequestSchema = z.object({ profileDbPath: absolute, binding: Binding,
  launch: z.object({ hermesBin: absolute, home: absolute, role: z.enum(['gateway', 'viewer']) }).strict().optional(),
}).strict();
export type HermesProviderLauncherRequest = Omit<z.infer<typeof RequestSchema>, 'binding'> & { binding: ExactProviderProfileBinding };
export const HERMES_PROVIDER_KEY_ENV = 'SDK_HERMES_PROVIDER_KEY';

/** Non-secret Hermes custom-provider projection. Other provider/auth semantics remain unqualified. */
export function hermesProviderModel(profile: ModelProviderProfile) {
  if (!profile.enabled || profile.adapter !== 'openai_compatible' || profile.auth_mode !== 'bearer' || profile.pi_model !== undefined) {
    throw new Error('Hermes custody requires an enabled OpenAI-compatible bearer profile without Pi model overrides');
  }
  return { provider: 'custom', model: profile.model, baseUrl: profile.base_url, keyEnv: HERMES_PROVIDER_KEY_ENV };
}

/** Parse only the SDK launcher grammar; no caller-supplied Hermes arguments or environment. */
export function parseHermesProviderLauncherRequest(args: readonly string[]): HermesProviderLauncherRequest {
  if (args.length !== 2 || args[0] !== '--hermes-custody-request' || Buffer.byteLength(args[1]!, 'utf8') > 16_384) throw new Error('Invalid Hermes custody request');
  return RequestSchema.parse(JSON.parse(args[1]!));
}

/**
 * Run only in a dedicated Host launcher process. Validation returns non-secret
 * model metadata. On POSIX, launch replaces this process, preserving the
 * Hermes gateway PID. Windows has no process replacement: launch starts Hermes
 * as a child with the credential in the child's environment only, resolves
 * when Hermes exits and sets `process.exitCode` to its exit code. The adapter
 * accepts a gateway below the launcher PID on Windows.
 * Before it reads the credential, launch reads one byte from stdin: the
 * adapter writes it after it has adopted this process (on Windows, into its
 * kill-on-close job), so neither the key nor Hermes exists outside the owned
 * tree. End of input fails the launch. The launcher program must not read
 * stdin itself.
 * The Host supplies its account-scoped store here, never in the daemon.
 */
export async function runHermesProviderLauncher(request: HermesProviderLauncherRequest, host: { createSecretStore(): SecretStore }): Promise<void> {
  const options = RequestSchema.parse(request);
  if (process.platform !== 'win32' && typeof process.execve !== 'function') throw new Error('Hermes custody requires POSIX Node process replacement');
  const profiles = new SqliteProviderProfileStore({ path: options.profileDbPath, readOnly: true });
  let environment: Record<string, string> | undefined;
  try {
    const profile = await profiles.get(options.binding.profileRef);
    if (!profile) throw new Error('Hermes provider profile is missing');
    assertExactProviderProfileBinding(profile, options.binding);
    const model = hermesProviderModel(profile);
    if (!options.launch) {
      await assertProviderCustodyIdle({ profiles, profile });
      process.stdout.write(`${JSON.stringify(model)}\n`);
      return;
    }
    if (readSync(0, Buffer.alloc(1), 0, 1, null) !== 1) throw new Error('Hermes launcher was not adopted');
    const secret = await readProviderCustodySnapshot({ profiles, profile, createSecretStore: host.createSecretStore });
    if (!secret) throw new Error('Hermes provider credential unavailable');
    assertSharedSecretValue(secret);
    environment = projectKeysPiInheritedEnvironment(process.env);
    delete environment.PI_PACKAGE_DIR;
    environment.HERMES_HOME = options.launch.home;
    environment[HERMES_PROVIDER_KEY_ENV] = secret;
  } finally { await profiles.close(); }
  const launch = options.launch!;
  const args = launch.role === 'gateway' ? ['gateway', 'run', '--quiet', '--external-supervisor', '--force'] : ['--yolo', 'acp'];
  if (process.platform === 'win32') {
    const child = spawn(launch.hermesBin, args, { env: environment, stdio: 'inherit', windowsHide: true });
    environment = undefined;
    await new Promise<void>((resolve, reject) => {
      child.once('error', () => reject(new Error('Hermes launch failed')));
      child.once('exit', (code) => { process.exitCode = code ?? 1; resolve(); });
    });
    return;
  }
  process.execve!(launch.hermesBin, [launch.hermesBin, ...args], environment!);
  throw new Error('Hermes process replacement returned unexpectedly');
}
