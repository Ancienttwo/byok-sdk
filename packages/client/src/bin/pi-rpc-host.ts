import { parseRuntimeDescendantPlan, type RuntimeDescendantPlanV1 } from '../adapters/pi/runtime-descendant-plan';
import { extractPiConfigDigest, readPiHostConfig, requirePiHostBinding, verifyPiHostBinding } from '../adapters/pi/runtime-host-binding';
import type { ImplementationSpawnBindingV1 } from '@byok-sdk/implementation-identity';
import { isAbsolute, resolve } from 'node:path';
import { PermissionPolicySchema, type PermissionPolicy } from '@byok-sdk/protocol';
import type { CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import { runPiSessionRuntime } from './pi-session-runtime';
export { openPiRpcSession } from './pi-session-runtime';
import { webExtension, subagentsExtension } from './pi-extension-factories.js';
import { verifyTodoLocaleAssets } from '../adapters/pi/todo-locale-assets';
import { createByokMcpExtension } from '../adapters/pi/mcp-extension';
import { createByokSubagentsPolicyExtension } from '../adapters/pi/subagents-policy-extension';
import { parseTaskScopedMcpConfig, type TaskScopedMcpConfig } from '../adapters/pi/mcp-server-pool';
import { mapPermissionPolicyToPiArgs } from '../adapters/pi/permission-mapping';
import { loaderEnvInjections } from '../daemon/tool-implementation-identity';

export interface PiRpcHostConfig {
  readonly format: 'byok.pi.rpc-launch';
  readonly version: 2;
  readonly binding: ImplementationSpawnBindingV1;
  readonly descendantPlan: RuntimeDescendantPlanV1 | null;
  /** Authorized session cwd, independent of the sealed process cwd. */
  readonly cwd: string;
  readonly mcp: TaskScopedMcpConfig;
  readonly policy: PermissionPolicy;
}

type ThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>;
interface PiRpcHostArgs {
  configPath: string;
  configDigest: string;
  session?: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  excludeTools?: string[];
  noTools?: 'all';
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
  const keys = ['format', 'version', 'binding', 'descendantPlan', 'cwd', 'mcp', 'policy'];
  if (Object.keys(raw).some((key) => !keys.includes(key)) || keys.some((key) => !(key in raw))) {
    fail('config must contain exactly format, version, binding, descendantPlan, cwd, mcp, policy');
  }
  if (raw.format !== 'byok.pi.rpc-launch' || raw.version !== 2) fail('unsupported config format/version');
  if (typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd) || resolve(raw.cwd) !== raw.cwd) {
    fail('config.cwd must be a normalized absolute path');
  }
  const policy = PermissionPolicySchema.safeParse(raw.policy);
  if (!policy.success) fail(`invalid policy: ${policy.error.message}`);
  const mapping = mapPermissionPolicyToPiArgs(policy.data);
  if (!mapping.ok) fail(mapping.reason!);
  const mcp = parseTaskScopedMcpConfig(raw.mcp, fail);
  if (mcp.permissionMode !== policy.data.mode) fail('MCP permissionMode differs from policy.mode');
  const binding = requirePiHostBinding(raw.binding);
  let descendantPlan: RuntimeDescendantPlanV1 | null;
  try {
    descendantPlan = parseRuntimeDescendantPlan(raw.descendantPlan, 'pi-rpc', raw.binding as ImplementationSpawnBindingV1);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  return { format: 'byok.pi.rpc-launch', version: 2, binding, descendantPlan, cwd: raw.cwd, mcp, policy: policy.data };
}

export function parsePiRpcHostArgs(
  argv: readonly string[], reject: (message: string) => never = fail,
): PiRpcHostArgs {
  const owned = extractPiConfigDigest(argv, reject);
  argv = owned.args;
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valued = new Set(['--config', '--mode', '--session', '--provider', '--model', '--thinking', '--tools', '--exclude-tools']);
  const boolean = new Set(['--no-tools', '--no-skills', '--no-extensions']);
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
  const list = (flag: string): string[] | undefined => {
    const value = values.get(flag);
    if (value === undefined) return undefined;
    const tools = value.split(',').map((tool) => tool.trim());
    if (tools.some((tool) => tool.length === 0)) reject(`${flag} contains an empty tool name`);
    return tools;
  };
  return {
    configPath, configDigest: owned.digest,
    session: values.get('--session'), provider: values.get('--provider'), model: values.get('--model'),
    thinking: thinking as ThinkingLevel | undefined,
    tools: list('--tools'), excludeTools: list('--exclude-tools'),
    noTools: flags.has('--no-tools') ? 'all' : undefined,
  };
}

export async function runPiRpcHost(argv: readonly string[]): Promise<void> {
  if (process.execArgv.length > 0) failUsage('refusing non-empty interpreter argv');
  const injected = loaderEnvInjections(process.env);
  if (injected.length > 0) failUsage(`refusing loader environment variables: ${injected.join(', ')}`);
  const args = parsePiRpcHostArgs(argv, failUsage);
  const config = parsePiRpcHostConfig(readPiHostConfig(args.configPath, args.configDigest));
  await verifyPiHostBinding(config.binding, 'pi-rpc', failUsage);
  // The policy is the single authority. Delegated tool flags must be its exact
  // projection, including absence; a stale or widened projection is refused.
  const mapping = mapPermissionPolicyToPiArgs(config.policy);
  const expected = parsePiRpcHostArgs([`--config-digest=${args.configDigest}`, '--config', args.configPath, '--mode', 'rpc', ...mapping.args], failUsage);
  if (JSON.stringify([args.tools, args.excludeTools, args.noTools]) !== JSON.stringify([expected.tools, expected.excludeTools, expected.noTools])) {
    fail('delegated tool flags differ from policy');
  }
  const mode = config.policy.mode;
  if (mode !== 'auto' && mode !== 'readonly') fail('unsupported permission mode');
  const localeAnchor = verifyTodoLocaleAssets(config.binding);
  const { createTodoExtension } = await import('#byok-pi-todo-runtime');
  const todoExtension = createTodoExtension(localeAnchor);
  await runPiSessionRuntime({
    cwd: config.cwd, session: args.session,
    provider: args.provider, model: args.model, thinking: args.thinking,
    tools: args.tools, excludeTools: args.excludeTools, noTools: args.noTools,
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true,
      extensionFactories: [webExtension, createByokMcpExtension(config.mcp),
        createByokSubagentsPolicyExtension(mode), subagentsExtension, todoExtension],
    },
    initialModel: 'required', label: 'byok-pi-rpc', reject: fail,
  });
}
