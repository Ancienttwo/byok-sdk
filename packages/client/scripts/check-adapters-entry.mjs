import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const adaptersExport = manifest.exports?.['./adapters'];

assert.deepEqual(adaptersExport, {
  types: './dist/adapters/index.d.ts',
  import: './dist/adapters/index.js',
});
assert.equal(manifest.optionalDependencies?.['@earendil-works/pi-coding-agent'], undefined);

for (const relativePath of [adaptersExport.import, adaptersExport.types]) {
  assert.equal(existsSync(new URL(`..${relativePath.slice(1)}`, import.meta.url)), true, `${relativePath} is missing`);
}

const bundledEntry = readFileSync(new URL('../dist/adapters/index.js', import.meta.url), 'utf8');
assert.doesNotMatch(bundledEntry, /(?:from|import\()\s*["']ws["']/);
assert.doesNotMatch(bundledEntry, /ws-transport|createDaemon/);

const adapters = await import(new URL('../dist/adapters/index.js', import.meta.url));
assert.deepEqual(
  Object.keys(adapters).sort(),
  ['ClaudeAdapter', 'CodexAdapter', 'PI_PACKAGE_NAME', 'PiAdapter'],
);
assert.equal(new adapters.PiAdapter().id, 'pi');
assert.equal(new adapters.ClaudeAdapter().id, 'claude');
assert.equal(new adapters.CodexAdapter().id, 'codex');

console.log(JSON.stringify({
  adapterEntryBytes: Buffer.byteLength(bundledEntry),
  packageRoot,
  status: 'passed',
}));
