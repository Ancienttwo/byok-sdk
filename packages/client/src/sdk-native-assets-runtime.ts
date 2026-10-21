import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { KOFFI } from './sdk-native-assets-pin';
function absoluteRoot(root: string): string {
  if (typeof root !== 'string' || !path.isAbsolute(root) || /[\0\r\n]/u.test(root)) throw new Error('SDK native asset root must be an absolute directory');
  return root;
}
/** Runtime loader: explicit absolute root only, no download or package-search fallback. */
export function loadSdkKoffiAsset(root: string): unknown {
  absoluteRoot(root);
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('SDK native addon asset supports Windows x64 only');
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const file = path.join(root, 'win32-x64/koffi.node');
  if (manifest.version !== 1 || manifest.target !== 'win32-x64' || manifest.package !== KOFFI.package || manifest.packageVersion !== KOFFI.version
    || manifest.archiveIntegrity !== KOFFI.integrity || manifest.sha256 !== KOFFI.sha256 || KOFFI.sha256 !== createHash('sha256').update(readFileSync(file)).digest('hex')) throw new Error('SDK native addon deployment mismatch');
  const require = process.getBuiltinModule('node:module').createRequire(path.join(root, 'loader.cjs'));
  const native = require(file);
  if (native.version !== KOFFI.version) throw new Error('SDK native addon version mismatch');
  return native;
}
