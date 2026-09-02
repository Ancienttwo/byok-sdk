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
assert.equal(manifest.dependencies?.['@earendil-works/pi-coding-agent'], '0.84.2');
assert.equal(manifest.optionalDependencies?.['@earendil-works/pi-coding-agent'], undefined);
assert.equal(manifest.dependencies?.['pi-web-access'], '0.24.1');
assert.equal(manifest.dependencies?.['pi-mcp-adapter'], '2.27.0');
assert.equal(manifest.dependencies?.['pi-subagents'], '0.60.0');
assert.equal(manifest.dependencies?.['@juicesharp/rpiv-todo'], '2.8.0');
assert.equal(existsSync(new URL('../dist/adapters/pi/mcp-extension.js', import.meta.url)), true);
assert.equal(existsSync(new URL('../dist/adapters/pi/subagents-policy-extension.js', import.meta.url)), true);

for (const relativePath of [adaptersExport.import, adaptersExport.types]) {
  assert.equal(existsSync(new URL(`..${relativePath.slice(1)}`, import.meta.url)), true, `${relativePath} is missing`);
}

const bundledEntry = readFileSync(new URL('../dist/adapters/index.js', import.meta.url), 'utf8');
assert.doesNotMatch(bundledEntry, /(?:from|import\()\s*["']ws["']/);
assert.doesNotMatch(bundledEntry, /ws-transport|createDaemon/);

const adapters = await import(new URL('../dist/adapters/index.js', import.meta.url));
const root = await import(new URL('../dist/index.js', import.meta.url));
assert.deepEqual(
  Object.keys(adapters).sort(),
  ['ClaudeAdapter', 'CodexAdapter', 'PI_PACKAGE_NAME', 'PiAdapter', 'RuntimeDisposalFailure', 'RuntimeExecutionFailure'],
);
const crossEntryFailure = new adapters.RuntimeExecutionFailure({
  phase: 'start',
  category: 'infrastructure',
  retry: 'retryable',
  reason: 'adapter-entry-smoke',
});
assert.equal(crossEntryFailure.retry, 'retryable');
assert.equal(root.isRuntimeExecutionFailure(crossEntryFailure), true);
const crossEntryDisposalFailure = new adapters.RuntimeDisposalFailure({
  stage: 'quiescence',
  reason: 'adapter-entry-disposal-smoke',
});
assert.equal(root.isRuntimeDisposalFailure(crossEntryDisposalFailure), true);
assert.equal(new adapters.PiAdapter().descriptor.id, 'pi');
assert.equal(new adapters.ClaudeAdapter().descriptor.id, 'claude');
assert.equal(new adapters.CodexAdapter().descriptor.id, 'codex');

console.log(JSON.stringify({
  adapterEntryBytes: Buffer.byteLength(bundledEntry),
  packageRoot,
  status: 'passed',
}));
