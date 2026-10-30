// #1104 packaging consistency: bundle embedded-host-fixture.ts in one format with
// the SDK packaging plugin, ship it in an empty directory beside only the files
// copySdkPackagingAssets writes, and run it. The run pairs the embedded server and
// daemon, starts Pi through the SDK helper re-entry and completes one dispatch
// against an offline model. See README.md for the per-platform coverage.
//
//   node examples/packaging/embedded-host-smoke.mjs --format esm|cjs|sea
//
// SEA_NODE names the Node binary a SEA is made from (default: this Node). It
// must be an official build: some package-manager builds omit the SEA fuse.
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import postject from 'postject';
import { byokSdkPackaging, copySdkPackagingAssets, sdkBundleImportMetaExemptions } from '@byok-sdk/client/packaging';

const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const MARKER = 'BYOK_EMBEDDED_HOST ';
const here = path.dirname(fileURLToPath(import.meta.url));
const formatArg = process.argv.indexOf('--format');
const format = process.argv[formatArg + 1];
if (formatArg < 0 || !['esm', 'cjs', 'sea'].includes(format)) throw new Error('usage: embedded-host-smoke.mjs --format esm|cjs|sea');

const work = realpathSync(mkdtempSync(path.join(tmpdir(), 'byok-embedded-pack-')));
try {
  // The shipped directory: the SDK assets first (a new directory), then the product file.
  const ship = path.join(work, 'ship');
  const assets = await copySdkPackagingAssets({ outDir: ship, platform: process.platform, arch: process.arch });
  const bundle = path.join(format === 'sea' ? work : ship, format === 'esm' ? 'host.mjs' : 'host.cjs');
  const result = await build({ entryPoints: [path.join(here, 'embedded-host-fixture.ts')], bundle: true, platform: 'node',
    format: format === 'esm' ? 'esm' : 'cjs', target: 'node24', outfile: bundle, logLevel: 'silent', plugins: [byokSdkPackaging({ format })] });
  // The plugin failed the build on any other site. CommonJS reaches every reviewed exemption, so none is stale.
  const exempted = new Set(result.warnings.map(warning => {
    const file = warning.location?.file.replaceAll('\\', '/') ?? '';
    const entry = sdkBundleImportMetaExemptions.find(site => file.endsWith(`node_modules/${site.package}/${site.file}`));
    assert.ok(warning.id === 'empty-import-meta' && entry, `unexpected build warning: ${warning.id} ${file}: ${warning.text}`);
    return `${entry.package}/${entry.file}`;
  }));
  assert.deepEqual([...exempted].sort(), format === 'esm' ? [] : sdkBundleImportMetaExemptions.map(site => `${site.package}/${site.file}`).sort());

  let command = process.execPath, args = [bundle];
  if (format === 'sea') {
    const node = process.env.SEA_NODE ?? process.execPath;
    if (!readFileSync(node).includes(SEA_FUSE)) throw new Error(`${node} has no SEA fuse; set SEA_NODE to an official Node binary`);
    const config = path.join(work, 'sea-config.json'), blob = path.join(work, 'sea.blob');
    writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
    execFileSync(node, ['--experimental-sea-config', config], { stdio: 'inherit' });
    command = path.join(ship, process.platform === 'win32' ? 'host.exe' : 'host');
    copyFileSync(node, command);
    chmodSync(command, 0o755);
    if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', command]);
    await postject.inject(command, 'NODE_SEA_BLOB', readFileSync(blob),
      { sentinelFuse: SEA_FUSE, ...(process.platform === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}) });
    if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', command]);
    args = [];
  }

  // No package resolution can reach the repository from the shipped directory.
  const env = { ...process.env };
  for (const name of ['NODE_PATH', 'NODE_OPTIONS', 'PI_PACKAGE_DIR', 'BYOK_PI_BIN']) delete env[name];
  const run = spawnSync(command, [...args, 'host'], { cwd: ship, env, encoding: 'utf8', timeout: 180_000 });
  process.stderr.write(run.stderr);
  const line = run.stdout.split('\n').find(row => row.startsWith(MARKER));
  assert.ok(line, `no ${MARKER.trim()} report (exit ${run.status ?? run.signal}):\n${run.stdout}`);
  const report = JSON.parse(line.slice(MARKER.length));
  assert.equal(report.ok, true, line);
  assert.equal(run.status, 0, line);
  assert.deepEqual(report.modelRequests, ['POST /v1/chat/completions']);
  assert.equal(report.helperHost, format === 'sea' ? 'executable' : 'node-entry');
  assert.equal(report.agentMemoryMcp, 'admitted');
  // Windows ran Pi under a Job Object through the shipped koffi; macOS and Windows admitted memory through the shipped helper.
  assert.equal(assets.files.includes('native/win32-x64/koffi.node'), process.platform === 'win32');
  assert.equal(assets.agentMemoryHelperAssetRoot !== undefined, process.platform !== 'linux');
  console.log(`[embedded-host-smoke] ${format} on ${process.platform}-${process.arch} passed (${assets.files.length} SDK asset files)`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
