import { parsePiAgentResources } from '../adapters/pi/agent-resources';
import { extractPiConfigDigest, readPiHostConfig } from '../adapters/pi/runtime-host-binding';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir, type CreateAgentSessionOptions } from '@earendil-works/pi-coding-agent';
import { MODEL_THINKING_LEVELS } from '@earendil-works/pi-ai/providers/model-schema';
import { PI_RPC_IPC_KEY_MARKER, receiveLauncherCredential } from '../adapters/pi/launcher-credential';
import { PROVIDER_CREDENTIAL_ENV_DENY_NAMES } from '../adapters/provider-credential-environment';
import { runPiSessionRuntime } from './pi-session-runtime';
export { openPiRpcSession } from './pi-session-runtime';
import { webExtension } from './pi-extension-factories.js';
import { loadPiSubagentsExtensions } from '../adapters/pi/subagents';
import { bundledAssetRoot, verifyTodoLocaleAssets } from '../adapters/pi/todo-locale-assets';
import { createByokMcpExtension } from '../adapters/pi/mcp-extension';
import { parseTaskScopedMcpConfig, type TaskScopedMcpConfig } from '../adapters/pi/mcp-server-pool';
import { parseToolAuthorizationIpcConfig, setToolAuthorizationGateEnv, type ToolAuthorizationIpcConfig } from '../tool-authorization-ipc';
import { createPiToolAuthorizationHook } from '../adapters/pi/tool-authorization-hook';
import { parseSerializedFileScopeGrant, verifySerializedFileScopeGrant, type SerializedFileScopeGrant } from '../file-scope-launch';
import { createPiFileScopeExtension } from '../adapters/pi/file-scope-extension';
import { assertPiFileScopeRegistry } from '../adapters/pi/file-scope-registry';

declare const __BYOK_PI_SUBAGENTS__: boolean;

const CREDENTIAL_SOURCES = ['pi-auth-store', 'keys-profile'] as const;

