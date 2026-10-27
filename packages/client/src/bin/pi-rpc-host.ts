import { extractPiConfigDigest, readPiHostConfig } from '../adapters/pi/runtime-host-binding';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { getAgentDir, type CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import { MODEL_THINKING_LEVELS } from '@earendil-works/pi-ai/providers/model-schema';
import { PI_RPC_IPC_KEY_MARKER, receiveLauncherCredential } from '../adapters/pi/launcher-credential';
import { PROVIDER_CREDENTIAL_ENV_DENY_NAMES } from '../adapters/provider-credential-environment';
import { runPiSessionRuntime } from './pi-session-runtime';
export { openPiRpcSession } from './pi-session-runtime';
import { webExtension, subagentsExtension } from './pi-extension-factories.js';
import { bundledAssetRoot, verifyTodoLocaleAssets } from '../adapters/pi/todo-locale-assets';
import { createByokMcpExtension } from '../adapters/pi/mcp-extension';
import { parseTaskScopedMcpConfig, type TaskScopedMcpConfig } from '../adapters/pi/mcp-server-pool';
import { parsePiAgentToolPolicy, piAgentNativeToolOptions, type PiAgentToolPolicy } from '../adapters/pi/agent-tool-policy';

const CREDENTIAL_SOURCES = ['pi-auth-store', 'keys-profile'] as const;

export interface PiRpcHostConfig {
  readonly format: 'byok.pi.rpc-launch';
  readonly version: 6;
  /**
   * `keys-profile`: the keys launcher parents this host, and the provider key
   * arrives over its private IPC channel. `pi-auth-store`: the device's own
   * Pi auth store is the credential, and no custody channel may exist.
   */
  readonly credentialSource: (typeof CREDENTIAL_SOURCES)[number];
  /** The session cwd. */
  readonly cwd: string;
  readonly agentToolPolicy: PiAgentToolPolicy;
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
  const keys = ['format', 'version', 'credentialSource', 'cwd', 'mcp', 'agentToolPolicy'];
  if (Object.keys(raw).some((key) => !keys.includes(key)) || keys.some((key) => !(key in raw))) {
    fail('config must contain exactly format, version, credentialSource, cwd, mcp, agentToolPolicy');
  }
  if (raw.format !== 'byok.pi.rpc-launch' || raw.version !== 6) fail('unsupported config format/version');
  const credentialSource = raw.credentialSource;
  if (typeof credentialSource !== 'string' || !(CREDENTIAL_SOURCES as readonly string[]).includes(credentialSource)) {
    fail(`config.credentialSource must be one of [${CREDENTIAL_SOURCES.join(', ')}]`);
  }
  if (typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd) || resolve(raw.cwd) !== raw.cwd) {
    fail('config.cwd must be a normalized absolute path');
  }
  const mcp = parseTaskScopedMcpConfig(raw.mcp, fail);
  return {
    format: 'byok.pi.rpc-launch', version: 6,
    credentialSource: credentialSource as PiRpcHostConfig['credentialSource'], cwd: raw.cwd, mcp,
    agentToolPolicy: parsePiAgentToolPolicy(raw.agentToolPolicy),
  };
}

/** The `apiKey` the launcher-written projection declares for `provider`; never a secret. */
function projectedApiKey(provider: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(getAgentDir(), 'models.json'), 'utf8'));
  } catch {
    fail('keys-profile launch requires the launcher-written provider projection');
  }
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!record(parsed) || !record(parsed.providers) || !Object.hasOwn(parsed.providers, provider)) {
    fail('provider projection does not declare the launcher-bound provider');
  }
  const entry = parsed.providers[provider];
  if (!record(entry)) fail('provider projection entry must be an object');
  return entry.apiKey;
}

/**
 * The keys-profile custody sequence, as the durable worker runs it: refuse a
 * launch environment that carries a provider key, take the key over the
 * launcher's private IPC channel, and require that channel closed before any
 * extension, tool or session exists. The key is returned for Pi's in-memory
 * auth overlay only; it is never written to `process.env`, which every Pi
 * tool shell copies.
 */
async function receiveKeysProfileCredential(args: PiRpcHostArgs): Promise<{ provider: string; apiKey: string } | undefined> {
  if (args.provider === undefined) fail('keys-profile launch requires the launcher-bound --provider');
  if (PROVIDER_CREDENTIAL_ENV_DENY_NAMES.some((name) => Object.hasOwn(process.env, name))) {
    fail('keys-profile credential environment refused');
  }
  const projected = projectedApiKey(args.provider);
  const key = await receiveLauncherCredential('rpc', args.configDigest);
  if (process.connected) fail('rpc custody IPC still connected before tool construction');
  // The launcher delivers a key exactly for a profile that projects the IPC
  // marker; a keyless profile projects its fixed non-secret placeholder.
  if ((projected === PI_RPC_IPC_KEY_MARKER) !== (key !== undefined)) {
    fail('launcher credential does not match the provider projection');
  }
  return key === undefined ? undefined : { provider: args.provider, apiKey: key };
}

