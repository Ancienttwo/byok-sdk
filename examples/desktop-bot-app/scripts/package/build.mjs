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
// app ships and prints the inventory, also into $GITHUB_STEP_SUMMARY when set; the
// third-party notices file (notices.mjs) is written from the same inventory.
import { appendFileSync, cpSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PI_PACKAGE_NAME, sdkNativeAssetTargets, sdkPackagingAssetLayout } from '@byok-sdk/client';
import { build as bundle } from 'esbuild';
import { build } from 'electron-builder';
import config from '../../electron-builder.config.mjs';
import manifest from '../../package.json' with { type: 'json' };
import { bundleHost, hostFile } from './bundle-host.mjs';
import { licenseInventory, licenseReport } from './license-gate.mjs';
import { NOTICES_FILE, noticesText } from './notices.mjs';

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
// The packages the third-party reviewed files come from, resolved as the SDK resolves them when it copies them:
// photon-node through the Pi package (copyPiRuntimeAssets), koffi through @byok-sdk/client (copySdkNativeAssets).
// Node's node_modules lookup from `from`, without an exports map, which may not export package.json.
function manifestOf(from, name) {
  const found = createRequire(from).resolve.paths(name).map(dir => path.join(dir, name, 'package.json')).find(file => existsSync(file));
  if (!found) throw new Error(`License gate: ${name} is not resolvable from ${from}`);
  return realpathSync(found);
}
const client = manifestOf(import.meta.url, '@byok-sdk/client');
const piManifest = manifestOf(client, PI_PACKAGE_NAME);
const unpackaged = Object.fromEntries([
  [hostFile('sea'), { provenance: "the app's Host: the bundled inputs above inside the official Node binary" }],
  [`${pi}/photon_rs_bg.wasm`, { provenance: "photon-node's wasm, which copyPiRuntimeAssets adds to the Pi root", source: manifestOf(piManifest, '@silvia-odwyer/photon-node') }],
  ...win32.files.map(file => [`${native}/${file}`, { provenance: `${win32.package} ${win32.version}, the official koffi addon @byok-sdk/client pins`, source: manifestOf(client, 'koffi') }]),
  ...[...sdkNativeAssetTargets.darwin.files, ...win32.agentMemoryHelper.files].map(file => [`${native}/${file}`, { provenance: 'the Agent memory helper of @byok-sdk/client (this repository, MIT)' }]),
].map(([file, entry]) => [`${hostDir}/${file}`, entry]));
const inventory = licenseInventory({ root, metafiles: [main.metafile, renderer, host],
  manifests: [createRequire(import.meta.url).resolve('electron/package.json')], copiedRoots: [path.join(stage, 'host')], unpackaged });
const { table, refused } = licenseReport(inventory);
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Desktop package licenses ${process.platform}-${process.arch}\n\n${table}\n\n`);
if (refused.length > 0) {
  throw new Error(`License gate: not a listed permissive license: ${refused.map(entry => `${entry.name}@${entry.version} ${JSON.stringify(entry.license ?? null)}`).join(', ')}`);
}

// The notices ship as resources/THIRD_PARTY_NOTICES.txt (electron-builder.config.mjs); package-smoke.mjs checks it against the inventory.
writeFileSync(path.join(stage, NOTICES_FILE), noticesText({ root, packages: inventory.packages,
  firstParty: inventory.reviewed.filter(entry => entry.package === undefined).map(entry => path.posix.relative(hostDir, entry.file)) }));
writeFileSync(path.join(stage, 'license-inventory.json'), `${JSON.stringify(inventory.packages, null, 2)}\n`);

await build({ projectDir: app, config, publish: 'never' });
