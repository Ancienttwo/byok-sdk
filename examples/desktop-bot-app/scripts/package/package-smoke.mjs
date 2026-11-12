// Checks the package that build.mjs wrote for this platform (dist/package/out):
//
// - resources/host/ holds exactly the staged Host files, byte for byte, except the
//   binaries packaging may re-sign (the SEA and the Agent memory helper); koffi.node
//   on Windows stays the official addon (its SHA-256 equals the SDK manifest's pin);
// - resources/THIRD_PARTY_NOTICES.txt has a section for every package of the
//   license gate's inventory and for the Host SEA's Node runtime (#1923, notices.mjs);
// - the app's Electron binary carries the app fuses (src/main/fuses.ts);
// - macOS: the ad-hoc or Developer ID signature verifies deep and strict;
// - the packaged ffmpeg is Electron's codec-free build (#1499 D7, ffmpeg.mjs);
// - Linux: the deb depends on libsecret-tools (#1499 3.2);
// - the packaged SEA Host answers the bridge (host-smoke.mjs). It keeps a device
//   credential in the OS store, so the script refuses to run outside CI;
// - a smoke Host SEA (smoke-host.ts) run from inside resources/host/ completes a Pi
//   dispatch with memory_recall and gets pi_background_unavailable for a background
//   subagent (#1499 R2). It is removed again afterwards.
//
// Prints the sizes, also into $GITHUB_STEP_SUMMARY when set.
//
//   node scripts/package/package-smoke.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FuseState, getCurrentFuseWire } from '@electron/fuses';
import { sdkNativeAssetTargets, sdkPackagingAssetLayout } from '@byok-sdk/client';
import brand from '../../brand.config.ts';
import manifest from '../../package.json' with { type: 'json' };
import { APP_FUSES } from '../../src/main/fuses.ts';
import { hostEnvironment } from '../../src/main/packaged-host.ts';
import { buildHostExecutable, hostFile, seaNodeLicense } from './bundle-host.mjs';
import { codecFreeFfmpeg, packagedFfmpeg } from './ffmpeg.mjs';
import { NOTICES_FILE, nodeHeading, noticeHeading } from './notices.mjs';

// The packaged Host pairs and keeps its device credential in this machine's OS store.
if (process.env.CI !== 'true') throw new Error('package-smoke.mjs writes a device credential into the OS credential store: run it on CI only (CI=true)');

const MARKER = 'BYOK_DESKTOP_SMOKE ';
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'dist', 'package', 'out');
const staged = path.join(root, 'dist', 'package', 'stage', 'host');
const name = brand.productName;
const unpacked = {
  darwin: path.join(out, `mac-${process.arch}`, `${name}.app`),
  win32: path.join(out, 'win-unpacked'),
  linux: path.join(out, 'linux-unpacked'),
}[process.platform];
const resources = process.platform === 'darwin' ? path.join(unpacked, 'Contents', 'Resources') : path.join(unpacked, 'resources');
const electron = process.platform === 'darwin' ? path.join(unpacked, 'Contents', 'MacOS', name)
  : process.platform === 'win32' ? path.join(unpacked, `${name}.exe`) : path.join(unpacked, brand.productId);
const host = path.join(resources, 'host');

/** Relative paths of every file and symlink under `dir`, sorted; symlinks are not followed. */
function files(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]).sort();
}
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const bytes = dir => files(dir).reduce((sum, file) => sum + lstatSync(path.join(dir, file)).size, 0);
const mib = value => `${(value / 1024 / 1024).toFixed(1)} MiB`;

// 1. resources/host/ equals the staged Host, except what packaging may re-sign.
const native = sdkPackagingAssetLayout.native;
const resignable = new Set([hostFile('sea'), ...(
  process.platform === 'darwin' ? sdkNativeAssetTargets.darwin.files
    : process.platform === 'win32' ? sdkNativeAssetTargets['win32-x64'].agentMemoryHelper.files : []
).filter(file => !file.endsWith('manifest.json')).map(file => `${native}/${file}`)]);
assert.deepEqual(files(host), files(staged), 'resources/host/ differs from the staged Host file list');
const resigned = [];
for (const file of files(staged)) {
  const same = sha256(path.join(host, file)) === sha256(path.join(staged, file));
  if (!same) resigned.push(file);
  assert.ok(same || resignable.has(file), `resources/host/${file} differs from the staged file`);
}
console.log(`[package-smoke] resources/host: ${files(host).length} files equal to the stage${resigned.length ? `; re-signed: ${resigned.join(', ')}` : ''}`);
if (process.platform === 'win32') {
  const koffi = path.join(host, native, 'win32-x64', 'koffi.node');
  const pin = JSON.parse(readFileSync(path.join(host, native, 'manifest.json'), 'utf8')).sha256;
  assert.equal(sha256(koffi), pin, 'packaged koffi.node is not the pinned official addon');
  console.log(`[package-smoke] koffi.node SHA-256 ${pin} equals the pin`);
}

// 1b. Third-party notices: one section per inventoried package, and the Host SEA's Node runtime.
const notices = readFileSync(path.join(resources, NOTICES_FILE), 'utf8');
const inventory = JSON.parse(readFileSync(path.join(root, 'dist', 'package', 'stage', 'license-inventory.json'), 'utf8'));
const unlisted = [...inventory.map(noticeHeading), nodeHeading(seaNodeLicense().version)].filter(heading => !notices.includes(`\n${heading}\n`));
assert.deepEqual(unlisted, [], `${NOTICES_FILE} has no section for these inventoried packages or the Host's Node runtime`);
console.log(`[package-smoke] ${NOTICES_FILE}: ${inventory.length} packages`);

