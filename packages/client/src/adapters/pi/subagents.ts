import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
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
): Promise<ExtensionFactory[]> {
  const { default: subagents } = await import(PI_SUBAGENTS) as typeof import('pi-subagents');
  if (gate === null) return [subagents];
  const { registerRequiredChildExtensions } = await import(PI_SUBAGENTS_REQUIRED_CHILD_EXTENSIONS) as typeof import('pi-subagents/required-child-extensions');
  return [subagents, requireChildExtensions(registerRequiredChildExtensions, gateExtensionPath, fileScopeExtensionPath)];
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
  const { registerRequiredChildExtensions } = await import(pathToFileURL(path.join(dir, registration)).href) as typeof import('pi-subagents/required-child-extensions');
  const extensionDir = path.join(assetRoot, PI_SUBAGENT_EXTENSIONS_ASSET_DIR);
  return { extensionPath, factories: [requireChildExtensions(registerRequiredChildExtensions, path.join(extensionDir, PI_SUBAGENT_GATE_FILE),
    fileScoped ? path.join(extensionDir, PI_SUBAGENT_FILE_SCOPE_FILE) : undefined)] };
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
