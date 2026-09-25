import { verifyOfficialPiClosure } from '../src/adapters/pi/official-pi-installation.mjs';
import { fileURLToPath as officialFileURLToPath } from 'node:url';
verifyOfficialPiClosure(officialFileURLToPath(new URL('../', import.meta.url)));
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const native = new URL('node_modules/@earendil-works/pi-coding-agent/', root);
const layoutBytes = await readFile(new URL('src/adapters/pi/pi-export-asset-layout.json', root));
const sourceBytes = await readFile(new URL('src/adapters/pi/pi-export-assets.source.json', root));
const layout = JSON.parse(layoutBytes), source = JSON.parse(sourceBytes);
const clientManifest = JSON.parse(await readFile(new URL('package.json', root)));
const nativeManifest = JSON.parse(await readFile(new URL('package.json', native)));
// The pin is the exact official semver; `check-adapters-entry.mjs` proves it
// projects the coding-agent dependency. Runtime identity (integrity and
// provenance) is the identity gate's, not this inventory's.
assert.equal(clientManifest.byok.piRuntimePin, source.packageVersion);
assert.equal(nativeManifest.name, source.packageName);
assert.equal(nativeManifest.version, source.packageVersion);
assert.deepEqual(source.files.map(row => row.path), layout.files);
assert.equal(source.sourceBasePath, layout.basePaths['interpreter+bundle']);
for (const row of source.files) {
  const bytes = await readFile(new URL(`${source.sourceBasePath}/${row.path}`, native));
  assert.equal(bytes.length, row.bytes, `export resource size drift: ${row.path}`);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256, `export resource digest drift: ${row.path}`);
}
const output = new URL('dist/assets/pi-export-html/', root);
await mkdir(output, { recursive: true });
// Metadata only: resource originals remain supplied by the exact native pin.
const emittedLayout = { ...layout, assetsByForm: Object.fromEntries(Object.entries(layout.basePaths).map(([form, base]) =>
  [form, source.files.map(row => ({ path: `${base}/${row.path}`, digest: row.sha256 }))])) };
await writeFile(new URL('layout.json', output), JSON.stringify(emittedLayout, null, 2) + '\n');
await writeFile(new URL('source-manifest.json', output), sourceBytes);
console.log(`Pi export inventory: ${source.files.length} pinned native assets verified; metadata emitted`);
