import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CreateAgentSessionResult, ExtensionFactory, InlineExtension } from '@earendil-works/pi-coding-agent';
import { dependencies as clientDependencies } from '../../../package.json';
import type { ToolAuthorizationIpcConfig } from '../../tool-authorization-ipc';

// pi-subagents reads its own package files (manifest, agents, prompts, runner
// scripts) at run time, so it loads only from a package directory: the
// installed dependency, or the copy in a single-file product's Pi asset root.
// The specifiers stay opaque to bundlers: a product bundle never inlines it.
const PI_SUBAGENTS: string = 'pi-subagents';
const PI_SUBAGENTS_REQUIRED_CHILD_EXTENSIONS: string = 'pi-subagents/required-child-extensions';

/** The client's exact pi-subagents dependency, the only version an asset root may hold. */
export const PI_SUBAGENTS_PIN = `${PI_SUBAGENTS}@${clientDependencies['pi-subagents']}`;
/** Pi asset root directory of the pi-subagents package, with its runtime dependencies in its own `node_modules`. */
export const PI_SUBAGENTS_ASSET_DIR = 'pi-subagents';
/** Pi asset root directory of the SDK extensions every native child loads by path. */
export const PI_SUBAGENT_EXTENSIONS_ASSET_DIR = 'pi-subagent-extensions';
export const PI_SUBAGENT_GATE_FILE = 'pi-subagent-gate.js';
export const PI_SUBAGENT_FILE_SCOPE_FILE = 'pi-subagent-file-scope.js';

type RegisterRequiredChildExtensions = typeof import('pi-subagents/required-child-extensions').registerRequiredChildExtensions;

/** Launch-evidence id of the SDK gate in every native Pi subagent child. */
export const PI_SUBAGENT_GATE_EXTENSION_ID = 'byok-tool-authorization';
/** Stable source identity for the installed extension's resolved commands. */
export const PI_SUBAGENT_HOST_EXTENSION = 'byok-subagents';

// pi-subagents 0.87.0: delegation/refinement, model probes and watchdog
// executors (workspace LSP process and reviewer). Inventory is pinned by tests.
const CHILD_START_COMMANDS = new Set([
  'run', 'prompt-workflow', 'subagents-refine', 'subagents-check-profile',
  'subagents-refresh-provider-models', 'subagents-generate-profiles', 'subagents-watchdog',
]);

type PiCommandParser = (this: { _extensionRunner: { getCommand(name: string): void } }, text: string) => void;

/** Keep Host commands out of executor paths without a tool_call approval. */
export function refusePiSubagentHostCommands(session: CreateAgentSessionResult['session'], sources: readonly string[]): void {
  // SAFETY: Pi 1.5.0's private method owns first-space parsing. Its runtime
  // type is checked below; pin tests must re-check it on every Pi upgrade.
  const parse = (session as unknown as { _throwIfExtensionCommand?: PiCommandParser })._throwIfExtensionCommand;
  if (typeof parse !== 'function') {
    throw new Error('pi_host_command_boundary_unavailable: pinned Pi parser _throwIfExtensionCommand is unavailable');
  }
  const guarded = new WeakSet<typeof session.extensionRunner>();
  const boundary = <Args extends [string, ...unknown[]], Result>(method: (...args: Args) => Promise<Result>, expands?: (...args: Args) => boolean) => async (...args: Args): Promise<Result> => {
    // Reload replaces the runner; session replacement installs this boundary
    // through the runtime factory. Pi alone parses text and resolves aliases.
    const runner = session.extensionRunner;
    if (!guarded.has(runner)) {
      const getCommand = runner.getCommand.bind(runner);
      runner.getCommand = (name) => {
        const command = getCommand(name);
        if (command && sources.includes(command.sourceInfo.path) && CHILD_START_COMMANDS.has(command.name)) {
          throw new Error(`pi_host_command_denied: /${command.invocationName} can start a child outside launch approval; use the subagent tool`);
        }
        return command;
      };
      guarded.add(runner);
    }
    if (args[0].startsWith('/') && expands?.(...args) !== false) {
      // Resolve before prompt() can defer during agent_settled. Returning no
      // command after an allowed lookup prevents Pi's generic queue refusal;
      // the guarded real registry still throws for a denied command.
      parse.call({ _extensionRunner: { getCommand: name => { runner.getCommand(name); } } }, args[0]);
    }
    return method(...args);
  };
  session.prompt = boundary(session.prompt.bind(session), (_text, options) => options?.expandPromptTemplates !== false);
  session.steer = boundary(session.steer.bind(session));
  session.followUp = boundary(session.followUp.bind(session));
}
/** Launch-evidence id of the file-scope extension required only by a scoped parent. */
export const PI_SUBAGENT_FILE_SCOPE_EXTENSION_ID = 'byok-file-scope';

