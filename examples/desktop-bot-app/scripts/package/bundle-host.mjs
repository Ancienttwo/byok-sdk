// The one Host build, for dev and packaged runs: the SDK assets
// (copySdkPackagingAssets) and src/host/supervise.ts bundled beside them, so the
// Host's own directory is its asset root in both. Dev runs the CommonJS bundle
// under Node; a package gets the same bundle inside a Node SEA, the recipe of
// examples/packaging/embedded-host-smoke.mjs.
//
//   node scripts/package/bundle-host.mjs --format cjs|sea   (writes dist/host/)
//
// The assets of macOS and Windows include the Agent memory helper, built with
// `bun run --filter @byok-sdk/client build:agent-memory-helper` (Go). SEA_NODE
// names the official Node binary a SEA is made from (default: this Node); some
// package-manager builds omit the SEA fuse.
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import postject from 'postject';
import { byokSdkPackaging, copySdkPackagingAssets, sdkBundleImportMetaExemptions } from '@byok-sdk/client/packaging';

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const root = fileURLToPath(new URL('../../', import.meta.url));

/** The Host executable a bundle of `format` runs as: the CommonJS file under Node, or the SEA itself. */
export const hostFile = format => format === 'sea' ? (process.platform === 'win32' ? 'host.exe' : 'host') : 'host.cjs';

/** Writes this platform's Host into the new or empty `outDir`: the SDK assets, then the app's Host beside them. Returns the bundle's esbuild metafile. */
export async function bundleHost({ format, outDir }) {
  if (format !== 'cjs' && format !== 'sea') throw new Error(`Host bundle format must be cjs or sea, not ${JSON.stringify(format)}`);
  await copySdkPackagingAssets({ outDir, platform: process.platform, arch: process.arch }).catch(error => {
    if (error.code !== 'ENOENT' || !String(error.path).includes('agent-memory-fs')) throw error;
    throw new Error('The Agent memory helper is not built: run `bun run --filter @byok-sdk/client build:agent-memory-helper` (needs Go) once, then build:host again', { cause: error });
  });
  return buildHostExecutable({ entry: path.join(root, 'src', 'host', 'supervise.ts'), format, executable: path.join(outDir, hostFile(format)) });
}

/**
 * Bundles `entry` to `executable` (CommonJS, or that bundle inside a SEA); the executable's directory must hold the SDK assets.
 * Returns the esbuild metafile (input paths relative to the app root).
 */
export async function buildHostExecutable({ entry, format, executable }) {
  const work = mkdtempSync(path.join(tmpdir(), 'byok-desktop-host-'));
  try {
    const bundle = format === 'cjs' ? executable : path.join(work, 'host.cjs');
    // The entry is the bundle's main module; esbuild empties import.meta in CommonJS,
    // and the plugin refuses every empty import.meta outside its reviewed exemptions.
    const result = await build({ absWorkingDir: root, metafile: true, entryPoints: [entry], bundle: true, platform: 'node',
      format: 'cjs', target: 'node24', outfile: bundle, logLevel: 'silent', define: { 'import.meta.main': 'true' },
      plugins: [byokSdkPackaging({ format })] });
    for (const warning of result.warnings) {
      const file = warning.location?.file.replaceAll('\\', '/') ?? '';
      const exempt = warning.id === 'empty-import-meta' && sdkBundleImportMetaExemptions.some(site => file.endsWith(`node_modules/${site.package}/${site.file}`));
      if (!exempt) throw new Error(`unexpected build warning: ${warning.id} ${file}: ${warning.text}`);
    }
    if (format === 'sea') await injectSea(bundle, work, executable);
    return result.metafile;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function injectSea(bundle, work, executable) {
  const node = process.env.SEA_NODE ?? process.execPath;
  if (!readFileSync(node).includes(SEA_FUSE)) throw new Error(`${node} has no SEA fuse; set SEA_NODE to an official Node binary`);
  const config = path.join(work, 'sea-config.json'), blob = path.join(work, 'sea.blob');
  writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
  execFileSync(node, ['--experimental-sea-config', config], { stdio: 'inherit' });
  copyFileSync(node, executable);
  chmodSync(executable, 0o755);
  if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', executable]);
  if (process.platform === 'win32') removeAuthenticodeSignature(executable);
  await postject.inject(executable, 'NODE_SEA_BLOB', readFileSync(blob),
    { sentinelFuse: SEA_FUSE, ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}) });
  // Packaging re-signs it inside the app; the ad-hoc signature lets it run before that.
  if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', executable]);
}

/**
 * Drops Node's own Authenticode signature, as codesign --remove-signature does on
 * macOS: injection leaves it stale, and signtool then refuses the SEA
 * (0x800700C1). The certificate table is the PE security directory and sits at
 * the end of the file.
 */
export function removeAuthenticodeSignature(file) {
  const image = readFileSync(file);
  const pe = image.readUInt32LE(0x3c);
  if (image.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error(`${file} is not a PE image`);
  const optional = pe + 24;
  const magic = image.readUInt16LE(optional);
  if (magic !== 0x20b && magic !== 0x10b) throw new Error(`${file} has an unknown PE optional header`);
  const security = optional + (magic === 0x20b ? 112 : 96) + 4 * 8;
  const offset = image.readUInt32LE(security), size = image.readUInt32LE(security + 4);
  if (size === 0) return;
  if (offset + size !== image.length) throw new Error(`${file}: the certificate table is not at the end of the file`);
  image.writeUInt32LE(0, security);
  image.writeUInt32LE(0, security + 4);
  writeFileSync(file, image.subarray(0, offset));
}

if (import.meta.main) {
  const flag = process.argv.indexOf('--format');
  const outDir = path.join(root, 'dist', 'host');
  rmSync(outDir, { recursive: true, force: true });
  await bundleHost({ format: flag < 0 ? undefined : process.argv[flag + 1], outDir });
}
