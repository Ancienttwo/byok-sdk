import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { PI_SUBAGENTS_ASSET_DIR, PI_SUBAGENT_EXTENSIONS_ASSET_DIR, isNodeSea, writePiSubagentsHostSdk } from './subagents.js';
import { PI_SUBAGENTS_PEERS_KEY as PEERS_KEY, piSubagentHostPeersSource } from './jiti-seed.mjs';

export const BUNDLED_SUBAGENT_DIR = 'pi-subagent-runtime';
export interface TrustedBunSubagentAssets {
  readonly root: string;
  verify(): void;
}

/** The install root has the binary's filesystem trust; pins detect swaps within this process only. */
export function pinBunSubagentAssets(): TrustedBunSubagentAssets | undefined {
  const root = path.dirname(realpathSync(process.execPath));
  const identities = new Map<string, { dev: bigint; ino: bigint; directory: boolean; size: bigint; mtimeNs: bigint }>();
  const fail = (file: string): never => { throw new Error('pi_subagents_host_sdk_unavailable: untrusted bundled subagent asset ' + file); };
  const capture = (file: string, stat = lstatSync(file, { bigint: true })): void => {
    if (stat.isSymbolicLink() || realpathSync(file) !== path.resolve(file) || (!stat.isDirectory() && !stat.isFile())) fail(file);
    identities.set(file, { dev: stat.dev, ino: stat.ino, directory: stat.isDirectory(), size: stat.size, mtimeNs: stat.mtimeNs });
    if (stat.isDirectory()) for (const entry of readdirSync(file)) capture(path.join(file, entry));
  };
  let absent = false;
  for (const dir of [PI_SUBAGENTS_ASSET_DIR, PI_SUBAGENT_EXTENSIONS_ASSET_DIR]) {
    const file = path.join(root, dir), stat = lstatSync(file, { bigint: true, throwIfNoEntry: false });
    if (stat === undefined) { absent = true; continue; }
    if (!stat.isDirectory()) fail(file);
    capture(file, stat);
  }
  const trusted: TrustedBunSubagentAssets = { root, verify: () => {
    for (const [file, expected] of identities) {
      const actual = lstatSync(file, { bigint: true });
      if (actual.isSymbolicLink() || realpathSync(file) !== file || actual.dev !== expected.dev || actual.ino !== expected.ino
        || actual.isDirectory() !== expected.directory || (!expected.directory && (!actual.isFile()
          || actual.size !== expected.size || actual.mtimeNs !== expected.mtimeNs))) fail(file);
    }
  } };
  trusted.verify();
  return absent ? undefined : trusted;
}

const BINARY_BOOTSTRAP = 'src/runs/background/binary-bootstrap.js';
const BINARY_ARGS = ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-session', '--mode', 'rpc', '--extension'];
const HOST_PEER = '@earendil-works/pi-coding-agent';
const EXPORT_NAME = /^[A-Za-z_$][\w$]*$/u;
const MISSING_BUN_ASSETS = 'pi_background_unavailable: background Pi subagents and workflows require the shipped pi-subagents and pi-subagent-extensions assets beside the real executable. Foreground non-workflow subagents work from the configured Pi assets; ship those asset directories beside the executable to enable background execution.';

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

/**
 * Private launch data; Bun executes code from the filesystem-trusted install root.
 * `seedPeers` writes the private jiti cache of the generated peer probe before Pi loads it.
 */
export async function prepareBundledSubagents(root: string, assetRoot: string, trustedBun: TrustedBunSubagentAssets, seedPeers: (root: string) => void): Promise<string> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // The installed runner owns its peer catalogue; keep it and TypeBox outside client dist.
  trustedBun.verify();
  const { HOST_PEER_ALIASES: aliases } = await import(pathToFileURL(path.join(trustedBun.root,
    PI_SUBAGENTS_ASSET_DIR, 'src/runs/background/runner-aliases.js')).href) as {
    HOST_PEER_ALIASES: ReadonlyArray<{ specifier: string; optional?: boolean }>;
  };
  const specifiers = aliases.filter(alias => !alias.optional).map(alias => alias.specifier);
  writeFileSync(path.join(root, 'host-peers.ts'), piSubagentHostPeersSource(specifiers), { flag: 'wx' });
  seedPeers(root);
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

/** Refuse explicit async and every workflow; preserve upstream resolution of omitted async. */
export const refuseBundledBackground: ExtensionFactory = pi => {
  const reason = isNodeSea()
    ? 'pi_background_unavailable: Node SEA cannot run background Pi subagents or workflows: pi-subagents 0.88.1 uses resolveNodeExecutable for its background runner and fork on process.execPath for its workflow supervisor; a SEA binary cannot stand in for Node. Foreground non-workflow subagents work; use a Bun-compiled product with shipped assets for background subagents and workflows.'
    : isBunExecutable()
      ? MISSING_BUN_ASSETS
      : 'pi_background_unavailable: the background runner cannot re-enter a bundle run by an interpreter. Foreground non-workflow subagents work; use a Bun-compiled product with shipped assets for background subagents and workflows.';
  pi.on('tool_call', event => {
    if (event.toolName === 'subagent' && (event.input.async === true || event.input.workflow !== undefined)) return { block: true, reason };
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
  if (argv.length === 8 && BINARY_ARGS.every((arg, index) => argv[index] === arg)) {
    const config = process.env.PI_SUBAGENT_RUNNER_CONFIG;
    if (config === undefined || !path.isAbsolute(config)) return invalid();
    const trusted = pinBunSubagentAssets();
    if (trusted === undefined) throw new Error(MISSING_BUN_ASSETS);
    if (!sameFile(argv[7], path.join(pkg, BINARY_BOOTSTRAP))) return invalid();
    (globalThis as { PI_BUNDLED_NODE?: boolean }).PI_BUNDLED_NODE = true;
    Reflect.get(globalThis, 'Headers');
    const { DefaultResourceLoader, getAgentDir } = await import('@earendil-works/pi-coding-agent');
    // #1927: this runner's own graph; a seed that does not verify is reported
    // once on the runner's stderr and the runner transforms cold.
    const { openPiJitiSeed } = await import('#byok-pi-runtime-host');
    try { openPiJitiSeed(trusted.root, import.meta.url).materialize('runner', pkg); } catch (error) {
      process.stderr.write(`byok-pi-runner: ${error instanceof Error ? error.message : String(error)}\n`);
    }
    const loader = new DefaultResourceLoader({ cwd: process.cwd(), agentDir: getAgentDir(), noExtensions: true,
      noSkills: true, noPromptTemplates: true, additionalExtensionPaths: [path.join(pkg, BINARY_BOOTSTRAP)] });
    trusted.verify();
    await loader.reload();
    throw new Error('pi_subagents_host_sdk_unavailable: binary bootstrap returned without running the child');
  }
  return invalid();
}
