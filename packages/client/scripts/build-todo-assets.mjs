import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const vendor = new URL('vendor/rpiv-todo/2.8.0/', root);
const layout = JSON.parse(await readFile(new URL('src/adapters/pi/todo-locale-layout.json', root), 'utf8'));
const source = JSON.parse(await readFile(new URL('source-manifest.json', vendor), 'utf8'));
const assets = new URL('dist/assets/', root);
const rows = [];
// The frozen inventory covers every third-party input, including files later
// removed by tree shaking; additions or changed bytes require a new inventory.
const thirdParty = JSON.parse(await readFile(new URL('vendor/third-party-manifest.json', root), 'utf8'));
const expectedInputs = new Map(thirdParty.packages.flatMap(pkg => pkg.files.map(file =>
  [`${pkg.name}@${pkg.version}/${file.path}`, file.sha256])));
const meta = JSON.parse(await readFile(new URL('dist/bin/metafile-esm.json', root), 'utf8'));
const observedInputs = new Map();
for (const input of Object.keys(meta.inputs)) {
  if (!input.replaceAll('\\', '/').includes('/node_modules/')) continue;
  const file = path.resolve(fileURLToPath(root), input);
  // Find the owning manifest without resolving or executing package code.
  let directory = path.dirname(file);
  while (true) {
    let pkg;
    try { pkg = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (pkg) {
      const key = `${pkg.name}@${pkg.version}/${path.relative(directory, file).split(path.sep).join('/')}`;
      observedInputs.set(key, createHash('sha256').update(await readFile(file)).digest('hex'));
      break;
    }
    assert.notEqual(path.dirname(directory), directory, `unowned build input ${file}`);
    directory = path.dirname(directory);
  }
}
assert.deepEqual([...observedInputs].sort(), [...expectedInputs].sort(), 'third-party build input drift');
for (const locale of layout.locales) {
  const sourcePath = `locales/${locale}.json`;
  const entry = source.files.find(row => row.path === sourcePath);
  assert.ok(entry, `missing vendor manifest entry ${sourcePath}`);
  const bytes = await readFile(new URL(sourcePath, vendor));
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest, entry.upstreamSha256);
  assert.equal(digest, entry.vendoredSha256);
  const data = JSON.parse(bytes.toString('utf8'));
  assert.ok(data && !Array.isArray(data) && typeof data === 'object');
  assert.ok(Object.values(data).every(value => typeof value === 'string'));
  const path = `${layout.basePath}/${sourcePath}`;
  const target = new URL(path, assets);
  await mkdir(new URL('.', target), { recursive: true });
  await writeFile(target, bytes);
  rows.push({ path, digest });
}
await writeFile(new URL(`${layout.basePath}/manifest.json`, assets), JSON.stringify({
  format: 'byok.todo-locale-assets', version: 1, assets: rows,
}) + '\n');
for (const name of ['LICENSE', 'PROVENANCE.md', 'source-manifest.json']) {
  await copyFile(new URL(name, vendor), new URL(`${layout.basePath}/${name}`, assets));
}
await copyFile(new URL('src/bin/pi-todo-runtime.d.ts', root), new URL('dist/bin/pi-todo-runtime.d.ts', root));
for (const name of ['THIRD-PARTY.md', 'third-party-manifest.json']) {
  await copyFile(new URL(`vendor/${name}`, root), new URL(name, assets));
}
for (const directory of ['pi-tui/0.85.1', 'get-east-asian-width/1.6.0']) {
  const target = new URL(`provenance/${directory}/`, assets);
  await mkdir(target, { recursive: true });
  for (const name of ['LICENSE', 'PROVENANCE.md', 'source-manifest.json']) {
    await copyFile(new URL(`vendor/${directory}/${name}`, root), new URL(name, target));
  }
}
console.log(`sealed todo assets: ${rows.length} exact upstream files`);
