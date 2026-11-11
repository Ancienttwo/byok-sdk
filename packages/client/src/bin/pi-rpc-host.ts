import { parsePiAgentResources } from '../adapters/pi/agent-resources.js';
import { extractPiConfigDigest, readPiHostConfig } from '../adapters/pi/runtime-host-binding.js';
import { applyPiHostNetworkDefaults } from './pi-host-network-defaults.js';
import { readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAgentDir, type CreateAgentSessionOptions, type InlineExtension } from '@earendil-works/pi-coding-agent';
import { MODEL_THINKING_LEVELS } from '@earendil-works/pi-ai/providers/model-schema';
import { PI_RPC_IPC_KEY_MARKER, receiveLauncherCredential } from '../adapters/pi/launcher-credential.js';
import { PROVIDER_CREDENTIAL_ENV_DENY_NAMES } from '../adapters/provider-credential-environment.js';
import { runPiSessionRuntime } from './pi-session-runtime.js';
export { openPiRpcSession } from './pi-session-runtime.js';
import { webExtension } from './pi-extension-factories.js';
import { loadPiSubagentsAsset, loadPiSubagentsExtensions, writePiSubagentsHostSdk, refusePiSubagentHostCommands, PI_SUBAGENT_HOST_EXTENSION } from '../adapters/pi/subagents.js';
import { bundledAssetRoot, verifyTodoLocaleAssets } from '../adapters/pi/todo-locale-assets.js';
import { BUNDLED_SUBAGENT_DIR, pinBunSubagentAssets, prepareBundledSubagents, refuseBundledBackground } from '../adapters/pi/bundled-subagent-runtime.js';
import { createByokMcpExtension } from '../adapters/pi/mcp-extension.js';
import { parseTaskScopedMcpConfig, type TaskScopedMcpConfig } from '../adapters/pi/mcp-server-pool.js';
import { parseToolAuthorizationIpcConfig, setToolAuthorizationGateEnv, type ToolAuthorizationIpcConfig } from '../tool-authorization-ipc.js';
import { createPiToolAuthorizationHook } from '../adapters/pi/tool-authorization-hook.js';
import { parseSerializedFileScopeGrant, verifySerializedFileScopeGrant, type SerializedFileScopeGrant } from '../file-scope-launch.js';
import { createPiFileScopeExtension } from '../adapters/pi/file-scope-extension.js';
import { assertPiFileScopeRegistry } from '../adapters/pi/file-scope-registry.js';
import { createPiMemoryLane, assertPiMemoryToolLoadout } from './pi-memory-lane.js';

const CREDENTIAL_SOURCES = ['pi-auth-store', 'keys-profile'] as const;

export { parsePiHostReadyEvent, type PiHostReadyEvent } from '../adapters/pi/host-ready.js';
import type { PiHostReadyEvent } from '../adapters/pi/host-ready.js';

/** Readiness receipt consumed only by memory-lane admission. */
export function createPiHostReady(session: { readonly sessionId: string }): PiHostReadyEvent {
  return Object.freeze({ type: 'byok_host_ready', sessionId: session.sessionId });
}

