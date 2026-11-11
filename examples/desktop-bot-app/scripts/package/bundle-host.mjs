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

/** Writes this platform's Host into the new or empty `outDir`. */
export async function bundleHost({ format, outDir }) {
  if (format !== 'cjs' && format !== 'sea') throw new Error(`Host bundle format must be cjs or sea, not ${JSON.stringify(format)}`);
  await copySdkPackagingAssets({ outDir, platform: process.platform, arch: process.arch });
  const work = mkdtempSync(path.join(tmpdir(), 'byok-desktop-host-'));
  try {
    const bundle = format === 'cjs' ? path.join(outDir, hostFile(format)) : path.join(work, 'host.cjs');
    // The entry is the bundle's main module; esbuild empties import.meta in CommonJS,
    // and the plugin refuses every empty import.meta outside its reviewed exemptions.
    const result = await build({ entryPoints: [path.join(root, 'src', 'host', 'supervise.ts')], bundle: true, platform: 'node',
      format: 'cjs', target: 'node24', outfile: bundle, logLevel: 'silent', define: { 'import.meta.main': 'true' },
      plugins: [byokSdkPackaging({ format })] });
    for (const warning of result.warnings) {
      const file = warning.location?.file.replaceAll('\\', '/') ?? '';
      const exempt = warning.id === 'empty-import-meta' && sdkBundleImportMetaExemptions.some(site => file.endsWith(`node_modules/${site.package}/${site.file}`));
      if (!exempt) throw new Error(`unexpected build warning: ${warning.id} ${file}: ${warning.text}`);
    }
    if (format === 'sea') await injectSea(bundle, work, path.join(outDir, hostFile(format)));
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
  await postject.inject(executable, 'NODE_SEA_BLOB', readFileSync(blob),
    { sentinelFuse: SEA_FUSE, ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}) });
  // Packaging re-signs it inside the app; the ad-hoc signature lets it run before that.
  if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', executable]);
}

if (import.meta.main) {
  const flag = process.argv.indexOf('--format');
  const outDir = path.join(root, 'dist', 'host');
  rmSync(outDir, { recursive: true, force: true });
  await bundleHost({ format: flag < 0 ? undefined : process.argv[flag + 1], outDir });
}
