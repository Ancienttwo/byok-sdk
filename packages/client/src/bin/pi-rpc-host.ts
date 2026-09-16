import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { PermissionPolicySchema, type PermissionPolicy } from '@byok-sdk/protocol';
import {
  createAgentSession,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  resolveCliModel,
  runRpcMode,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
  type CreateAgentSessionRuntimeFactory,
} from '@earendil-works/pi-coding-agent';
import { webExtension, subagentsExtension, todoExtension } from './pi-extension-factories.js';
import { createByokMcpExtension } from '../adapters/pi/mcp-extension';
import { createByokSubagentsPolicyExtension } from '../adapters/pi/subagents-policy-extension';
import { parseTaskScopedMcpConfig, type TaskScopedMcpConfig } from '../adapters/pi/mcp-server-pool';
import { mapPermissionPolicyToPiArgs } from '../adapters/pi/permission-mapping';
import { loaderEnvInjections } from '../daemon/tool-implementation-identity';

export interface PiRpcHostConfig {
  readonly format: 'byok.pi.rpc-launch';
  readonly version: 1;
  /** Authorized session cwd, independent of the sealed process cwd. */
  readonly cwd: string;
  readonly mcp: TaskScopedMcpConfig;
  readonly policy: PermissionPolicy;
}

type ThinkingLevel = NonNullable<CreateAgentSessionOptions['thinkingLevel']>;
interface PiRpcHostArgs {
  configPath: string;
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

export function parsePiRpcHostConfig(value: unknown): PiRpcHostConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('config must be an object');
  const raw = value as Record<string, unknown>;
  const keys = ['format', 'version', 'cwd', 'mcp', 'policy'];
  if (Object.keys(raw).some((key) => !keys.includes(key)) || keys.some((key) => !(key in raw))) {
    fail('config must contain exactly format, version, cwd, mcp, policy');
  }
  if (raw.format !== 'byok.pi.rpc-launch' || raw.version !== 1) fail('unsupported config format/version');
  if (typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd) || resolve(raw.cwd) !== raw.cwd) {
    fail('config.cwd must be a normalized absolute path');
  }
  const policy = PermissionPolicySchema.safeParse(raw.policy);
  if (!policy.success) fail(`invalid policy: ${policy.error.message}`);
  const mapping = mapPermissionPolicyToPiArgs(policy.data);
  if (!mapping.ok) fail(mapping.reason!);
  const mcp = parseTaskScopedMcpConfig(raw.mcp, fail);
  if (mcp.permissionMode !== policy.data.mode) fail('MCP permissionMode differs from policy.mode');
  return { format: 'byok.pi.rpc-launch', version: 1, cwd: raw.cwd, mcp, policy: policy.data };
}