export interface PiRpcHostConfig {
  readonly format: 'byok.pi.rpc-launch';
  readonly version: 11;
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
  /** The lease's canonical home under `excluded`, else null: only its instruction files load. */
  readonly agentHome: string | null;
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

/** The same at-or-below test as Claude's Agent user-context exclusion. */
function within(home: string, path: string): boolean {
  const rel = relative(home, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** A callable host owns CLI usage errors; thin bins must not reformat them. */
function failUsage(message: string): never {
  process.stderr.write(`byok-pi-rpc: ${message}\n`);
  process.exit(78); // EX_CONFIG, identical to the prepared helper contract.
}

export function parsePiRpcHostConfig(value: unknown): PiRpcHostConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('config must be an object');
  const raw = value as Record<string, unknown>;
  const keys = ['format', 'version', 'credentialSource', 'cwd', 'mcp', 'agentUserContext', 'agentHome', 'agentSkillPaths', 'agentExtensionPaths', 'toolAuthorization', 'fileScope'];
  if (Object.keys(raw).some((key) => !keys.includes(key)) || keys.some((key) => !(key in raw))) {
    fail(`config must contain exactly ${keys.join(', ')}`);
  }
  if (raw.format !== 'byok.pi.rpc-launch' || raw.version !== 11) fail('unsupported config format/version');
  const resources = parsePiAgentResources({ agentUserContext: raw.agentUserContext, skillPaths: raw.agentSkillPaths, extensionPaths: raw.agentExtensionPaths });
  const credentialSource = raw.credentialSource;
  if (typeof credentialSource !== 'string' || !(CREDENTIAL_SOURCES as readonly string[]).includes(credentialSource)) {
    fail(`config.credentialSource must be one of [${CREDENTIAL_SOURCES.join(', ')}]`);
  }
  if (typeof raw.cwd !== 'string' || !isAbsolute(raw.cwd) || resolve(raw.cwd) !== raw.cwd) {
    fail('config.cwd must be a normalized absolute path');
  }
  const agentHome = raw.agentHome;
  if (resources.agentUserContext === 'excluded'
    ? typeof agentHome !== 'string' || !isAbsolute(agentHome) || resolve(agentHome) !== agentHome
    : agentHome !== null) {
    fail('config.agentHome must be a normalized absolute path under excluded user context and null otherwise');
  }
  const mcp = parseTaskScopedMcpConfig(raw.mcp, fail);
  const fileScope = raw.fileScope === null ? null : parseSerializedFileScopeGrant(raw.fileScope, fail);
  if (fileScope?.mode === 'memory' && (resources.agentUserContext !== 'excluded'
    || agentHome !== raw.cwd || fileScope.home.path !== raw.cwd
    || resources.skillPaths.length !== 0 || resources.extensionPaths.length !== 0
    || raw.toolAuthorization !== null || Object.keys(mcp.mcpServers).length !== 0
    || Object.keys(mcp.mcpEnv).length !== 0 || Object.keys(mcp.observation).length !== 0)) {
    fail('memory lane requires only its Agent home and no resource or approval grants');
  }
  return {
    format: 'byok.pi.rpc-launch', version: 11,
    credentialSource: credentialSource as PiRpcHostConfig['credentialSource'], cwd: raw.cwd, mcp,
    agentUserContext: resources.agentUserContext,
    agentHome: agentHome as string | null,
    agentSkillPaths: resources.skillPaths,
    agentExtensionPaths: resources.extensionPaths,
    toolAuthorization: raw.toolAuthorization === null ? null : parseToolAuthorizationIpcConfig(raw.toolAuthorization),
    fileScope,
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
  applyPiHostNetworkDefaults();
  // Capture before Pi redirects ordinary stdout to stderr. Replacements keep
  // this same JSONL writer, so their ready event remains on the RPC channel.
  const writeHostFrame = process.stdout.write.bind(process.stdout);
  const ready = (session: { readonly sessionId: string }): void => {
    writeHostFrame(JSON.stringify(createPiHostReady(session)) + '\n');
  };
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
  if (fileScope?.mode === 'memory') {
    if (args.session !== undefined) fail('memory lane cannot resume a session');
    const memoryLane = createPiMemoryLane({ grant: fileScope });
    const resourceAgentDir = join(dirname(args.configPath), 'pi-agent-resources');
    mkdirSync(resourceAgentDir, { mode: 0o700 });
    await runPiSessionRuntime({
      cwd: config.cwd, credentialSource: config.credentialSource, provider: args.provider, model: args.model, thinking: args.thinking,
      resourceAgentDir, memoryLane, ...memoryLane.toolOptions,
      resourceLoaderOptions: memoryLane.resourceLoaderOptions,
      ...(providerApiKey === undefined ? {} : { providerApiKey }),
      assertToolLoadout: assertPiMemoryToolLoadout,
      onSessionReady: ready,
      initialModel: 'required', label: 'byok-pi-rpc', reject: fail,
    });
    return;
  }
  const localeAnchor = packaging === 'bundled' ? verifyTodoLocaleAssets(bundledAssetRoot) : verifyTodoLocaleAssets();
  const { createTodoExtension } = await import('#byok-pi-todo-runtime');
  // The bundled web access and todo are defaults for a Pi with neither. Pi
  // leaves a replaceable extension out when another extension registers one of
  // its tool, command or flag names, so the user's own install takes its place
  // instead of failing the launch with a name conflict (#1295).
  const extensionFactories: InlineExtension[] = [
    { name: 'byok-web-access', factory: webExtension, replaceable: true }, createByokMcpExtension(config.mcp),
  ];
  // pi-subagents reads its own package files at run time: the installed host
  // imports the installed dependency, and a bundled product hands the copy in
  // its Pi asset root to Pi's extension loader. Under keys-profile a child session opens its own model runtime
  // and would read the key marker from the projection, not the in-memory key.
  //
  // A file-scoped parent does offer native subagents, but only through the
  // same grant: the child gate config carries the serialized grant, both child
  // extensions are required for every runner, and the scope extension
  // re-resolves every root before registering the SDK scoped file tools. The
  // gate extension refuses the six file tools when those tools did not
  // register, so an unscoped child never appears. bash/MCP/extensions remain
  // per-call approval.
  const subagentExtensionPaths: string[] = [];
  if (config.credentialSource !== 'keys-profile') {
    const fileScoped = config.fileScope !== null && config.toolAuthorization !== null;
    if (packaging === 'installed') {
      const gateExtension = fileURLToPath(new URL('./pi-subagent-gate.js', import.meta.url));
      const fileScopeExtension = fileURLToPath(new URL('./pi-subagent-file-scope.js', import.meta.url));
      extensionFactories.push(...await loadPiSubagentsExtensions(config.toolAuthorization, gateExtension, fileScoped ? fileScopeExtension : undefined));
    } else {
      const assetRoot = bundledAssetRoot();
      const bunExecutable = process.versions.bun !== undefined && /^(?:\/\$bunfs\/|B:[\\/]~BUN[\\/])/u.test(process.argv[1] ?? '');
      let subagentAssets = assetRoot;
      const trustedBun = bunExecutable ? pinBunSubagentAssets() : undefined;
      if (trustedBun !== undefined) {
        const root = join(resolve(dirname(args.configPath)), BUNDLED_SUBAGENT_DIR);
        subagentAssets = await prepareBundledSubagents(root, assetRoot, trustedBun);
      } else {
        process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = await writePiSubagentsHostSdk(join(resolve(dirname(args.configPath)), 'pi-subagents-host-sdk'), assetRoot);
        extensionFactories.push(refuseBundledBackground);
      }
      const asset = await loadPiSubagentsAsset(subagentAssets, config.toolAuthorization, fileScoped);
      subagentExtensionPaths.push(asset.extensionPath);
      extensionFactories.push(...asset.factories);
    }
  }
  extensionFactories.push({ name: 'byok-todo', factory: createTodoExtension(localeAnchor), replaceable: true });
  if (fileScope !== undefined) {
    if (config.toolAuthorization === null) fail('file scope requires the auto tool-authorization gate');
    extensionFactories.push(createPiFileScopeExtension({ grant: fileScope, gate: config.toolAuthorization }));
  }
  // Register last: earlier handlers may rewrite the input the gate must judge.
  // The environment hands the same gate to native Pi subagent children. A
  // scoped session also marks the child gate config with the serialized grant
  // and `fileScopeRequired`, so a child must re-verify it before any file tool.
  const childGate = config.toolAuthorization === null ? null : {
    ...config.toolAuthorization,
    ...(config.fileScope === null ? {} : { fileScopeRequired: true as const, fileScope: config.fileScope }),
  };
  setToolAuthorizationGateEnv(childGate, join(dirname(args.configPath), 'tool-authorization.json'));
  if (config.toolAuthorization !== null) extensionFactories.push(createPiToolAuthorizationHook(config.toolAuthorization));
  const agentHome = config.agentHome === null ? null : realpathSync(config.agentHome);
  let resourceAgentDir: string | undefined;
  if (config.agentUserContext === 'excluded') {
    resourceAgentDir = join(dirname(args.configPath), 'pi-agent-resources');
    // A fresh directory owned by this launch; never copy user resources into it.
    mkdirSync(resourceAgentDir, { mode: 0o700 });
  }
  await runPiSessionRuntime({
    cwd: config.cwd, credentialSource: config.credentialSource, session: args.session, sessionDir,
    onSessionReady: ready,
    configureSession: session => refusePiSubagentHostCommands(session, [`<inline:${PI_SUBAGENT_HOST_EXTENSION}>`, ...subagentExtensionPaths]),
    provider: args.provider, model: args.model, thinking: args.thinking,
    ...(resourceAgentDir === undefined ? {} : { resourceAgentDir }),
    resourceLoaderOptions: {
      extensionFactories,
      additionalSkillPaths: [...config.agentSkillPaths],
      additionalExtensionPaths: [...subagentExtensionPaths, ...config.agentExtensionPaths],
      ...(agentHome === null ? {} : {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
        // Only instruction files whose real path is at or below the Agent home
        // load, as for Claude; the user's and every ancestor directory's do not.
        agentsFilesOverride: ({ agentsFiles }) => ({ agentsFiles: agentsFiles.filter(file => within(agentHome, realpathSync(file.path))) }),
      }),
    },
    ...(providerApiKey === undefined ? {} : { providerApiKey }),
    ...(fileScope === undefined ? {} : {
      // All six native file tools are shadowed by SDK-owned scoped tools above.
      // The assertion refuses to prompt if any of them is still the Pi built-in.
      assertToolLoadout: (session: import('./pi-session-runtime.js').PiToolLoadoutSession) => assertPiFileScopeRegistry(session, {
        required: ['read', 'write', 'edit', 'find', 'grep', 'ls'],
        forbidden: [],
      }),
    }),
    initialModel: 'required', label: 'byok-pi-rpc', reject: fail,
  });
}
