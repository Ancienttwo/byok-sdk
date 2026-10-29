// #1104: the SDK packaging plugin from the installed tarballs. pack-and-smoke.mjs
// copies this file into its clean npm install and runs it there, with the
// repository's esbuild (esbuild is not an SDK dependency). A single-file ESM and
// CJS bundle of a daemon-composing entry build with only the reviewed import.meta
// exemptions, at npm's hoisted paths, and run from an empty directory. Every bin
// of every installed SDK package has a role in the installed distribution manifest.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sdkDistributionManifest } from '@byok-sdk/client';
import { byokSdkPackaging, sdkBundleImportMetaExemptions } from '@byok-sdk/client/packaging';

// A package manifest change runs this smoke, so a new bin in any package fails here until it has a role.
const installedBins = {};
for (const dir of readdirSync(path.resolve('node_modules/@byok-sdk'))) {
  const manifest = JSON.parse(readFileSync(path.resolve('node_modules/@byok-sdk', dir, 'package.json'), 'utf8'));
  for (const name of Object.keys(manifest.bin ?? {})) installedBins[name] = manifest.name;
}
assert.deepEqual(Object.fromEntries(Object.entries(sdkDistributionManifest.bins).map(([name, bin]) => [name, bin.package]).sort()),
  Object.fromEntries(Object.entries(installedBins).sort()), 'every published bin has a role in sdkDistributionManifest.bins');
console.log(`[release-pack] all ${Object.keys(installedBins).length} installed SDK bins are classified`);

const esbuildArg = process.argv.indexOf('--esbuild');
if (esbuildArg < 0) throw new Error('usage: packaging-plugin-smoke.mjs --esbuild <esbuild main>');
const { build } = await import(pathToFileURL(process.argv[esbuildArg + 1]).href);
const MARKER = 'BYOK_PACKAGING_PLUGIN ';
const entry = path.resolve('packaging-plugin-entry.mjs');
writeFileSync(entry, [
  "import { bundledSdkHelperHost, createDaemon, runSdkReservedHelperCommand } from '@byok-sdk/client';",
  "import { createByokServer } from '@byok-sdk/server';",
  '// No top-level await: the CommonJS bundle rejects it.',
  'void runSdkReservedHelperCommand().then(handled => {',
  '  if (handled) return;',
  "  const root = process.argv[2];",
  "  const daemon = createDaemon({ localAgentRelease: { version: '0.0.0-packaging' }, productName: 'Packaging', productId: 'packaging-plugin',",
  "    serverUrl: 'http://127.0.0.1:0', storeDir: root + '/store', storage: { scratchRoot: root }, sdkHelperHost: bundledSdkHelperHost() });",
  `  console.log(${JSON.stringify(MARKER)} + JSON.stringify({ server: typeof createByokServer, paired: daemon.status().paired, helperHost: bundledSdkHelperHost().entry !== undefined }));`,
  '});',
].join('\n'));
const work = realpathSync(mkdtempSync(path.join(tmpdir(), 'byok-packed-plugin-')));
try {
  for (const format of ['esm', 'cjs']) {
    const outfile = path.join(work, format === 'esm' ? 'host.mjs' : 'host.cjs');
    const result = await build({ entryPoints: [entry], bundle: true, platform: 'node', format, target: 'node24', outfile,
      logLevel: 'silent', plugins: [byokSdkPackaging({ format })] });
    const sites = new Set(result.warnings.map(warning => {
      const file = warning.location?.file.replaceAll('\\', '/') ?? '';
      const site = sdkBundleImportMetaExemptions.find(entry => file.endsWith(`node_modules/${entry.package}/${entry.file}`));
      assert.ok(warning.id === 'empty-import-meta' && site, `${format}: unexpected warning ${warning.id} ${file}`);
      return `${site.package}/${site.file}`;
    }));
    if (format === 'esm') assert.deepEqual([...sites], []);
    // Runtime Unix sockets live under the scratch root, so it stays short.
    const scratch = realpathSync(mkdtempSync(path.join(process.platform === 'win32' ? tmpdir() : '/tmp', 'byok-pp-')));
    const run = spawnSync(process.execPath, [outfile, scratch], { cwd: work, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
    assert.equal(run.status, 0, `${format}: ${run.stdout}${run.stderr}`);
    const line = run.stdout.split('\n').find(row => row.startsWith(MARKER));
    assert.deepEqual(JSON.parse(line.slice(MARKER.length)), { server: 'function', paired: false, helperHost: true }, format);
    rmSync(scratch, { recursive: true, force: true });
    console.log(`[release-pack] installed byokSdkPackaging ${format} bundle builds and runs (${sites.size} reviewed import.meta exemptions)`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
