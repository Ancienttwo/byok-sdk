// Packages the desktop app for this machine's platform and architecture:
// macOS DMG + ZIP, Windows NSIS, Linux AppImage + deb (electron-builder.config.mjs).
// The SEA Host is made from this machine's Node, so a package is built on its
// own platform and arch.
//
//   bun run package    (runs `bun run build` first; macOS and Windows also need
//                       the Agent memory helper, see bundle-host.mjs)
//
// Output: dist/package/out. dist/package/stage keeps what went in, for package-smoke.mjs.
// Before electron-builder runs, the license gate (license-gate.mjs) checks what the
// app ships and prints the inventory, also into $GITHUB_STEP_SUMMARY when set.
import { appendFileSync, cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sdkNativeAssetTargets, sdkPackagingAssetLayout } from '@byok-sdk/client';
import { build as bundle } from 'esbuild';
import { build } from 'electron-builder';
import config from '../../electron-builder.config.mjs';
import manifest from '../../package.json' with { type: 'json' };
import { bundleHost, hostFile } from './bundle-host.mjs';
import { licenseInventory, licenseReport } from './license-gate.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const at = (...parts) => path.join(root, ...parts);
const stage = at('dist', 'package', 'stage');
rmSync(at('dist', 'package'), { recursive: true, force: true });

// app/ becomes the asar. Main is one ESM bundle, so the asar holds no node_modules;
// the preload and renderer come from the tsc build at the paths main resolves in dev.
const app = path.join(stage, 'app');
const main = await bundle({ absWorkingDir: root, metafile: true, entryPoints: [at('src', 'main', 'index.ts')], bundle: true, platform: 'node', format: 'esm', target: 'node24',
  outfile: path.join(app, 'dist', 'src', 'main', 'index.js'), external: ['electron'], logLevel: 'warning',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
for (const part of ['preload', 'renderer']) cpSync(at('dist', 'src', part), path.join(app, 'dist', 'src', part), { recursive: true });
// Main resolves its tray icons under assets/ at the app root, as in dev.
cpSync(at('assets'), path.join(app, 'assets'), { recursive: true });
writeFileSync(path.join(app, 'package.json'), `${JSON.stringify({ name: manifest.name, version: manifest.version,
  description: manifest.description, license: manifest.license, type: 'module', main: 'dist/src/main/index.js' }, null, 2)}\n`);

// host/ ships outside the asar as resources/host/.
const host = await bundleHost({ format: 'sea', outDir: path.join(stage, 'host') });

// The renderer's metafile comes from `bun run build` (package.json).
const renderer = JSON.parse(readFileSync(at('dist', 'renderer.meta.json'), 'utf8'));
const hostDir = path.relative(root, path.join(stage, 'host')).split(path.sep).join('/');
const { native, pi } = sdkPackagingAssetLayout;
const win32 = sdkNativeAssetTargets['win32-x64'];
const unpackaged = Object.fromEntries([
  [hostFile('sea'), "the app's Host: the bundled inputs above inside the official Node binary (Node.js license and notices)"],
  [`${pi}/photon_rs_bg.wasm`, "@silvia-odwyer/photon-node's wasm, which copyPiRuntimeAssets adds to the Pi root"],
  ...win32.files.map(file => [`${native}/${file}`, `${win32.package} ${win32.version}, the official koffi addon @byok-sdk/client pins; its license text is ${native}/KOFFI-LICENSE.txt`]),
  ...[...sdkNativeAssetTargets.darwin.files, ...win32.agentMemoryHelper.files].map(file => [`${native}/${file}`, 'the Agent memory helper of @byok-sdk/client (this repository, MIT)']),
].map(([file, provenance]) => [`${hostDir}/${file}`, provenance]));
const { table, refused } = licenseReport(licenseInventory({ root, metafiles: [main.metafile, renderer, host],
  manifests: [createRequire(import.meta.url).resolve('electron/package.json')], copiedRoots: [path.join(stage, 'host')], unpackaged }));
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Desktop package licenses ${process.platform}-${process.arch}\n\n${table}\n\n`);
if (refused.length > 0) {
  throw new Error(`License gate: not MIT, Apache-2.0, BSD or ISC: ${refused.map(entry => `${entry.name}@${entry.version} ${JSON.stringify(entry.license ?? null)}`).join(', ')}`);
}

await build({ projectDir: app, config, publish: 'never' });
