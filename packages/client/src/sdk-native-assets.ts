import { createRequire } from 'node:module';
import { sdkReservedHelperKinds } from './sdk-reserved-helper-host';
import { byok } from '../package.json';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { copyAgentMemoryHelperAssets } from './daemon/agent-memory-helper-release';

// Official npm archive integrity, also locked in bun.lock. Never fetched at runtime.
import { KOFFI } from './sdk-native-assets-pin';

export const sdkNativeAssetTargets = Object.freeze({
  // Koffi must stay byte-identical; the Agent memory helper may be re-signed.
  'win32-x64': Object.freeze({ ...KOFFI, files: ['KOFFI-LICENSE.txt', 'manifest.json', 'win32-x64/koffi.node'] as readonly string[], signingPolicy: 'unmodified-official-addon',
    agentMemoryHelper: Object.freeze({ files: ['agent-memory-fs/manifest.json', 'agent-memory-fs/win32-x64.exe'] as readonly string[], signingPolicy: 'product-resigning-allowed' }) }),
  darwin: Object.freeze({ files: ['agent-memory-fs/darwin-arm64', 'agent-memory-fs/darwin-x64', 'agent-memory-fs/manifest.json'] as readonly string[], signingPolicy: 'product-resigning-allowed' }),
});
export interface CopySdkNativeAssetsOptions {
  readonly outDir: string;
  readonly platform: 'win32' | 'darwin';
  readonly arch: 'x64' | 'arm64';
}
function absoluteRoot(root: string): string {
  if (typeof root !== 'string' || !path.isAbsolute(root) || /[\0\r\n]/u.test(root)) throw new Error('SDK native asset root must be an absolute directory');
  return root;
}
/** Build-time only. Fetches the integrity-pinned official Windows archive on any build host; never executes it. Both platforms copy the Agent memory helper through the release-helper copier. */
export async function copySdkNativeAssets(options: CopySdkNativeAssetsOptions): Promise<readonly string[]> {
  const root = absoluteRoot(options.outDir);
  if (!['win32', 'darwin'].includes(options.platform) || !['x64', 'arm64'].includes(options.arch)
    || (options.platform === 'win32' && options.arch !== 'x64')) throw new Error('SDK native assets: unsupported target');
  const present = await fs.readdir(root).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return []; });
  if (present.length) throw new Error('SDK native assets require a new or empty output directory');
  if (options.platform === 'darwin') {
    const files = await copyAgentMemoryHelperAssets({ outDir: path.join(root, 'agent-memory-fs') });
    return Object.freeze(files.map(file => `agent-memory-fs/${file}`));
  }
  const response = await fetch(KOFFI.url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  if (!response.ok) throw new Error(`SDK native asset download failed: ${response.status}`);
  const maxArchiveBytes = 8 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > maxArchiveBytes) {
    await response.body?.cancel(); throw new Error('SDK native asset archive exceeds size limit');
  }
  if (!response.body) throw new Error('SDK native asset archive body missing');
  const reader = response.body.getReader();
  const chunks: Buffer[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxArchiveBytes) { await reader.cancel(); throw new Error('SDK native asset archive exceeds size limit'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const archive = Buffer.concat(chunks, length);
  if (`sha512-${createHash('sha512').update(archive).digest('base64')}` !== KOFFI.integrity) throw new Error('SDK native asset archive integrity mismatch');
  const tar = gunzipSync(archive, { maxOutputLength: 8 * 1024 * 1024 });
  const selected = new Map<string, Buffer>();
  // Read only two exact regular-file members; never extract archive paths.
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString().split('\0')[0]!;
    const size = Number.parseInt(header.subarray(124, 136).toString().replace(/\0.*$/u, '').trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid SDK native asset archive');
    if (name === 'package/package.json' || name === 'package/win32_x64/koffi.node') {
      if ((header[156] !== 0 && header[156] !== 48) || selected.has(name)) throw new Error('Invalid SDK native asset member');
      selected.set(name, tar.subarray(offset + 512, offset + 512 + size));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const metadata = JSON.parse(selected.get('package/package.json')?.toString() ?? '{}');
  const addon = selected.get('package/win32_x64/koffi.node');
  if (metadata.name !== KOFFI.package || metadata.version !== KOFFI.version || !addon || createHash('sha256').update(addon).digest('hex') !== KOFFI.sha256) throw new Error('SDK native asset package mismatch');
  const packageRoot = path.dirname(createRequire(typeof __filename === 'string' ? __filename : import.meta.url).resolve('koffi'));
  const installed = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  if (installed.version !== KOFFI.version) throw new Error('Koffi license source version mismatch');
  const license = await fs.readFile(path.join(packageRoot, 'LICENSE.txt'));
  const helperFiles = await copyAgentMemoryHelperAssets({ outDir: path.join(root, 'agent-memory-fs'), platform: 'win32' });
  const manifest = { version: 1, target: 'win32-x64', package: KOFFI.package, packageVersion: KOFFI.version,
    archiveIntegrity: KOFFI.integrity, sha256: createHash('sha256').update(addon).digest('hex') };
  await fs.mkdir(path.join(root, 'win32-x64'), { recursive: true });
  await fs.writeFile(path.join(root, 'win32-x64/koffi.node'), addon, { flag: 'wx' });
  await fs.writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest)}\n`, { flag: 'wx' });
  await fs.writeFile(path.join(root, 'KOFFI-LICENSE.txt'), license, { flag: 'wx' });
  return Object.freeze(['KOFFI-LICENSE.txt', 'manifest.json', 'win32-x64/koffi.node', ...helperFiles.map(file => `agent-memory-fs/${file}`)].sort());
}
export { loadSdkKoffiAsset } from './sdk-native-assets-runtime';

/** Machine-readable build inputs. Target presence is not runtime/platform qualification. */
export const sdkDistributionManifest = Object.freeze({ version: 1, piRuntimePin: byok.piRuntimePin, reservedHelperKinds: sdkReservedHelperKinds,
  nativeTargets: sdkNativeAssetTargets });
