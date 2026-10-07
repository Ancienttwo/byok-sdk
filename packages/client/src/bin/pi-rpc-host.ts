import { parseRuntimeDescendantPlan, type RuntimeDescendantPlanV2 } from '../adapters/pi/runtime-descendant-plan';
import { extractPiConfigDigest, readPiHostConfig, requirePiHostBinding, verifyPiHostBinding } from '../adapters/pi/runtime-host-binding';
import type { ImplementationSpawnBindingV1 } from '@byok-sdk/implementation-identity';
import { isAbsolute, resolve } from 'node:path';
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import { runPiSessionRuntime } from './pi-session-runtime';
export { openPiRpcSession } from './pi-session-runtime';
import { webExtension, subagentsExtension } from './pi-extension-factories.js';
import { verifyTodoLocaleAssets } from '../adapters/pi/todo-locale-assets';
import { createByokMcpExtension } from '../adapters/pi/mcp-extension';
import { parseTaskScopedMcpConfig, type TaskScopedMcpConfig } from '../adapters/pi/mcp-server-pool';
import { loaderEnvInjections } from '../daemon/tool-implementation-identity';
import { configureCustodyRuntimePlan } from '../custody/external-cli-authority';

export interface PiRpcHostConfig {
  readonly format: 'byok.pi.rpc-launch';
  readonly version: 3;
  readonly binding: ImplementationSpawnBindingV1;
  readonly descendantPlan: RuntimeDescendantPlanV2 | null;
  /** Authorized session cwd, independent of the sealed process cwd. */
  readonly cwd: string;
  readonly mcp: TaskScopedMcpConfig;
}

type ThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>;
interface PiRpcHostArgs {
  configPath: string;
  configDigest: string;
  session?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
}

function fail(message: string): never {
  throw new Error(`byok-pi-rpc: ${message}`);
}

/** A callable host owns CLI usage errors; thin bins must not reformat them. */
function failUsage(message: string): never {
  process.stderr.write(`byok-pi-rpc: ${message}\n`);
  process.exit(78); // EX_CONFIG, identical to the prepared helper contract.
}

export function parsePiRpcHostConfig(value: unknown): PiRpcHostConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('config must be an object');
  const raw = value as Record<string, unknown>;
  const keys = ['format', 'version', 'binding', 'descendantPlan', 'cwd', 'mcp'];
  if (Object.keys(raw).some((key) => !keys.includes(key)) || keys.some((key) => !(key in raw))) {
    fail('config must contain exactly format, version, binding, descendantPlan, cwd, mcp');
  }
  if (raw.format !== 'byok.pi.rpc-launch' || raw.version !== 3) fail('unsupported config format/version');
  if (typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd) || resolve(raw.cwd) !== raw.cwd) {
    fail('config.cwd must be a normalized absolute path');
  }
  const mcp = parseTaskScopedMcpConfig(raw.mcp, fail);
  const binding = requirePiHostBinding(raw.binding);
  let descendantPlan: RuntimeDescendantPlanV2 | null;
  try {
    descendantPlan = parseRuntimeDescendantPlan(raw.descendantPlan, 'pi-rpc', raw.binding as ImplementationSpawnBindingV1);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return { format: 'byok.pi.rpc-launch', version: 3, binding, descendantPlan, cwd: raw.cwd, mcp };
}

export function parsePiRpcHostArgs(
  argv: readonly string[], reject: (message: string) => never = fail,
): PiRpcHostArgs {
  const owned = extractPiConfigDigest(argv, reject);
  argv = owned.args;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valued = new Set(['--config', '--mode', '--session', '--provider', '--model', '--thinking']);
  const boolean = new Set(['--no-skills', '--no-extensions']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (values.has(flag) || flags.has(flag)) reject(`duplicate argument ${flag}`);
    if (boolean.has(flag)) { flags.add(flag); continue; }
    if (!valued.has(flag)) reject(`unsupported argument ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) reject(`${flag} requires a value`);
    values.set(flag, value);
  }
  const configPath = values.get('--config');
  if (!configPath || !isAbsolute(configPath)) reject('--config must be an absolute path');
  if (values.get('--mode') !== 'rpc') reject('--mode rpc is required');
  const thinking = values.get('--thinking');
  if (thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(thinking)) {
    reject('invalid --thinking level');
  }
  if (values.has('--provider') && !values.has('--model')) reject('--provider requires --model');
  return {
    configPath, configDigest: owned.digest,
    session: values.get('--session'), provider: values.get('--provider'), model: values.get('--model'),
    thinking: thinking as ThinkingLevel | undefined,
  };
}

export async function runPiRpcHost(argv: readonly string[]): Promise<void> {
  if (process.execArgv.length > 0) failUsage('refusing non-empty interpreter argv');
  const injected = loaderEnvInjections(process.env);
  if (injected.length > 0) failUsage(`refusing loader environment variables: ${injected.join(', ')}`);
  const args = parsePiRpcHostArgs(argv, failUsage);
  const config = parsePiRpcHostConfig(readPiHostConfig(args.configPath, args.configDigest));
  await verifyPiHostBinding(config.binding, 'pi-rpc', failUsage);
  configureCustodyRuntimePlan(config.descendantPlan);
  const localeAnchor = verifyTodoLocaleAssets(config.binding);
  const { createTodoExtension } = await import('#byok-pi-todo-runtime');
  const todoExtension = createTodoExtension(localeAnchor);
  await runPiSessionRuntime({
    cwd: config.cwd, session: args.session,
    provider: args.provider, model: args.model, thinking: args.thinking,
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true,
      extensionFactories: [webExtension, createByokMcpExtension(config.mcp), subagentsExtension, todoExtension],
    },
    initialModel: 'required', label: 'byok-pi-rpc', reject: fail,
  });
}
