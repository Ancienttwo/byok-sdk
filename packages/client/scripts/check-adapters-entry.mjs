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
// Exact npm alias onto the SDK's Pi fork: the specifier and the installed path
// stay upstream, the resolved manifest is @byok-sdk/pi-coding-agent@0.85.1005.
assert.equal(manifest.dependencies?.['@earendil-works/pi-coding-agent'], 'npm:@byok-sdk/pi-coding-agent@0.85.1005');
assert.equal(manifest.byok?.piRuntimePin, manifest.dependencies?.['@earendil-works/pi-coding-agent'],
  'client byok.piRuntimePin must exactly project dependency alias');
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
assert.equal(manifest.dependencies?.['@earendil-works/pi-ai'],
  manifest.byok.piRuntimePin.replace('pi-coding-agent@', 'pi-ai@'), 'Pi AI and coding-agent fork pins must match');
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

// The SDK root must not evaluate the native prepared-input graph just because
// it was imported. That subpath reaches the fork's provider layer and the
// `openai` client, and the daemon is reachable from the root entry, so a static
// import there would make every consumer of `@byok-sdk/client` pay for — and
// load — a runtime it may never prepare input with. The check is a real module
// graph, in a child process, not a source grep: what matters is what the loader
// actually pulled in.
const loadProbe = `
import { registerHooks } from 'node:module';
const loaded = [];
registerHooks({
  load(url, context, next) {
    loaded.push(url);
    return next(url, context);
  },
});
const native = () => loaded.filter((url) => url.includes('prepared-session-input'));
await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
if (native().length > 0) {
  console.error('the SDK root eagerly loaded the native prepared-input graph: ' + native().join(', '));
  process.exit(1);
}
// And the lazy load still resolves: absent-because-broken would pass the test above.
await import('@earendil-works/pi-coding-agent/prepared-session-input');
if (native().length === 0) {
  console.error('the native prepared-input subpath did not load on demand');
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
