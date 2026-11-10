import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { PI_SUBAGENTS_ASSET_DIR, PI_SUBAGENT_EXTENSIONS_ASSET_DIR, writePiSubagentsHostSdk } from './subagents';

export const BUNDLED_SUBAGENT_DIR = 'pi-subagent-runtime';
export interface TrustedBunSubagentAssets {
  readonly root: string;
  verify(): void;
}

/** The executable's install location is the authority; writable runtime metadata is not. */
export function pinBunSubagentAssets(): TrustedBunSubagentAssets {
  const root = path.dirname(realpathSync(process.execPath));
  const identities = new Map<string, { dev: bigint; ino: bigint; directory: boolean; size: bigint; mtimeNs: bigint }>();
  const fail = (file: string): never => { throw new Error('pi_subagents_host_sdk_unavailable: untrusted bundled subagent asset ' + file); };
  const capture = (file: string): void => {
    const stat = lstatSync(file, { bigint: true });
    if (stat.isSymbolicLink() || realpathSync(file) !== path.resolve(file) || (!stat.isDirectory() && !stat.isFile())) fail(file);
    identities.set(file, { dev: stat.dev, ino: stat.ino, directory: stat.isDirectory(), size: stat.size, mtimeNs: stat.mtimeNs });
    if (stat.isDirectory()) for (const entry of readdirSync(file)) capture(path.join(file, entry));
  };
  capture(path.join(root, PI_SUBAGENTS_ASSET_DIR));
  capture(path.join(root, PI_SUBAGENT_EXTENSIONS_ASSET_DIR));
  return { root, verify: () => {
    for (const [file, expected] of identities) {
      const actual = lstatSync(file, { bigint: true });
      if (actual.isSymbolicLink() || realpathSync(file) !== file || actual.dev !== expected.dev || actual.ino !== expected.ino
        || actual.isDirectory() !== expected.directory || (!expected.directory && (!actual.isFile()
          || actual.size !== expected.size || actual.mtimeNs !== expected.mtimeNs))) fail(file);
    }
  } };
}

const PEERS_KEY = 'byok-sdk.pi-subagents.peers';
const HOST_KEY = 'byok-sdk.pi-subagents.host-sdk';
const BINARY_BOOTSTRAP = 'src/runs/background/binary-bootstrap.js';
const BINARY_ARGS = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-session', '--mode', 'rpc', '--extension'];
const HOST_PEER = '@earendil-works/pi-coding-agent';
const EXPORT_NAME = /^[A-Za-z_$][\w$]*$/u;

export function isNodeSea(): boolean {
  return process.versions.bun === undefined && process.getBuiltinModule('node:sea').isSea();
}

function isBunExecutable(): boolean {
  return process.versions.bun !== undefined && /^(?:\/\$bunfs\/|B:[\\/]~BUN[\\/])/u.test(process.argv[1] ?? '');
}

/** Capture peers through Pi's own loader, including its extension view of pi-ai. */
async function loadPeers(root: string): Promise<Record<string, Record<string, unknown>>> {
  (globalThis as { PI_BUNDLED_NODE?: boolean }).PI_BUNDLED_NODE = true;
  Reflect.get(globalThis, 'Headers');
  const { DefaultResourceLoader, getAgentDir } = await import('@earendil-works/pi-coding-agent');
  // TypeScript forces Pi's Jiti virtual peers. A native .mjs probe can cache
  // an import failure from the not-yet-initialized generated bridge.
  const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: getAgentDir(), noExtensions: true,
    noSkills: true, noPromptTemplates: true, additionalExtensionPaths: [path.join(root, 'host-peers.ts')] });
  await loader.reload();
  const errors = loader.getExtensions().errors;
  if (errors.length > 0) throw new Error('pi_subagents_host_sdk_unavailable: ' + JSON.stringify(errors));
  const peers = (globalThis as Record<symbol, unknown>)[Symbol.for(PEERS_KEY)] as Record<string, Record<string, unknown>> | undefined;
  if (peers === undefined) throw new Error('pi_subagents_host_sdk_unavailable: could not load the product peers');
  return peers;
}