/**
 * The installed pi-subagents extension. Under the `auto` gate, the parent
 * session requires `gateExtensionPath` in every native child (foreground,
 * background, nested and resumed), and pi-subagents refuses external-cli,
 * external-job and machine runners before they start, because only native
 * children load the gate (`requireForAllRunners`).
 *
 * A file-scoped parent additionally requires the scope extension, which
 * re-resolves the same grant before registering the SDK scoped file tools. The
 * gate extension refuses the six file tools when those tools did not register,
 * so a scope extension that fails to load cannot leave an unscoped child.
 */
export async function loadPiSubagentsExtensions(
  gate: ToolAuthorizationIpcConfig | null,
  gateExtensionPath: string,
  fileScopeExtensionPath?: string,
): Promise<InlineExtension[]> {
  const { default: subagents } = await import(PI_SUBAGENTS) as typeof import('pi-subagents');
  const extension = { name: PI_SUBAGENT_HOST_EXTENSION, factory: subagents };
  if (gate === null) return [extension];
  const { registerRequiredChildExtensions } = await import(PI_SUBAGENTS_REQUIRED_CHILD_EXTENSIONS) as typeof import('pi-subagents/required-child-extensions');
  return [extension, requireChildExtensions(registerRequiredChildExtensions, gateExtensionPath, fileScopeExtensionPath)];
}

/**
 * The pi-subagents copy in a single-file product's Pi asset root, for Pi's
 * own extension loader: `extensionPath` goes to `additionalExtensionPaths`, so
 * Pi evaluates it with the Pi modules of the product bundle. The required
 * child extensions are the SDK files copied beside it. The registry of
 * required child extensions is process-global in pi-subagents, so the
 * registration imported here reaches the copy Pi loaded. A missing or foreign
 * copy fails closed.
 */
export async function loadPiSubagentsAsset(
  assetRoot: string,
  gate: ToolAuthorizationIpcConfig | null,
  fileScoped: boolean,
): Promise<{ readonly extensionPath: string; readonly factories: ExtensionFactory[] }> {
  const dir = path.join(assetRoot, PI_SUBAGENTS_ASSET_DIR);
  let manifest: { name?: unknown; version?: unknown; pi?: { extensions?: unknown }; exports?: Record<string, { default?: unknown }> };
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Error(`pi_bundled_assets_unavailable: the Pi asset root has no ${PI_SUBAGENTS_ASSET_DIR} package; rebuild it with copyPiRuntimeAssets`, { cause: error });
  }
  if (`${String(manifest.name)}@${String(manifest.version)}` !== PI_SUBAGENTS_PIN) {
    throw new Error(`pi_bundled_assets_unavailable: the Pi asset root holds ${String(manifest.name)}@${String(manifest.version)}, not ${PI_SUBAGENTS_PIN}`);
  }
  const extensions = manifest.pi?.extensions;
  const registration = manifest.exports?.['./required-child-extensions']?.default;
  if (!Array.isArray(extensions) || extensions.length !== 1 || typeof extensions[0] !== 'string' || typeof registration !== 'string') {
    throw new Error(`pi_bundled_assets_unavailable: ${PI_SUBAGENTS_PIN} in the Pi asset root has an unexpected manifest`);
  }
  const extensionPath = path.join(dir, extensions[0]);
  if (gate === null) return { extensionPath, factories: [] };
  const registrationFile = path.join(dir, registration);
  // A Node SEA compiles its main script as an embedder module, whose import()
  // loads built-in modules only (Node 25.7+, nodejs/node#61654); require(esm)
  // through createRequire is the documented file loader there. A SEA has no
  // second loader: a failed require fails the launch.
  const { registerRequiredChildExtensions } = (isNodeSea()
    ? createRequire(registrationFile)(registrationFile)
    : await import(pathToFileURL(registrationFile).href)) as typeof import('pi-subagents/required-child-extensions');
  const extensionDir = path.join(assetRoot, PI_SUBAGENT_EXTENSIONS_ASSET_DIR);
  return { extensionPath, factories: [requireChildExtensions(registerRequiredChildExtensions, path.join(extensionDir, PI_SUBAGENT_GATE_FILE),
    fileScoped ? path.join(extensionDir, PI_SUBAGENT_FILE_SCOPE_FILE) : undefined)] };
}

