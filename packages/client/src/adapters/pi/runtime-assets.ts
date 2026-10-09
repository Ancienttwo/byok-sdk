import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import exportLayout from './pi-export-asset-layout.json';
import exportSource from './pi-export-assets.source.json';
import todoLayout from './todo-locale-layout.json';
import { clientPackageRoot } from './client-manifest';
import { resolvePinnedPiPackage } from './resolve-bin';
import { verifyTodoLocaleAssets } from './todo-locale-assets';

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

async function listFiles(root: string, relative: string): Promise<string[]> {
  const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) files.push(...await listFiles(root, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`copyPiRuntimeAssets: ${child} is not a regular file`);
  }
  return files;
}

/**
 * Create the Pi asset root of a single-file product from the installed
 * `@byok-sdk/client` and its pinned official Pi package. Run it in the
 * product build, then ship `outDir` with the product and name it in
 * `PI_PACKAGE_DIR` (a Bun-compiled executable may keep it beside itself).
 *
 * The Pi package must be the exact official pin. The Pi export resources must
 * match their recorded SHA-256 digests, and the SDK todo locale assets must
 * match their build manifest; a mismatch fails closed. Returns the written
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