/** Private launch data; Bun executes code from independently pinned install assets. */
export async function prepareBundledSubagents(root: string, assetRoot: string, trustedBun: TrustedBunSubagentAssets): Promise<string> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // The installed runner owns its peer catalogue; keep it and TypeBox outside client dist.
  trustedBun.verify();
  const { HOST_PEER_ALIASES: aliases } = await import(pathToFileURL(path.join(trustedBun.root,
    PI_SUBAGENTS_ASSET_DIR, 'src/runs/background/runner-aliases.js')).href) as {
    HOST_PEER_ALIASES: ReadonlyArray<{ specifier: string; optional?: boolean }>;
  };
  const specifiers = aliases.filter(alias => !alias.optional).map(alias => alias.specifier);
  writeFileSync(path.join(root, 'host-peers.ts'), [
    ...specifiers.map((specifier, index) => `import * as peer${index} from ${JSON.stringify(specifier)};`),
    `const peers = { ${specifiers.map((specifier, index) => `${JSON.stringify(specifier)}: peer${index}`).join(', ')} };`,
    `globalThis[Symbol.for(${JSON.stringify(PEERS_KEY)})] = peers;`,
    `globalThis[Symbol.for(${JSON.stringify(HOST_KEY)})] = peers[${JSON.stringify(HOST_PEER)}];`,
    'export default function captureHostPeers() {}',
  ].join('\n'), { flag: 'wx' });
  const peers = await loadPeers(root);
  await writePiSubagentsHostSdk(root, assetRoot);
  const manifests = new Map<string, { dir: string; exports: Record<string, string> }>();
  for (const [index, specifier] of specifiers.entries()) {
    if (specifier === HOST_PEER) continue;
    const parts = specifier.split('/');
    const count = specifier.startsWith('@') ? 2 : 1;
    const name = parts.slice(0, count).join('/');
    const subpath = parts.length === count ? '.' : './' + parts.slice(count).join('/');
    const dir = path.join(root, 'node_modules', name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = `peer-${index}.mjs`;
    const namespace = peers[specifier]!;
    const names = Object.keys(namespace).filter(name => name !== 'default' && EXPORT_NAME.test(name));
    writeFileSync(path.join(dir, file), [
      `const peer = globalThis[Symbol.for(${JSON.stringify(PEERS_KEY)})]?.[${JSON.stringify(specifier)}];`,
      "if (peer === undefined) throw new Error('pi_subagents_host_sdk_unavailable: a detached interpreter cannot load the product peers');",
      ...names.map((name, index) => `const value${index} = peer[${JSON.stringify(name)}]; export { value${index} as ${name} };`),
      ...('default' in namespace ? ['export default peer.default;'] : []),
    ].join('\n'), { flag: 'wx' });
    const manifest = manifests.get(name) ?? { dir, exports: {} };
    manifest.exports[subpath] = './' + file;
    manifests.set(name, manifest);
  }
  for (const [name, manifest] of manifests) {
    writeFileSync(path.join(manifest.dir, 'package.json'), JSON.stringify({ name, type: 'module', exports: manifest.exports }), { flag: 'wx' });
  }
  process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = root;
  process.env.PI_SUBAGENT_PI_BINARY = process.execPath;
  trustedBun.verify();
  return trustedBun.root;
}

/** Refuse known background requests before execution; retain upstream's normalized-mode preflight for omitted async. */
export const refuseBundledBackground: ExtensionFactory = pi => {
  const reason = isNodeSea()
    ? 'pi_background_unavailable: Node SEA cannot run background Pi subagents or workflows: pi-subagents 0.87.0 uses resolveNodeExecutable for its background runner and fork on process.execPath for its workflow supervisor; a SEA binary cannot stand in for Node. Foreground subagents work; use a Bun-compiled product for background subagents and workflows.'
    : 'pi_background_unavailable: the background runner cannot re-enter a bundle run by an interpreter. Foreground subagents work; use a Bun-compiled product for background subagents and workflows.';
  pi.on('tool_call', event => {
    if (event.toolName === 'subagent' && (event.input.async === true
      || (event.input.workflow !== undefined && event.input.async !== false))) return { block: true, reason };
  });
  pi.on('tool_result', event => {
    if (event.toolName !== 'subagent' || !event.isError) return;
    if (event.content.some(part => part.type === 'text' && part.text.includes('Background children require'))) {
      return { content: [{ type: 'text', text: reason }] };
    }
  });
};

function sameFile(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined || !path.isAbsolute(candidate) || !existsSync(candidate) || !existsSync(expected)) return false;
  const written = lstatSync(expected, { bigint: true }), actual = lstatSync(candidate, { bigint: true });
  if (!written.isFile() || !actual.isFile() || written.isSymbolicLink() || actual.isSymbolicLink()) return false;
  return realpathSync(expected) === path.resolve(expected) && realpathSync(candidate) === path.resolve(expected)
    && actual.dev === written.dev && actual.ino === written.ino;
}

/** Compiled runner prefixes are reserved: malformed or foreign re-entry fails before product dispatch. */
export async function runBundledSubagentCommand(argv: readonly string[]): Promise<boolean> {
  const bun = isBunExecutable();
  if (!bun && !isNodeSea()) return false;
  const invalid = (): never => { throw new Error('pi_background_unavailable: invalid SDK Pi runner re-entry'); };
  if (!bun) return invalid();
  const pkg = path.join(path.dirname(realpathSync(process.execPath)), PI_SUBAGENTS_ASSET_DIR);
  if (argv.length === 8 && BINARY_ARGS.every((arg, index) => argv[index] === arg)
    && sameFile(argv[7], path.join(pkg, BINARY_BOOTSTRAP))) {
    const config = process.env.PI_SUBAGENT_RUNNER_CONFIG;
    if (config === undefined || !path.isAbsolute(config)) return invalid();
    const trusted = pinBunSubagentAssets();
    (globalThis as { PI_BUNDLED_NODE?: boolean }).PI_BUNDLED_NODE = true;
    Reflect.get(globalThis, 'Headers');
    const { DefaultResourceLoader, getAgentDir } = await import('@earendil-works/pi-coding-agent');
    const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: getAgentDir(), noExtensions: true,
      noSkills: true, noPromptTemplates: true, additionalExtensionPaths: [path.join(pkg, BINARY_BOOTSTRAP)] });
    trusted.verify();
    await loader.reload();
    throw new Error('pi_subagents_host_sdk_unavailable: binary bootstrap returned without running the child');
  }
  return invalid();
}