// 2. Fuses, read back from the packaged binary.
const wire = await getCurrentFuseWire(electron);
for (const [fuse, enabled] of Object.entries(APP_FUSES)) {
  if (fuse === 'version') continue;
  assert.equal(wire[fuse], enabled ? FuseState.ENABLE : FuseState.DISABLE, `fuse ${fuse} is not ${enabled ? 'enabled' : 'disabled'}`);
}
console.log('[package-smoke] fuses read back as APP_FUSES');

// 3. macOS signature, before anything is added to the bundle.
if (process.platform === 'darwin') {
  execFileSync('codesign', ['--verify', '--deep', '--strict', unpacked], { stdio: 'inherit' });
  console.log('[package-smoke] codesign --verify --deep --strict passed');
}

// 3b. ffmpeg. macOS packaging re-signs the library, so there both sides lose their signature before the comparison.
const digest = data => createHash('sha256').update(data).digest('hex');
function withoutSignature(data) {
  if (process.platform !== 'darwin') return data;
  const dir = mkdtempSync(path.join(tmpdir(), 'byok-desktop-ffmpeg-check-'));
  try {
    const file = path.join(dir, 'library');
    writeFileSync(file, data);
    execFileSync('codesign', ['--remove-signature', file]);
    return readFileSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const ffmpeg = digest(withoutSignature(readFileSync(packagedFfmpeg(unpacked, process.platform))));
const codecFree = digest(withoutSignature(await codecFreeFfmpeg({ version: manifest.devDependencies.electron, platform: process.platform, arch: process.arch })));
assert.equal(ffmpeg, codecFree, "the packaged ffmpeg is not Electron's codec-free build");
console.log(`[package-smoke] ffmpeg is the codec-free build (SHA-256 ${codecFree}${process.platform === 'darwin' ? ', unsigned' : ''})`);

// 3c. Linux: the deb depends on secret-tool.
if (process.platform === 'linux') {
  const deb = readdirSync(out).find(file => file.endsWith('.deb'));
  assert.ok(deb, 'no .deb in the package output');
  const depends = execFileSync('dpkg-deb', ['--field', path.join(out, deb), 'Depends'], { encoding: 'utf8' }).split(',').map(item => item.trim());
  assert.ok(depends.includes('libsecret-tools'), `the deb does not depend on libsecret-tools: ${depends.join(', ')}`);
  console.log(`[package-smoke] ${deb} depends on libsecret-tools`);
}

// 4. The packaged SEA Host through the bridge.
execFileSync(process.execPath, [path.join(root, 'scripts', 'package', 'host-smoke.mjs'), path.join(host, hostFile('sea'))], { stdio: 'inherit' });

// 5. Pi, memory and R2 from inside resources/host/.
const smoke = path.join(host, process.platform === 'win32' ? 'smoke-host.exe' : 'smoke-host');
try {
  await buildHostExecutable({ entry: path.join(root, 'scripts', 'package', 'smoke-host.ts'), format: 'sea', executable: smoke });
  const run = spawnSync(smoke, [], { cwd: host, env: hostEnvironment(), encoding: 'utf8', timeout: 300_000, windowsHide: true });
  process.stderr.write(run.stderr ?? '');
  if (run.error) {
    process.stdout.write(run.stdout ?? '');
    const what = run.error.code === 'ETIMEDOUT' ? 'did not finish within 300 s' : `could not be run (${run.error.message})`;
    throw new Error(`the smoke Host ${smoke} ${what}`, { cause: run.error });
  }
  const line = run.stdout.split('\n').find(row => row.startsWith(MARKER));
  assert.ok(line, `no ${MARKER.trim()} report (exit ${run.status ?? run.signal}):\n${run.stdout}`);
  const report = JSON.parse(line.slice(MARKER.length));
  console.log(`[package-smoke] smoke Host ${JSON.stringify({ ok: report.ok, keys: report.keys, piAuth: report.piAuth, memory: report.memory,
    refused: report.refused, agentMemoryMcp: report.agentMemoryMcp, helperHost: report.helperHost, execPath: report.execPath })}`);
  assert.equal(report.ok, true, line);
  assert.equal(run.status, 0, line);
  assert.equal(report.helperHost, 'executable');
  assert.equal(report.agentMemoryMcp, 'admitted');
} finally {
  rmSync(smoke, { force: true });
}

// 6. Sizes.
const installers = readdirSync(out).filter(file => /\.(?:dmg|zip|exe|AppImage|deb)$/.test(file));
const rows = [[`${path.basename(unpacked)} (unpacked)`, bytes(unpacked)], ['resources/host', bytes(host)],
  ...installers.map(file => [file, statSync(path.join(out, file)).size])];
const table = ['| Part | Bytes | Size |', '| --- | ---: | ---: |', ...rows.map(([part, size]) => `| ${part} | ${size} | ${mib(size)} |`)].join('\n');
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Desktop package ${process.platform}-${process.arch}\n\n${table}\n\n`);
console.log(`[package-smoke] ${process.platform}-${process.arch} passed`);