export function parsePiRpcHostArgs(
  argv: readonly string[], reject: (message: string) => never = fail,
): PiRpcHostArgs {
  const owned = extractPiConfigDigest(argv, reject);
  argv = owned.args;
  const values = new Map<string, string>();
  const valued = new Set(['--config', '--mode', '--session', '--provider', '--model', '--thinking']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (values.has(flag)) reject(`duplicate argument ${flag}`);
    if (!valued.has(flag)) reject(`unsupported argument ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) reject(`${flag} requires a value`);
    values.set(flag, value);
  }
  const configPath = values.get('--config');
  if (!configPath || !isAbsolute(configPath)) reject('--config must be an absolute path');
  if (values.get('--mode') !== 'rpc') reject('--mode rpc is required');
  const thinking = values.get('--thinking');
  // Pi's own level list; `@byok-sdk/keys` generates its `PI_THINKING_LEVELS` from the same pinned pi-ai.
  if (thinking !== undefined && !(MODEL_THINKING_LEVELS as readonly string[]).includes(thinking)) {
    reject('invalid --thinking level');
  }
  if (values.has('--provider') && !values.has('--model')) reject('--provider requires --model');
  return {
    configPath, configDigest: owned.digest,
    session: values.get('--session'), provider: values.get('--provider'), model: values.get('--model'),
    thinking: thinking as ThinkingLevel | undefined,
  };
}

/**
 * `packaging` is `bundled` when a single-file product re-enters through the
 * SDK-reserved helper; its assets then live in its Pi asset root.
 */
export async function runPiRpcHost(argv: readonly string[], packaging: 'installed' | 'bundled' = 'installed'): Promise<void> {
  const args = parsePiRpcHostArgs(argv, failUsage);
  const config = parsePiRpcHostConfig(readPiHostConfig(args.configPath, args.configDigest));
  let providerApiKey: { provider: string; apiKey: string } | undefined;
  let sessionDir: string | undefined;
  if (config.credentialSource === 'keys-profile') {
    providerApiKey = await receiveKeysProfileCredential(args);
    // Keys validates and owns this launch value. Pi's session API does not
    // read this env name; its default uses the disposable agent projection.
    sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR;
    if (!sessionDir || !isAbsolute(sessionDir) || /[\u0000\r\n]/u.test(sessionDir)) {
      fail('keys-profile launch requires an absolute single-line session directory');
    }
  }
  else if (process.connected) fail('an undeclared custody IPC channel is open');
  const policy = config.agentToolPolicy;
  const extensionNames = policy.extensions === 'inherit' ? ['web', 'subagent', 'todo'] : policy.extensions;
  const extensionFactories = [
    ...(extensionNames.includes('web') ? [webExtension] : []),
    createByokMcpExtension(config.mcp),
    ...(extensionNames.includes('subagent') ? [subagentsExtension] : []),
  ];
  if (extensionNames.includes('todo')) {
    const localeAnchor = packaging === 'bundled' ? verifyTodoLocaleAssets(bundledAssetRoot) : verifyTodoLocaleAssets();
    const { createTodoExtension } = await import('#byok-pi-todo-runtime');
    extensionFactories.push(createTodoExtension(localeAnchor));
  }
  let resourceAgentDir: string | undefined;
  if (policy.userContext === 'excluded') {
    resourceAgentDir = join(dirname(args.configPath), 'pi-agent-resources');
    // A fresh directory owned by this launch; never copy user resources into it.
    mkdirSync(resourceAgentDir, { mode: 0o700 });
  }
  await runPiSessionRuntime({
    cwd: config.cwd, session: args.session, sessionDir,
    provider: args.provider, model: args.model, thinking: args.thinking,
    ...piAgentNativeToolOptions(policy),
    ...(policy.builtinTools === 'inherit' ? {} : { agentBuiltinTools: policy.builtinTools }),
    ...(resourceAgentDir === undefined ? {} : { resourceAgentDir }),
    resourceLoaderOptions: {
      extensionFactories,
      ...(policy.userContext === 'excluded' ? {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      } : {}),
    },
    ...(providerApiKey === undefined ? {} : { providerApiKey }),
    initialModel: 'required', label: 'byok-pi-rpc', reject: fail,
  });
}
