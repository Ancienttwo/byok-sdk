import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import layout from './todo-locale-layout.json';

const HASH = /^[0-9a-f]{64}$/u;
export const TODO_LOCALE_ASSET_PATHS = Object.freeze(
  layout.locales.map(locale => `${layout.basePath}/locales/${locale}.json`),
);

function packagedAssetRoot(): string {
  // This code is emitted in dist/bin/pi-runtime-host.js.
  return fileURLToPath(new URL('../assets/', import.meta.url));
}

/** A single-file product's Pi asset root is not set or holds no SDK asset manifest. */
export class PiBundledAssetsError extends Error {
  readonly code = 'pi_bundled_assets_unavailable';
}

/**
 * The asset root of a single-file product that bundles Pi: where Pi itself
 * looks, `PI_PACKAGE_DIR`, else the directory of a compiled executable. An
 * interpreter + bundle product (`entry`) must set `PI_PACKAGE_DIR`. The root
 * must hold the SDK asset manifest.
 */
export function locateBundledPiAssets(input: {
  readonly piPackageDir: string | undefined;
  readonly executable: string;
  readonly entry?: string;
}): string {
  const named = input.piPackageDir !== undefined && input.piPackageDir !== '';
  if (!named && input.entry !== undefined) {
    throw new PiBundledAssetsError('pi_bundled_assets_unavailable: an interpreter + bundle product must set PI_PACKAGE_DIR to its Pi asset root');
  }
  const root = path.resolve(named ? input.piPackageDir! : path.dirname(input.executable));
  if (!existsSync(path.join(root, layout.basePath, 'manifest.json'))) {
    throw new PiBundledAssetsError(named
      ? 'pi_bundled_assets_unavailable: PI_PACKAGE_DIR holds no SDK Pi asset manifest'
      : 'pi_bundled_assets_unavailable: no SDK Pi asset manifest beside the executable; set PI_PACKAGE_DIR to the product Pi asset root');
  }
  return root;
}

/** The asset root of the running single-file product. */
export function bundledAssetRoot(): string {
  return locateBundledPiAssets({ piPackageDir: process.env.PI_PACKAGE_DIR, executable: process.execPath });
}

/** Verify the SDK's own todo locale assets against their build manifest. No root fallback. */
export function verifyTodoLocaleAssets(resolveRoot: () => string = packagedAssetRoot): string {
  const root = resolveRoot();
  const raw: unknown = JSON.parse(readFileSync(path.join(root, layout.basePath, 'manifest.json'), 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('todo_locale_manifest_invalid');
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'assets,format,version'
    || record.format !== 'byok.todo-locale-assets' || record.version !== 1 || !Array.isArray(record.assets)
    || record.assets.length !== TODO_LOCALE_ASSET_PATHS.length) throw new Error('todo_locale_manifest_invalid');
  const assets: { path: string; digest: string }[] = [];
  for (const [index, row] of record.assets.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).sort().join(',') !== 'digest,path'
      || row.path !== TODO_LOCALE_ASSET_PATHS[index] || typeof row.digest !== 'string' || !HASH.test(row.digest)) {
      throw new Error('todo_locale_manifest_invalid');
    }
    assets.push({ path: row.path, digest: row.digest });
  }
  for (const relative of TODO_LOCALE_ASSET_PATHS) {
    const matches = assets.filter(asset => asset.path === relative);
    if (matches.length !== 1 || !HASH.test(matches[0]!.digest)) throw new Error(`todo_locale_asset_undeclared: ${relative}`);
    const bytes = readFileSync(path.join(root, relative));
    if (createHash('sha256').update(bytes).digest('hex') !== matches[0]!.digest) throw new Error(`todo_locale_asset_digest_mismatch: ${relative}`);
    const data: unknown = JSON.parse(bytes.toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.values(data).some(value => typeof value !== 'string')) throw new Error(`todo_locale_asset_invalid: ${relative}`);
  }
  return pathToFileURL(path.join(root, layout.basePath) + path.sep).href;
}
