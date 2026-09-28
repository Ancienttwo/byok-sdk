import path from 'node:path';
import {
  assertToolImplementationBeforeSpawn, parseToolImplementationIdentity,
  reverifySdkHelperImplementationIdentity, sdkHelperEntryFixedArgv,
  type SdkHelperEntryV1, type ToolImplementationAttestedV1,
  type ToolImplementationFsProbe, type ToolImplementationIdentityV1,
} from './identity';

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

export type PreparedAgentMemoryExecutionModeV1 = 'read' | 'read-write';

/** Exact launch shape derived from an attested finite SDK helper identity. */
export interface SdkHelperLaunchV1 {
  readonly command: string;
  readonly entry?: string;
  readonly fixedArgv: readonly string[];
  readonly cwd: string;
}

/**
 * Derive the only command shape an SDK helper identity can launch. Callers
 * never supply a command/argv selector for this subject; a non-attested or
 * retargeted record has no usable launch shape.
 */
export function sdkHelperLaunch(
  identity: ToolImplementationAttestedV1,
  helperEntry: SdkHelperEntryV1,
): SdkHelperLaunchV1 | undefined {
  const fixedArgv = sdkHelperEntryFixedArgv(helperEntry);
  if (identity.launchArgv.length !== fixedArgv.length || identity.launchArgv.some((arg, index) => arg !== fixedArgv[index])) {
    return undefined;
  }
  return Object.freeze({
    command: identity.form === 'interpreter+bundle' ? identity.interpreter!.path : identity.installPath,
    ...(identity.form === 'interpreter+bundle' ? { entry: identity.installPath } : {}),
    fixedArgv,
    cwd: identity.launchCwd,
  });
}

/** Private task binding for a finite SDK helper; it cannot be parsed as a Pi runtime binding. */
export interface SdkHelperSpawnBindingV1 extends SdkHelperLaunchV1 {
  readonly format: 'byok.sdk-helper-spawn';
  readonly version: 1;
  readonly subject: { readonly kind: 'sdk-helper'; readonly helperId: 'agent-memory' };
  readonly helperEntry: SdkHelperEntryV1;
  readonly identity: ToolImplementationIdentityV1;
  /** Required only on the execution role; selection is sealed outside this binding. */
  readonly agentMemoryMode?: PreparedAgentMemoryExecutionModeV1;
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

export function parseSdkHelperSpawnBinding(value: unknown): SdkHelperSpawnBindingV1 | undefined {
  if (!object(value) || Object.keys(value).some((key) => ![
    'format', 'version', 'subject', 'helperEntry', 'identity', 'command', 'entry', 'fixedArgv', 'cwd', 'agentMemoryMode',
  ].includes(key))) return undefined;
  if (value.format !== 'byok.sdk-helper-spawn' || value.version !== 1 || !absolute(value.command) || !absolute(value.cwd)
    || !object(value.subject) || Object.keys(value.subject).length !== 2 || value.subject.kind !== 'sdk-helper' || value.subject.helperId !== 'agent-memory') return undefined;
  if (value.entry !== undefined && !absolute(value.entry)) return undefined;
  if (value.helperEntry !== 'agent-memory-describe' && value.helperEntry !== 'agent-memory-mcp') return undefined;
  if (!Array.isArray(value.fixedArgv) || value.fixedArgv.some((arg) => typeof arg !== 'string' || arg.length === 0 || /[\u0000\r\n]/u.test(arg))) return undefined;
  const fixedArgv = sdkHelperEntryFixedArgv(value.helperEntry);
  if (value.fixedArgv.length !== fixedArgv.length || value.fixedArgv.some((arg, index) => arg !== fixedArgv[index])) return undefined;
  const identity = parseToolImplementationIdentity(value.identity);
  if (identity === undefined || identity.kind !== 'attested') return undefined;
  const expected = sdkHelperLaunch(identity, value.helperEntry);
  if (expected === undefined || expected.command !== value.command || expected.entry !== value.entry || expected.cwd !== value.cwd) return undefined;
  if (value.helperEntry === 'agent-memory-mcp') {
    if (value.agentMemoryMode !== 'read' && value.agentMemoryMode !== 'read-write') return undefined;
  } else if (value.agentMemoryMode !== undefined) return undefined;
  return Object.freeze({
    format: 'byok.sdk-helper-spawn' as const, version: 1,
    subject: Object.freeze({ kind: 'sdk-helper' as const, helperId: 'agent-memory' as const }),
    helperEntry: value.helperEntry,
    identity,
    command: value.command,
    ...(value.entry === undefined ? {} : { entry: value.entry }),
    fixedArgv: Object.freeze([...value.fixedArgv] as string[]),
    cwd: value.cwd,
    ...(value.agentMemoryMode === undefined ? {} : { agentMemoryMode: value.agentMemoryMode as PreparedAgentMemoryExecutionModeV1 }),
  });
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

/** Verify role env gates and remeasure immediately before an SDK helper spawn. */
export async function assertSdkHelperSpawnBinding(
  binding: SdkHelperSpawnBindingV1,
  actual: {
    readonly command: string; readonly entry?: string; readonly fixedArgv: readonly string[];
    readonly cwd: string; readonly env: Readonly<Record<string, string>>;
  },
  probe?: ToolImplementationFsProbe,
): Promise<void> {
  if (parseSdkHelperSpawnBinding(binding) === undefined) throw new Error('invalid SDK helper spawn binding');
  if (binding.identity.kind !== 'attested') throw new Error('invalid SDK helper spawn binding');
  if (binding.command !== actual.command || binding.entry !== actual.entry || binding.cwd !== actual.cwd
    || binding.fixedArgv.length !== actual.fixedArgv.length || binding.fixedArgv.some((arg, index) => actual.fixedArgv[index] !== arg)) {
    throw new Error('SDK helper launch description drift');
  }
  const protectedNames = ['BYOK_STORE_DIR', 'BYOK_PRODUCT_ID', 'BYOK_AGENT_MEMORY_CONTEXT', 'BYOK_PREPARED_AGENT_MEMORY_MODE'] as const;
  if (binding.helperEntry === 'agent-memory-describe') {
    if (protectedNames.some((name) => Object.hasOwn(actual.env, name))) throw new Error('SDK helper descriptor lifecycle environment forbidden');
  } else {
    if (protectedNames.some((name) => typeof actual.env[name] !== 'string' || actual.env[name]!.length === 0)
      || actual.env.BYOK_PREPARED_AGENT_MEMORY_MODE !== binding.agentMemoryMode) {
      throw new Error('SDK helper execution lifecycle environment drift');
    }
  }
  const result = await reverifySdkHelperImplementationIdentity(binding.identity, binding.helperEntry, actual.env, probe);
  if (result === 'ok') return;
  throw new Error(`SDK helper failed implementation reverification before launch: ${result.reason} (${result.subject})`);
}