export interface PiRpcHostConfig {
  readonly format: 'byok.pi.rpc-launch';
  readonly version: 9;
  /**
   * `keys-profile`: the keys launcher parents this host, and the provider key
   * arrives over its private IPC channel. `pi-auth-store`: the device's own
   * Pi auth store is the credential, and no custody channel may exist.
   */
  readonly credentialSource: (typeof CREDENTIAL_SOURCES)[number];
  /** The session cwd. */
  readonly cwd: string;
  /** `excluded` isolates user resources; it never removes a tool. */
  readonly agentUserContext: 'inherit' | 'excluded';
  readonly agentSkillPaths: readonly string[];
  readonly agentExtensionPaths: readonly string[];
  /** The `auto` gate for this session and its native Pi subagents; null in `all`. */
  readonly toolAuthorization: ToolAuthorizationIpcConfig | null;
  /**
   * The daemon-resolved file scope, or null for an inherit launch. When
   * present this session registers the six SDK scoped file tools
   * (read/write/edit/find/grep/ls), which shadow the native Pi tools, and
   * refuses to start if the registered loadout drifts (v9, #1061).
   */
  readonly fileScope: SerializedFileScopeGrant | null;
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
  const keys = ['format', 'version', 'credentialSource', 'cwd', 'mcp', 'agentUserContext', 'agentSkillPaths', 'agentExtensionPaths', 'toolAuthorization', 'fileScope'];
  if (Object.keys(raw).some((key) => !keys.includes(key)) || keys.some((key) => !(key in raw))) {
    fail(`config must contain exactly ${keys.join(', ')}`);
  }
  if (raw.format !== 'byok.pi.rpc-launch' || raw.version !== 9) fail('unsupported config format/version');
  const resources = parsePiAgentResources({ userContext: raw.agentUserContext, skillPaths: raw.agentSkillPaths, extensionPaths: raw.agentExtensionPaths });
  const credentialSource = raw.credentialSource;
  if (typeof credentialSource !== 'string' || !(CREDENTIAL_SOURCES as readonly string[]).includes(credentialSource)) {
    fail(`config.credentialSource must be one of [${CREDENTIAL_SOURCES.join(', ')}]`);
  }
  if (typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd) || resolve(raw.cwd) !== raw.cwd) {
    fail('config.cwd must be a normalized absolute path');
  }
  const mcp = parseTaskScopedMcpConfig(raw.mcp, fail);
  return {
    format: 'byok.pi.rpc-launch', version: 9,
    credentialSource: credentialSource as PiRpcHostConfig['credentialSource'], cwd: raw.cwd, mcp,
    agentUserContext: resources.userContext,
    agentSkillPaths: resources.skillPaths,
    agentExtensionPaths: resources.extensionPaths,
    toolAuthorization: raw.toolAuthorization === null ? null : parseToolAuthorizationIpcConfig(raw.toolAuthorization),
    fileScope: raw.fileScope === null ? null : parseSerializedFileScopeGrant(raw.fileScope, fail),
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
  // #1061 D14: re-resolve every serialized root before an extension or
  // session exists. A missing/replaced/symlinked root, a changed dev+ino, or
  // a Windows/unknown platform fails here; the host never continues unscoped.
  let fileScope: Awaited<ReturnType<typeof verifySerializedFileScopeGrant>> | undefined;
  if (config.fileScope !== null) {
    try {
      fileScope = await verifySerializedFileScopeGrant(config.fileScope);
    } catch (error) {
      fail('file scope verification failed: ' + (error instanceof Error ? error.message : String(error)));
    }
  }
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
  const localeAnchor = packaging === 'bundled' ? verifyTodoLocaleAssets(bundledAssetRoot) : verifyTodoLocaleAssets();
  const { createTodoExtension } = await import('#byok-pi-todo-runtime');
  const extensionFactories = [webExtension, createByokMcpExtension(config.mcp)];
  // pi-subagents is an installed dependency that reads its own package files at
  // run time, so a bundled product has no subagents (the sealed build drops this
  // branch). Under keys-profile a child session opens its own model runtime and
  // would read the key marker from the projection, not the in-memory key.
  // A scoped session does not offer subagents in this slice: a
  // pi-subagents child loads its own native file tool loadout and would be an
  // unscoped bypass. Refusing to offer the tool is the honest option; a child
  // that reloads and re-verifies the same grant is a later slice.
  if (__BYOK_PI_SUBAGENTS__ && packaging === 'installed' && config.credentialSource !== 'keys-profile'
    && config.fileScope === null) {
    const gateExtension = fileURLToPath(new URL('./pi-subagent-gate.js', import.meta.url));
    extensionFactories.push(...await loadPiSubagentsExtensions(config.toolAuthorization, gateExtension));
  }
  extensionFactories.push(createTodoExtension(localeAnchor));
  if (fileScope !== undefined) {
    if (config.toolAuthorization === null) fail('file scope requires the auto tool-authorization gate');
    extensionFactories.push(createPiFileScopeExtension({ grant: fileScope, gate: config.toolAuthorization }));
  }
  // Register last: earlier handlers may rewrite the input the gate must judge.
  // The environment hands the same gate to native Pi subagent children.
  setToolAuthorizationGateEnv(config.toolAuthorization, join(dirname(args.configPath), 'tool-authorization.json'));
  if (config.toolAuthorization !== null) extensionFactories.push(createPiToolAuthorizationHook(config.toolAuthorization));
  let resourceAgentDir: string | undefined;
  if (config.agentUserContext === 'excluded') {
    resourceAgentDir = join(dirname(args.configPath), 'pi-agent-resources');
    // A fresh directory owned by this launch; never copy user resources into it.
    mkdirSync(resourceAgentDir, { mode: 0o700 });
  }
  await runPiSessionRuntime({
    cwd: config.cwd, session: args.session, sessionDir,
    provider: args.provider, model: args.model, thinking: args.thinking,
    ...(resourceAgentDir === undefined ? {} : { resourceAgentDir }),
    resourceLoaderOptions: {
      extensionFactories,
      additionalSkillPaths: [...config.agentSkillPaths],
      additionalExtensionPaths: [...config.agentExtensionPaths],
      ...(config.agentUserContext === 'excluded' ? {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      } : {}),
    },
    ...(providerApiKey === undefined ? {} : { providerApiKey }),
    ...(fileScope === undefined ? {} : {
      // All six native file tools are shadowed by SDK-owned scoped tools above.
      // The assertion refuses to prompt if any of them is still the Pi built-in.
      assertToolLoadout: (session: import('./pi-session-runtime').PiToolLoadoutSession) => assertPiFileScopeRegistry(session, {
        required: ['read', 'write', 'edit', 'find', 'grep', 'ls'],
        forbidden: [],
      }),
    }),
    initialModel: 'required', label: 'byok-pi-rpc', reject: fail,
  });
}
