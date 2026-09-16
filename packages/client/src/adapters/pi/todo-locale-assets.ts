import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ImplementationSpawnBindingV1 } from '@byok-sdk/implementation-identity';
import layout from './todo-locale-layout.json';

const HASH = /^[0-9a-f]{64}$/u;
export const TODO_LOCALE_ASSET_PATHS = Object.freeze(
  layout.locales.map(locale => `${layout.basePath}/locales/${locale}.json`),
);

function unconfiguredAssetRoot(): string {
  // This code is emitted in dist/bin/pi-runtime-host.js. Attested paths never
  // evaluate this package-relative root (especially not in a single-file S2).
  return fileURLToPath(new URL('../assets/', import.meta.url));
}

/** The caller has already passed verifyPiHostBinding. No root fallback. */
export function verifyTodoLocaleAssets(
  binding: ImplementationSpawnBindingV1,
  resolveUnconfiguredRoot: () => string = unconfiguredAssetRoot,
): string {
  const identity = binding.identity;
  let root: string;
  let assets: readonly { path: string; digest: string }[];
  if (identity.kind === 'attested') {
    if (!identity.assetRoot || binding.envCommitments.PI_PACKAGE_DIR !== identity.assetRoot) {
      throw new Error('todo_locale_asset_root_mismatch');
    }
    root = identity.assetRoot;
    assets = identity.assets ?? [];
  } else {
    if (identity.reason !== 'resolver_unconfigured') throw new Error('todo_locale_binding_unavailable');
    root = resolveUnconfiguredRoot();
    const raw: unknown = JSON.parse(readFileSync(path.join(root, layout.basePath, 'manifest.json'), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('todo_locale_manifest_invalid');
    const record = raw as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'assets,format,version'
      || record.format !== 'byok.todo-locale-assets' || record.version !== 1 || !Array.isArray(record.assets)
      || record.assets.length !== TODO_LOCALE_ASSET_PATHS.length) throw new Error('todo_locale_manifest_invalid');
    const rows: { path: string; digest: string }[] = [];
    for (const [index, row] of record.assets.entries()) {
      if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).sort().join(',') !== 'digest,path'
        || row.path !== TODO_LOCALE_ASSET_PATHS[index] || typeof row.digest !== 'string' || !HASH.test(row.digest)) {
        throw new Error('todo_locale_manifest_invalid');
      }
      rows.push({ path: row.path, digest: row.digest });
    }
    assets = rows;
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
