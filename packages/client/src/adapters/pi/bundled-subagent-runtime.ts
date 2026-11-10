import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
const BOOTSTRAP = 'src/runs/background/subagent-runner-bootstrap.js';
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
export async function prepareBundledSubagents(root: string, assetRoot: string, trustedBun?: TrustedBunSubagentAssets): Promise<string> {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const assets = path.join(root, 'assets');
  if (trustedBun === undefined) {
    mkdirSync(assets, { mode: 0o700 });
    for (const dir of [PI_SUBAGENTS_ASSET_DIR, PI_SUBAGENT_EXTENSIONS_ASSET_DIR]) {
      cpSync(path.join(assetRoot, dir), path.join(assets, dir), { recursive: true, errorOnExist: true, force: false });
    }
  }
  // The installed runner owns its peer catalogue; keep it and TypeBox outside client dist.
  trustedBun?.verify();
  const { HOST_PEER_ALIASES: aliases } = await import(pathToFileURL(path.join(trustedBun?.root ?? assets,
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
  if (isBunExecutable()) process.env.PI_SUBAGENT_PI_BINARY = process.execPath;
  trustedBun?.verify();
  return trustedBun?.root ?? assets;
}

/** Interpreter bundles keep the upstream missing-peer refusal, with an actionable explanation. */
export const refuseInterpreterBackground: ExtensionFactory = pi => {
  pi.on('tool_result', event => {
    if (event.toolName !== 'subagent' || !event.isError) return;
    const refused = event.content.some(part => part.type === 'text' && part.text.includes('Background children require the host npm package'));
    if (refused) return { content: [{ type: 'text', text: 'pi_background_unavailable: the background runner cannot re-enter a bundle run by an interpreter. Use a Bun-compiled executable or Node SEA for background subagents and workflows.' }] };
  });
};

function sameFile(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined || !path.isAbsolute(candidate) || !existsSync(candidate) || !existsSync(expected)) return false;
  const written = lstatSync(expected, { bigint: true }), actual = lstatSync(candidate, { bigint: true });
  if (!written.isFile() || !actual.isFile() || written.isSymbolicLink() || actual.isSymbolicLink()) return false;
  return realpathSync(expected) === path.resolve(expected) && realpathSync(candidate) === path.resolve(expected)
    && actual.dev === written.dev && actual.ino === written.ino;
}

/** Validate the launch-config-derived location before any SEA helper writes assets. */
export function assertSeaSubagentRoot(root: string, configPath: string): void {
  const expected = path.join(realpathSync(path.dirname(configPath)), BUNDLED_SUBAGENT_DIR);
  const executable = path.join(expected, process.platform === 'win32' ? 'node.exe' : 'node');
  const stat = existsSync(root) ? lstatSync(root) : undefined;
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()
    || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o700)
    || (process.getuid !== undefined && stat.uid !== process.getuid())
    || realpathSync(root) !== expected || !sameFile(process.execPath, executable)) {
    throw new Error('pi_background_unavailable: the SEA helper is not running from its SDK launch-private directory');
  }
}

/** Compiled runner prefixes are reserved: malformed or foreign re-entry fails before product dispatch. */
export async function runBundledSubagentCommand(argv: readonly string[]): Promise<boolean> {
  const sea = isNodeSea();
  const bun = isBunExecutable();
  if (!sea && !bun) return false;
  const root = path.dirname(realpathSync(process.execPath));
  const invalid = (): never => { throw new Error('pi_background_unavailable: invalid SDK Pi runner re-entry'); };
  const pkg = bun ? path.join(root, PI_SUBAGENTS_ASSET_DIR) : path.join(root, 'assets', PI_SUBAGENTS_ASSET_DIR);
  if (sea && argv.length === 7 && argv[0] === '--permission' && argv[1] === '--allow-worker') {
    const supervisor = path.join(pkg, 'workflow-script-process.cjs');
    const worker = path.join(pkg, 'workflow-script-worker.cjs');
    const acorn = path.join(pkg, 'node_modules/acorn/dist/acorn.js');
    if (!sameFile(argv[5], supervisor) || !sameFile(argv[6], acorn)
      || ![supervisor, worker, acorn].every((file, index) => sameFile(argv[index + 2]?.replace(/^--allow-fs-read=/u, ''), file)
        && argv[index + 2]?.startsWith('--allow-fs-read='))) return invalid();
    // SEA does not apply Node flags in argv. Route C intentionally runs the
    // upstream VM realm without Node's permission layer, as upstream Bun does.
    // Do not propagate apparent permission flags to the worker or claim them.
    process.execArgv = [];
    process.argv = [process.execPath, realpathSync(supervisor), realpathSync(acorn)];
    createRequire(supervisor)(supervisor);
    await new Promise<never>(() => {}); // Upstream owns IPC, disconnect and exit.
  }
  if (sea && argv.length === 4 && argv[0] === '--import') {
    const bootstrap = path.join(pkg, BOOTSTRAP);
    const preload = path.join(pkg, 'runner-peer-preload.mjs');
    let preloadPath: string;
    try { preloadPath = fileURLToPath(argv[1]!); } catch { return invalid(); }
    if (!sameFile(argv[2], bootstrap) || !sameFile(preloadPath, preload) || !path.isAbsolute(argv[3]!)) return invalid();
    await loadPeers(root);
    process.argv = [process.execPath, realpathSync(bootstrap), argv[3]!];
    await import(pathToFileURL(realpathSync(preload)).href);
    await import(pathToFileURL(realpathSync(bootstrap)).href);
    await new Promise<never>(() => {}); // The upstream bootstrap exits after disposal.
  }
  if (bun && argv.length === 8 && BINARY_ARGS.every((arg, index) => argv[index] === arg)
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
