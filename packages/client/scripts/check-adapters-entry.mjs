import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
if (process.argv.includes('--build-todo')) {
  const dist = path.join(packageRoot, 'dist');
  const before = new Map(readdirSync(dist, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => {
      const file = path.join(entry.parentPath, entry.name);
      return [file, createHash('sha256').update(readFileSync(file)).digest('hex')];
    }));
  assert.ok(before.size > 0, 'main tsup must run before the private todo build');
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync('bun', ['run', 'tsup', '--config', 'tsup.todo.config.ts'], {
    cwd: packageRoot, stdio: 'inherit',
  });
  assert.equal(result.status, 0, 'private todo build failed');
  const meta = JSON.parse(readFileSync(path.join(dist, 'bin/metafile-esm.json'), 'utf8'));
  const inputs = Object.keys(meta.inputs).map(file => path.relative(packageRoot, path.resolve(packageRoot, file)).split(path.sep).join('/'));
  assert.deepEqual(inputs.filter(file => /vendor\/(pi-tui|get-east-asian-width)\//.test(file)).sort(), [
    'vendor/pi-tui/0.85.1/components/text.js', 'vendor/pi-tui/0.85.1/utils.js',
    ...['index.js', 'lookup.js', 'lookup-data.js', 'utilities.js'].map(file => `vendor/get-east-asian-width/1.6.0/${file}`),
  ].sort());
  assert.equal(inputs.some(file => /node_modules\/(?:@earendil-works\/pi-tui|get-east-asian-width)\//.test(file)), false,
    'private UI subtree must not resolve an npm copy');
  for (const [file, digest] of before) {
    assert.equal(createHash('sha256').update(readFileSync(file)).digest('hex'), digest,
      `private todo build overwrote main dist: ${path.relative(dist, file)}`);
  }
  console.log(`private todo build preserved all ${before.size} main dist file digests`);
  process.exit(0);
}
const adaptersExport = manifest.exports?.['./adapters'];

assert.deepEqual(adaptersExport, {
  types: './dist/adapters/index.d.ts',
  import: './dist/adapters/index.js',
});
// The pin projection is internal to the client manifest, so it is checked
// first, before anything reads the install: drift here is refused before
// module loading and with no install present.
assert.equal(manifest.byok?.piRuntimePin, manifest.dependencies?.['@earendil-works/pi-coding-agent'],
  'client byok.piRuntimePin must exactly project dependency alias');
// Exact official semver pin. The installed manifest must be the official
// package at exactly that version; integrity and provenance are the release
// identity gate's (`scripts/release/pi-runtime-identity.mjs`), not this
// entry check's. Fail closed when the install is missing or differs.
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/u;
const nativeManifest = JSON.parse(readFileSync(
  new URL('../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url), 'utf8'));
assert.equal(nativeManifest.name, '@earendil-works/pi-coding-agent',
  'installed @earendil-works/pi-coding-agent must be the official package, not an alias');
assert.match(manifest.dependencies?.['@earendil-works/pi-coding-agent'] ?? '', EXACT_SEMVER,
  'client @earendil-works/pi-coding-agent pin must be an exact semver');
assert.equal(manifest.dependencies?.['@earendil-works/pi-coding-agent'], nativeManifest.version);
assert.equal(manifest.optionalDependencies?.['@earendil-works/pi-coding-agent'], undefined);
assert.equal(manifest.dependencies?.['pi-web-access'], '0.24.1');
assert.equal(manifest.dependencies?.['pi-subagents'], undefined);
assert.equal(manifest.devDependencies?.['pi-subagents'], '0.60.0');
// The MCP client this package's own core is built on. `pi-mcp-adapter` is
// retired: the SDK owns its MCP connection, observation and tool projection
// (`src/mcp/`), so there is no second MCP authority in the graph to pin.
assert.equal(manifest.dependencies?.['@modelcontextprotocol/client'], '2.0.0');
assert.equal(manifest.dependencies?.['pi-mcp-adapter'], undefined);
assert.equal(manifest.dependencies?.['@juicesharp/rpiv-todo'], undefined);
assert.equal(manifest.dependencies?.['@juicesharp/rpiv-i18n'], '2.8.0');
assert.equal(manifest.dependencies?.['@earendil-works/pi-tui'], undefined);
assert.equal(manifest.devDependencies?.['@earendil-works/pi-tui'], undefined);
// Upstream publishes its packages in lockstep, so every package of the
// pure-JavaScript coding-agent closure is pinned exactly at the coding-agent
// version and installed at that version. `pi-tui` ships prebuilt `.node`
// addons, so it cannot be a direct dependency (release-graph purity gate);
// its version and integrity are held by `scripts/release/pi-runtime-identity.mjs`.
for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-agent-core', '@earendil-works/chord', '@earendil-works/pi-telemetry']) {
  assert.equal(manifest.dependencies?.[name], nativeManifest.version,
    `client ${name} pin must equal the exact @earendil-works/pi-coding-agent version`);
  const installed = JSON.parse(readFileSync(new URL(`../node_modules/${name}/package.json`, import.meta.url), 'utf8'));
  assert.equal(installed.name, name);
  assert.equal(installed.version, nativeManifest.version, `installed ${name} must be ${nativeManifest.version}`);
}
assert.equal(existsSync(new URL('../dist/adapters/pi/team-interaction-extension.js', import.meta.url)), true);
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
  ['ClaudeAdapter', 'CodexAdapter', 'PI_PACKAGE_NAME', 'PiAdapter', 'RuntimeDisposalFailure', 'RuntimeExecutionFailure', 'RuntimeStartupDisposalFailure'],
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
assert.equal(root.isRuntimeStartupDisposalFailure(new adapters.RuntimeStartupDisposalFailure(async () => {})), true);
assert.equal(new adapters.PiAdapter().descriptor.id, 'pi');
assert.equal(new adapters.ClaudeAdapter().descriptor.id, 'claude');
assert.equal(new adapters.CodexAdapter().descriptor.id, 'codex');

// The SDK root must not evaluate the prepared-input compile graph just because
// it was imported. The compile calls the official public entry
// `@earendil-works/pi-ai/api/openai-completions`, which statically loads the
// `openai` client; the daemon is reachable from the root entry, so a static
// edge there would make every consumer of `@byok-sdk/client` load a provider
// layer it may never prepare input with. (The pi-ai root and the coding-agent
// root load only `openai-completions.lazy.js`, never the module itself.) The
// check is a real module graph, in a child process, not a source grep.
const loadProbe = `
import { registerHooks } from 'node:module';
const loaded = [];
registerHooks({
  load(url, context, next) {
    loaded.push(url);
    return next(url, context);
  },
});
const native = () => loaded.filter((url) => url.includes('/@earendil-works/pi-ai/dist/api/openai-completions.js'));
await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
if (native().length > 0) {
  console.error('the SDK root eagerly loaded the prepared-input compile graph: ' + native().join(', '));
  process.exit(1);
}
// And the lazy load still resolves: absent-because-broken would pass the test above.
await import('@earendil-works/pi-ai/api/openai-completions');
if (native().length === 0) {
  console.error('the official compile entry did not load on demand');
  process.exit(1);
}
`;
const { spawnSync } = await import('node:child_process');
const probe = spawnSync(process.execPath, ['--input-type=module', '-e', loadProbe], {
  cwd: packageRoot,
  encoding: 'utf8',
});
assert.equal(probe.status, 0, `native lazy-load probe failed: ${probe.stderr || probe.stdout}`);

console.log(JSON.stringify({
  adapterEntryBytes: Buffer.byteLength(bundledEntry),
  packageRoot,
  status: 'passed',
}));