export function isNodeSea(): boolean {
  return process.versions.bun === undefined && process.getBuiltinModule('node:sea').isSea();
}

const HOST_SDK_GLOBAL_KEY = 'byok-sdk.pi-subagents.host-sdk';
const EXPORT_NAME = /^[A-Za-z_$][\w$]*$/u;

/**
 * pi-subagents loads the Pi SDK of its foreground children, and decides
 * whether background runs can start, from the Pi package root it finds. It
 * reads `PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT` before it searches the
 * ancestors of the entry point and the copy's own resolution. So a bundled
 * product could otherwise pick a foreign Pi installed above it. This writes a
 * package named like Pi in `dir`, a directory private to this launch. It
 * re-exports the product's own in-process Pi module and carries Pi's manifest
 * fields and no peers. Interpreter-bundle children use this bridge alone, so
 * their background runs are refused. Compiled products extend the same private
 * root with their embedded peer modules before starting background runners.
 * Returns the package root.
 */
export async function writePiSubagentsHostSdk(dir: string, assetRoot: string): Promise<string> {
  const pi = await import('@earendil-works/pi-coding-agent') as Record<string, unknown>;
  (globalThis as Record<symbol, unknown>)[Symbol.for(HOST_SDK_GLOBAL_KEY)] = pi;
  const manifest = JSON.parse(readFileSync(path.join(assetRoot, 'package.json'), 'utf8')) as { name: string; version: string; piConfig?: unknown };
  const names = Object.keys(pi).filter(name => name !== 'default' && EXPORT_NAME.test(name));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: manifest.name, version: manifest.version, type: 'module',
    ...(manifest.piConfig === undefined ? {} : { piConfig: manifest.piConfig }), exports: { '.': './index.js' } }), { flag: 'wx' });
  writeFileSync(path.join(dir, 'index.js'), [
    `const pi = globalThis[Symbol.for(${JSON.stringify(HOST_SDK_GLOBAL_KEY)})];`,
    "if (pi === undefined) throw new Error('pi_subagents_host_sdk_unavailable: this package is the Pi of one byok-sdk bundled host and loads only inside it');",
    ...names.map((name, index) => `const value${index} = pi[${JSON.stringify(name)}]; export { value${index} as ${name} };`),
    ...('default' in pi ? ['export default pi.default;'] : []),
  ].join('\n') + '\n', { flag: 'wx' });
  return dir;
}

function requireChildExtensions(
  registerRequiredChildExtensions: RegisterRequiredChildExtensions,
  gateExtensionPath: string,
  fileScopeExtensionPath: string | undefined,
): ExtensionFactory {
  return (pi) => {
    let registration: { dispose(): void } | undefined;
    const release = (): void => { registration?.dispose(); registration = undefined; };
    pi.on('session_start', (_event, context) => {
      // A replaced session has a new id; pi-subagents allows one registration per session.
      release();
      registration = registerRequiredChildExtensions({
        sessionId: context.sessionManager.getSessionId(),
        // The scope extension loads first so its tool_call precheck runs
        // before the authorization hook: an out-of-scope file call is denied,
        // never presented as an approval request. The gate stays last.
        extensions: [
          ...(fileScopeExtensionPath === undefined ? [] : [{ id: PI_SUBAGENT_FILE_SCOPE_EXTENSION_ID, path: fileScopeExtensionPath }]),
          { id: PI_SUBAGENT_GATE_EXTENSION_ID, path: gateExtensionPath },
        ],
        requireForAllRunners: true,
      });
    });
    pi.on('session_shutdown', release);
  };
}
