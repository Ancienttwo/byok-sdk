import path from 'node:path';
import { assertToolImplementationBeforeSpawn, parseToolImplementationIdentity, type ToolImplementationIdentityV1 } from './identity';

import { KEYS_PI_INHERITED_ENV_NAMES, KEYS_PI_WINDOWS_ENV_NAMES } from './environment';
export { KEYS_PI_INHERITED_ENV_NAMES, KEYS_PI_WINDOWS_ENV_NAMES } from './environment';
import { CONTROLLED_PI_DIRECTORY_ENV_NAMES } from './environment';

export function projectKeysPiInheritedEnvironment(
  ambient: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const normalize = (name: string): string => platform === 'win32' ? name.toUpperCase() : name;
  const names = new Set<string>([...KEYS_PI_INHERITED_ENV_NAMES, ...(platform === 'win32' ? KEYS_PI_WINDOWS_ENV_NAMES : [])].map(normalize));
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(ambient)) {
    if (value === undefined) continue;
    const normalized = normalize(name);
    if (names.has(normalized) || normalized.startsWith('LC_') || normalized.startsWith('XDG_')) result[name] = value;
  }
  return result;
}

/** Physical projection of a client-decided launch; contains no runtime selection or credential policy. */
export interface ImplementationSpawnBindingV1 {
  readonly format: 'byok.implementation-spawn';
  readonly version: 1;
  readonly identity: ToolImplementationIdentityV1;
  readonly command: string;
  readonly entry?: string;
  readonly fixedArgv: readonly string[];
  readonly cwd: string;
  readonly envCommitments: Readonly<Record<string, string>>;
}

function absolute(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value) && path.normalize(value) === value && !/[\u0000\r\n]/u.test(value);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseImplementationSpawnBinding(value: unknown): ImplementationSpawnBindingV1 | undefined {
  if (!object(value) || Object.keys(value).some((key) => !['format', 'version', 'identity', 'command', 'entry', 'fixedArgv', 'cwd', 'envCommitments'].includes(key))) return undefined;
  if (value.format !== 'byok.implementation-spawn' || value.version !== 1 || !absolute(value.command) || !absolute(value.cwd)) return undefined;
  if (value.entry !== undefined && !absolute(value.entry)) return undefined;
  if (!Array.isArray(value.fixedArgv) || value.fixedArgv.some((arg) => typeof arg !== 'string' || arg.length === 0 || /[\u0000\r\n]/u.test(arg))) return undefined;
  if (!object(value.envCommitments) || Object.entries(value.envCommitments).some(([name, v]) => !(CONTROLLED_PI_DIRECTORY_ENV_NAMES as readonly string[]).includes(name) || !absolute(v))) return undefined;
  const identity = parseToolImplementationIdentity(value.identity);
  if (identity === undefined || (identity.kind === 'unavailable' && identity.reason !== 'resolver_unconfigured')) return undefined;
  const binding: ImplementationSpawnBindingV1 = Object.freeze({
    format: value.format, version: value.version, identity, command: value.command,
    ...(value.entry === undefined ? {} : { entry: value.entry }),
    fixedArgv: Object.freeze([...value.fixedArgv] as string[]), cwd: value.cwd,
    envCommitments: Object.freeze({ ...value.envCommitments } as Record<string, string>),
  });
  if (identity.kind === 'attested') {
    const command = identity.form === 'interpreter+bundle' ? identity.interpreter?.path : identity.installPath;
    const entry = identity.form === 'interpreter+bundle' ? identity.installPath : undefined;
    if (identity.entry !== undefined || command !== binding.command || entry !== binding.entry || identity.launchCwd !== binding.cwd) return undefined;
    if (identity.launchArgv.length !== binding.fixedArgv.length || identity.launchArgv.some((arg, index) => arg !== binding.fixedArgv[index])) return undefined;
    if (binding.envCommitments.PI_PACKAGE_DIR !== identity.assetRoot) return undefined;
  }
  return binding;
}

/** Validate exact physical inputs, then remeasure immediately before the caller's spawn. */
export async function assertImplementationSpawnBinding(
  binding: ImplementationSpawnBindingV1,
  actual: {
    readonly command: string; readonly entry?: string; readonly fixedArgv: readonly string[];
    readonly cwd: string; readonly env: Readonly<Record<string, string>>;
  },
): Promise<void> {
  if (parseImplementationSpawnBinding(binding) === undefined) throw new Error('invalid implementation spawn binding');
  if (binding.command !== actual.command || binding.entry !== actual.entry || binding.cwd !== actual.cwd
    || binding.fixedArgv.length !== actual.fixedArgv.length || binding.fixedArgv.some((arg, index) => actual.fixedArgv[index] !== arg)) {
    throw new Error('implementation launch description drift');
  }
  for (const name of CONTROLLED_PI_DIRECTORY_ENV_NAMES) {
    if (actual.env[name] !== binding.envCommitments[name]) throw new Error(`undeclared or changed Pi directory: ${name}`);
    if (process.platform === 'win32' && Object.keys(actual.env).some((key) => key !== name && key.toUpperCase() === name)) {
      throw new Error(`noncanonical Pi directory name: ${name}`);
    }
  }
  await assertToolImplementationBeforeSpawn('Pi runtime', binding.identity, actual.env);
}
