import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ImplementationSpawnBindingV1 } from '@byok-sdk/implementation-identity';
import layout from './pi-export-asset-layout.json';

export const PI_EXPORT_SOURCE_LAYOUT_FORBIDDEN = 'pi_export_source_layout_forbidden';

/** The same native-relative layout is consumed by build inventory and installers. */
export function piExportAssetPaths(form: 'interpreter+bundle' | 'compiled-executable'): readonly string[] {
  return layout.files.map(file => `${layout.basePaths[form]}/${file}`);
}

/** Called only after physical binding and native provenance verification.
 * Native 1005 still needs a public static export API (1006 prerequisite).
 * These checks do not authorize recursive dispatch or restrict export output paths.
 */
export function verifyPiExportAssets(binding: ImplementationSpawnBindingV1): void {
  const identity = binding.identity;
  if (identity.kind !== 'attested') throw new Error('pi_export_binding_unavailable');
  const root = identity.assetRoot;
  if (!root || binding.envCommitments.PI_PACKAGE_DIR !== root) throw new Error('pi_export_asset_root_mismatch');
  // Native 1005 would select src/core/export-html in this case. The sealed
  // interpreted layout is explicitly dist-only, never a discovery/fallback.
  if (identity.form === 'interpreter+bundle' && existsSync(path.join(root, 'src'))) {
    throw new Error(PI_EXPORT_SOURCE_LAYOUT_FORBIDDEN);
  }
  for (const relative of piExportAssetPaths(identity.form)) {
    const rows = identity.assets?.filter(asset => asset.path === relative) ?? [];
    if (rows.length !== 1 || !/^[0-9a-f]{64}$/u.test(rows[0]!.digest)) {
      throw new Error(`pi_export_asset_undeclared: ${relative}`);
    }
    const bytes = readFileSync(path.join(root, relative));
    if (createHash('sha256').update(bytes).digest('hex') !== rows[0]!.digest) {
      throw new Error(`pi_export_asset_digest_mismatch: ${relative}`);
    }
  }
}
