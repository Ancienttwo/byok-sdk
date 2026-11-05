import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * A minimal `nativeAssetRoot` for a Windows x64 test Host that bundles the SDK:
 * the installed koffi addon beside the manifest of `pin`, without the Agent
 * memory helper that `copySdkNativeAssets` also needs. `loadSdkKoffiAsset`
 * verifies the addon against the pin when the Host loads it.
 */
export async function writeKoffiAssetRoot(outDir, pin) {
  const clientRequire = createRequire(new URL('../../packages/client/package.json', import.meta.url));
  const addon = path.join(path.dirname(clientRequire.resolve('koffi')), '..', '@koromix', 'koffi-win32-x64', 'win32_x64', 'koffi.node');
  await mkdir(path.join(outDir, 'win32-x64'), { recursive: true });
  await copyFile(addon, path.join(outDir, 'win32-x64', 'koffi.node'));
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify({
    version: 1, target: 'win32-x64', package: pin.package, packageVersion: pin.version, archiveIntegrity: pin.integrity, sha256: pin.sha256,
  }));
  return outDir;
}