export function parsePiRpcHostArgs(argv: readonly string[]): PiRpcHostArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valued = new Set(['--config', '--mode', '--session', '--provider', '--model', '--thinking', '--tools', '--exclude-tools']);
  const boolean = new Set(['--no-tools', '--no-skills', '--no-extensions']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (values.has(flag) || flags.has(flag)) fail(`duplicate argument ${flag}`);
    if (boolean.has(flag)) { flags.add(flag); continue; }
    if (!valued.has(flag)) fail(`unsupported argument ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) fail(`${flag} requires a value`);
    values.set(flag, value);
  }
  const configPath = values.get('--config');
  if (!configPath || !isAbsolute(configPath)) fail('--config must be an absolute path');
  if (values.get('--mode') !== 'rpc') fail('--mode rpc is required');
  const thinking = values.get('--thinking');
  if (thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(thinking)) {
    fail('invalid --thinking level');
  }
  if (values.has('--provider') && !values.has('--model')) fail('--provider requires --model');
  const list = (flag: string): string[] | undefined => {
    const value = values.get(flag);
    if (value === undefined) return undefined;
    const tools = value.split(',').map((tool) => tool.trim());
    if (tools.some((tool) => tool.length === 0)) fail(`${flag} contains an empty tool name`);
    return tools;
  };
  return {
    configPath,
    session: values.get('--session'), provider: values.get('--provider'), model: values.get('--model'),
    thinking: thinking as ThinkingLevel | undefined,
    tools: list('--tools'), excludeTools: list('--exclude-tools'),
    noTools: flags.has('--no-tools') ? 'all' : undefined,
  };
}

/** Session ids are native minted references, never fuzzy search terms. */
export async function openPiRpcSession(cwd: string, session: string | undefined, sessionDir?: string): Promise<SessionManager> {
  if (session === undefined) return SessionManager.create(cwd, sessionDir);
  let path: string;
  if (isAbsolute(session)) {
    path = session;
  } else {
    const matches = (await SessionManager.list(cwd, sessionDir)).filter((candidate) => candidate.id === session);
    if (matches.length !== 1) fail('--session must identify exactly one existing session');
    path = matches[0]!.path;
  }
  const manager = SessionManager.open(path, sessionDir);
  if (manager.getCwd() !== cwd) fail('session header cwd differs from config.cwd');
  return manager;
}

export async function runPiRpcHost(argv: readonly string[]): Promise<void> {
  if (process.execArgv.length > 0) fail('refusing non-empty interpreter argv');
  const injected = loaderEnvInjections(process.env);
  if (injected.length > 0) fail(`refusing loader environment variables: ${injected.join(', ')}`);
  const args = parsePiRpcHostArgs(argv);
  const config = parsePiRpcHostConfig(JSON.parse(readFileSync(args.configPath, 'utf8')));
  // The policy is the single authority. Delegated tool flags must be its exact
  // projection, including absence; a stale or widened projection is refused.
  const mapping = mapPermissionPolicyToPiArgs(config.policy);
  const expected = parsePiRpcHostArgs(['--config', args.configPath, '--mode', 'rpc', ...mapping.args]);
  if (JSON.stringify([args.tools, args.excludeTools, args.noTools]) !== JSON.stringify([expected.tools, expected.excludeTools, expected.noTools])) {
    fail('delegated tool flags differ from policy');
  }
  const mode = config.policy.mode;
  if (mode !== 'auto' && mode !== 'readonly') fail('unsupported permission mode');
  const agentDir = getAgentDir();
  const initialSettings = SettingsManager.create(config.cwd, agentDir);
  const sessionManager = await openPiRpcSession(config.cwd, args.session, initialSettings.getSessionDir());
  const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
    if (cwd !== config.cwd || sessionManager.getCwd() !== config.cwd) fail('session replacement cannot change authorized cwd');
    const services = await createAgentSessionServices({
      cwd: config.cwd,
      agentDir,
      modelRuntimeSignal: AbortSignal.timeout(15_000),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        extensionFactories: [
          webExtension,
          createByokMcpExtension(config.mcp),
          createByokSubagentsPolicyExtension(mode),
          subagentsExtension,
          todoExtension,
        ],
      },
    });
    const errors = [
      ...services.diagnostics.filter((diagnostic) => diagnostic.type === 'error').map((diagnostic) => diagnostic.message),
      ...services.resourceLoader.getExtensions().errors.map(({ path, error }) => `${path}: ${error}`),
    ];
    if (errors.length > 0) fail(errors.join('\n'));
    const resolved = args.model === undefined ? undefined : resolveCliModel({
      cliProvider: args.provider, cliModel: args.model, cliThinking: args.thinking, modelRuntime: services.modelRuntime,
    });
    if (resolved?.error) fail(resolved.error);
    if (args.model !== undefined && !resolved?.model) fail('requested model could not be resolved');
    if (resolved?.warning) process.stderr.write(`byok-pi-rpc: ${resolved.warning}\n`);
    const created = await createAgentSession({
      cwd: config.cwd, agentDir, sessionManager, sessionStartEvent,
      modelRuntime: services.modelRuntime, settingsManager: services.settingsManager, resourceLoader: services.resourceLoader,
      model: resolved?.model, thinkingLevel: args.thinking ?? resolved?.thinkingLevel,
      tools: args.tools, excludeTools: args.excludeTools, noTools: args.noTools,
    });
    if (created.modelFallbackMessage) {
      await created.session.dispose();
      fail(created.modelFallbackMessage);
    }
    if (created.session.model && (args.thinking !== undefined || resolved?.thinkingLevel !== undefined)) {
      created.session.setThinkingLevel(created.session.thinkingLevel);
    }
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd: config.cwd, agentDir, sessionManager });
  await runRpcMode(runtime);
}
