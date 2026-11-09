import { createHash } from 'node:crypto';
import { existsSync, promises as fs, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import exportLayout from './pi-export-asset-layout.json';
import exportSource from './pi-export-assets.source.json';
import todoLayout from './todo-locale-layout.json';
import { clientPackageRoot } from './client-manifest';
import { resolvePinnedPiPackage } from './resolve-bin';
import { verifyTodoLocaleAssets } from './todo-locale-assets';
import {
  PI_SUBAGENT_EXTENSIONS_ASSET_DIR, PI_SUBAGENT_FILE_SCOPE_FILE, PI_SUBAGENT_GATE_FILE, PI_SUBAGENTS_ASSET_DIR, PI_SUBAGENTS_PIN,
} from './subagents';

/**
 * How a single-file product runs Pi. `interpreter+bundle`: an interpreter
 * (Node or Bun) runs the product's JS bundle. `compiled-executable`: a
 * Bun-compiled executable. Pi looks for its files at different paths in each.
 */
export type PiRuntimeAssetForm = 'interpreter+bundle' | 'compiled-executable';

export interface CopyPiRuntimeAssetsOptions {
  /** The product's Pi asset root. It must not exist or must be empty. */
  readonly outDir: string;
  readonly form: PiRuntimeAssetForm;
}

const THEME_DIR: Readonly<Record<PiRuntimeAssetForm, string>> = Object.freeze({
  'interpreter+bundle': 'dist/modes/interactive/theme',
  'compiled-executable': 'theme',
});
const THEME_FILES = ['dark.json', 'light.json'] as const;
const PHOTON_WASM = 'photon_rs_bg.wasm';
const REMEDY = 'install @byok-sdk/client with its dependencies on the build machine';

interface PlannedCopy {
  readonly from: string;
  readonly to: string;
  readonly sha256?: string;
}

async function assertEmptyTarget(outDir: string): Promise<void> {
  try {
    const entries = await fs.readdir(outDir);
    if (entries.length > 0) throw new Error(`copyPiRuntimeAssets: ${outDir} is not empty; use a new Pi asset root for each build`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Regular files below `root/relative`; `excludeTopLevel` names a directory directly in `root` to skip. */
async function listFiles(root: string, relative: string, excludeTopLevel?: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (relative === '' && entry.isDirectory() && entry.name === excludeTopLevel) continue;
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`copyPiRuntimeAssets: ${child} is not a regular file`);
  }
  return files;
}

interface InstalledPackage { readonly dir: string; readonly name: string; readonly version: string; readonly dependencies: Readonly<Record<string, string>> }

/** The installed package `name` that Node resolution finds from `fromDir`. */
function installedPackage(fromDir: string, name: string): InstalledPackage {
  for (const base of createRequire(path.join(fromDir, 'package.json')).resolve.paths(name) ?? []) {
    const dir = path.join(base, name);
    if (!existsSync(path.join(dir, 'package.json'))) continue;
    const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown; dependencies?: Record<string, string> };
    if (manifest.name !== name || typeof manifest.version !== 'string') break;
    return { dir: realpathSync(dir), name, version: manifest.version, dependencies: manifest.dependencies ?? {} };
  }
  throw new Error(`copyPiRuntimeAssets: ${name} is not installed beside ${fromDir}; ${REMEDY}`);
}

/**
 * The client's exact pi-subagents and its runtime dependency closure, flat in
 * its own `node_modules`: Pi's extension loader supplies only the Pi packages
 * and typebox to an extension, so every other import resolves from there. The
 * package's direct dependencies are exact pins and must match.
 */
async function piSubagentsCopies(): Promise<PlannedCopy[]> {
  const root = installedPackage(clientPackageRoot(), 'pi-subagents');
  if (`${root.name}@${root.version}` !== PI_SUBAGENTS_PIN) {
    throw new Error(`copyPiRuntimeAssets: installed ${root.name}@${root.version} is not the client pin ${PI_SUBAGENTS_PIN}`);
  }
  const closure = new Map<string, InstalledPackage>();
  const pending: InstalledPackage[] = [root];
  for (let owner = pending.pop(); owner !== undefined; owner = pending.pop()) {
    for (const [name, range] of Object.entries(owner.dependencies)) {
      const dependency = installedPackage(owner.dir, name);
      if (owner === root && dependency.version !== range) {
        throw new Error(`copyPiRuntimeAssets: ${PI_SUBAGENTS_PIN} pins ${name}@${range}, but ${dependency.version} is installed`);
      }
      const seen = closure.get(name);
      if (seen !== undefined && seen.dir !== dependency.dir) throw new Error(`copyPiRuntimeAssets: two installed versions of ${name} in the ${PI_SUBAGENTS_PIN} closure`);
      if (seen === undefined) { closure.set(name, dependency); pending.push(dependency); }
    }
  }
  const copies: PlannedCopy[] = [];
  for (const pkg of [root, ...closure.values()]) {
    const target = pkg === root ? PI_SUBAGENTS_ASSET_DIR : `${PI_SUBAGENTS_ASSET_DIR}/node_modules/${pkg.name}`;
    // A package's own node_modules (npm nests one on a version conflict) is resolved through the closure above.
    copies.push(...(await listFiles(pkg.dir, '', 'node_modules')).map(file => ({ from: path.join(pkg.dir, file), to: `${target}/${file}` })));
  }
  const bin = path.join(clientPackageRoot(), 'dist', 'bin');
  copies.push(...[PI_SUBAGENT_GATE_FILE, PI_SUBAGENT_FILE_SCOPE_FILE].map(file => ({ from: path.join(bin, file), to: `${PI_SUBAGENT_EXTENSIONS_ASSET_DIR}/${file}` })));
  return copies;
}

/**
 * Create the Pi asset root of a single-file product from the installed
 * `@byok-sdk/client` and its pinned official Pi package. Run it in the
 * product build, then ship `outDir` with the product and set its absolute
 * path as `runtimes.pi.packageDir` (`PiAdapterOptions.packageDir`); a
 * Bun-compiled executable may keep it beside itself.
 *
 * The Pi package must be the exact official pin. The Pi export resources must
 * match their recorded SHA-256 digests, and the SDK todo locale assets must
 * match their build manifest; a mismatch fails closed. The root also holds the
 * client's exact pi-subagents with its runtime dependencies and the SDK
 * extensions its native children load, so the product's Pi offers foreground
 * subagents. Returns the written
 * file paths, relative to `outDir`, in sorted order.
 */
export async function copyPiRuntimeAssets(options: CopyPiRuntimeAssetsOptions): Promise<readonly string[]> {
  const form = options.form;
  if (form !== 'interpreter+bundle' && form !== 'compiled-executable') {
    throw new Error(`copyPiRuntimeAssets: unsupported form ${String(form)}`);
  }
  const outDir = path.resolve(options.outDir);
  await assertEmptyTarget(outDir);

  const pi = resolvePinnedPiPackage(REMEDY);
  if (exportSource.packageName !== pi.identity.name || exportSource.packageVersion !== pi.identity.version) {
    throw new Error(`copyPiRuntimeAssets: recorded Pi export resources are for ${exportSource.packageName}@${exportSource.packageVersion}, not the pin ${pi.identity.name}@${pi.identity.version}`);
  }
  const photon = createRequire(path.join(pi.dir, 'package.json')).resolve('@silvia-odwyer/photon-node');
  const sdkAssets = path.join(clientPackageRoot(), 'dist', 'assets');
  verifyTodoLocaleAssets(() => sdkAssets);

  const plan: PlannedCopy[] = [
    { from: path.join(pi.dir, 'package.json'), to: 'package.json' },
    ...THEME_FILES.map(name => ({ from: path.join(pi.dir, 'dist/modes/interactive/theme', name), to: `${THEME_DIR[form]}/${name}` })),
    ...exportSource.files.map(row => ({
      from: path.join(pi.dir, exportSource.sourceBasePath, row.path),
      to: `${exportLayout.basePaths[form]}/${row.path}`,
      sha256: row.sha256,
    })),
    { from: path.join(path.dirname(photon), PHOTON_WASM), to: PHOTON_WASM },
    ...(await listFiles(sdkAssets, todoLayout.basePath)).map(relative => ({ from: path.join(sdkAssets, relative), to: relative })),
    ...await piSubagentsCopies(),
  ];

  for (const copy of plan) {
    const bytes = await fs.readFile(copy.from);
    if (copy.sha256 !== undefined && createHash('sha256').update(bytes).digest('hex') !== copy.sha256) {
      throw new Error(`copyPiRuntimeAssets: Pi export resource digest mismatch: ${copy.to}`);
    }
    const target = path.join(outDir, copy.to);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' });
  }
  // The runtime check the product's Pi host runs at startup.
  verifyTodoLocaleAssets(() => outDir);
  return Object.freeze(plan.map(copy => copy.to).sort());
}
