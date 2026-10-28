// Tests for the upgrade-manifest gate (#1102).
//
// Each test copies the inputs the snapshot reads into a scratch root, freezes
// that copy as the released baseline with an empty manifest, then makes one
// Host-visible change and runs the gate. The repository's own manifest is not
// read here: `bun run check:upgrade-manifest` gates it.

import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from './check-upgrade-manifest.mjs';
import { packageSurface, splitStatements } from './upgrade-manifest/dts-surface.mjs';
import { BASELINE_PATH, MANIFEST_PATH, breakingAllowed, bumpKind, markdownAnchors, renderManifest, serialize } from './upgrade-manifest/manifest.mjs';
import { PUBLIC_PACKAGES, STORES, VENDORED_EXAMPLES, buildSnapshot } from './upgrade-manifest/snapshot.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DOC = 'docs/migration.md';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'byok-upgrade-manifest-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const copy = (relative) => cpSync(path.join(repo, relative), path.join(root, relative), {
    recursive: true,
    filter: (source) => !/[\\/](?:node_modules|dist)(?:[\\/]|$)/.test(source),
  });
  copy('api-surface');
  for (const pkg of PUBLIC_PACKAGES) copy(`packages/${pkg}/package.json`);
  for (const store of STORES) copy(store.source);
  copy('packages/keys/src');
  for (const example of VENDORED_EXAMPLES) {
    copy(`examples/${example.id}/package.json`);
    copy(`examples/${example.id}/src`);
  }
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, DOC), '# Migration\n\n## Removed export\n\n## New event\n\n## Store bump\n');
  const baseline = buildSnapshot(root);
  mkdirSync(path.dirname(path.join(root, BASELINE_PATH)), { recursive: true });
  writeFileSync(path.join(root, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`);
  writeFileSync(path.join(root, MANIFEST_PATH), serialize(renderManifest(baseline, baseline, [])));
  return {
    root,
    edit(relative, transform) {
      const file = path.join(root, relative);
      const before = readFileSync(file, 'utf8');
      const after = transform(before);
      assert.notEqual(after, before, `${relative} edit did not apply`);
      writeFileSync(file, after);
    },
    setVersion(version) {
      this.edit('packages/client/package.json', (text) => text.replace(/"version": "[^"]+"/, `"version": "${version}"`));
    },
    entries(entries) {
      const file = path.join(root, MANIFEST_PATH);
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      manifest.entries = entries;
      writeFileSync(file, serialize(manifest));
    },
    gate(...argv) {
      const lines = [];
      const log = { log: (line) => lines.push(line), error: (line) => lines.push(line) };
      const status = run(['--root', root, ...argv], log);
      return { status, output: lines.join('\n') };
    },
  };
}

// Drops `name` from an `export { ... } from` list, as a removed public
// re-export shows up in the golden.
function removeExport(text, name) {
  return text.replace(new RegExp(`^(export \\{[^}\\n]*?)\\b${name}, `, 'm'), '$1');
}

test('an unchanged tree passes and the snapshot is deterministic', (t) => {
  const f = fixture(t);
  assert.deepEqual(f.gate(), { status: 0, output: `[upgrade-manifest] ok: ${buildSnapshot(f.root).version} -> ${buildSnapshot(f.root).version}, ${Object.keys(buildSnapshot(f.root).items).length} items` });
  assert.equal(JSON.stringify(buildSnapshot(f.root)), JSON.stringify(buildSnapshot(f.root)));
  // A CRLF checkout snapshots identically.
  const before = JSON.stringify(buildSnapshot(f.root).items);
  f.edit('api-surface/core.d.ts', (text) => text.replace(/\n/g, '\r\n'));
  f.edit('packages/server/src/stores/sqlite/index.ts', (text) => text.replace(/\n/g, '\r\n'));
  assert.equal(JSON.stringify(buildSnapshot(f.root).items), before);
});

test('removing a public export demands a breaking entry with a migration anchor', (t) => {
  const f = fixture(t);
  f.edit('api-surface/core.d.ts', (text) => removeExport(text, 'DEVICE_PROOF_HEADER'));
  const item = 'export:@byok-sdk/core#DEVICE_PROOF_HEADER';
  let result = f.gate();
  assert.equal(result.status, 1);
  assert.match(result.output, new RegExp(`${item} removed since \\S+ without a manifest entry`));

  f.entries([{ id: 'drop-header', impact: 'additive', summary: 'Use the literal header name.', migration: `${DOC}#removed-export`, items: [item] }]);
  assert.match(f.gate().output, /is removed, so the entry must be breaking/);

  f.entries([{ id: 'drop-header', impact: 'breaking', summary: 'Use the literal header name.', migration: `${DOC}#no-such-heading`, items: [item] }]);
  assert.match(f.gate().output, /has no heading for #no-such-heading/);

  f.entries([{ id: 'drop-header', impact: 'breaking', summary: '', migration: `${DOC}#removed-export`, items: [item] }]);
  assert.match(f.gate().output, /summary \(the migration note\) is required/);

  f.entries([{ id: 'drop-header', impact: 'breaking', summary: 'Use the literal header name.', migration: `${DOC}#removed-export`, items: [item] }]);
  result = f.gate();
  assert.equal(result.status, 1);
  assert.match(result.output, /generated fields are stale/);
  result = f.gate('--write');
  assert.equal(result.status, 0, result.output);
  const manifest = JSON.parse(readFileSync(path.join(f.root, MANIFEST_PATH), 'utf8'));
  assert.deepEqual(manifest.changes, [{ item, change: 'removed', entry: 'drop-header' }]);
  assert.equal(f.gate().status, 0);
});

test('changing an exported signature demands an entry; a comment-only edit does not', (t) => {
  const f = fixture(t);
  f.edit('api-surface/core.d.ts', (text) => text.replace(
    'export declare const DEVICE_PROOF_HEADER = "x-byok-device-proof";',
    '/** reworded */\nexport declare const DEVICE_PROOF_HEADER = "x-byok-device-proof";',
  ));
  assert.equal(f.gate().status, 0);
  f.edit('api-surface/core.d.ts', (text) => text.replace('"x-byok-device-proof";', '"x-byok-device-proof-v2";'));
  assert.match(f.gate().output, /export:@byok-sdk\/core#DEVICE_PROOF_HEADER changed since/);
});

test('adding an event union member demands an entry', (t) => {
  const f = fixture(t);
  f.edit('api-surface/protocol.d.ts', (text) => text.replace(
    'export declare const AgentEventSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{\n',
    'export declare const AgentEventSchema: z.ZodDiscriminatedUnion<[z.ZodObject<{\n    type: z.ZodLiteral<"plan_update">;\n}, z.core.$strip>, z.ZodObject<{\n',
  ));
  const result = f.gate();
  assert.equal(result.status, 1);
  assert.match(result.output, /union:agent-event#plan_update added since \S+ without a manifest entry/);
  f.entries([{
    id: 'plan-update-event',
    impact: 'additive',
    summary: 'Runtimes may emit plan_update; an exhaustive switch must handle it.',
    migration: `${DOC}#new-event`,
    items: ['export:@byok-sdk/protocol#AgentEventSchema', 'union:agent-event#plan_update'],
  }]);
  assert.equal(f.gate('--write').status, 0);
});

test('bumping a store format version demands an entry with an acceptance policy', (t) => {
  const f = fixture(t);
  f.edit('packages/server/src/stores/sqlite/index.ts', (text) => text.replace(/^const SQLITE_SCHEMA_VERSION = '(\d+)';$/m, (_, v) => `const SQLITE_SCHEMA_VERSION = '${Number(v) + 1}';`));
  assert.match(f.gate().output, /store:server-sqlite changed since \S+ without a manifest entry/);
  const entry = { id: 'sqlite-next', impact: 'additive', summary: 'Start on a new state path and pair again.', migration: `${DOC}#store-bump`, items: ['store:server-sqlite'] };
  f.entries([entry]);
  assert.match(f.gate().output, /a changed store needs acceptance/);
  f.entries([{ ...entry, acceptance: 'new-path-repair' }]);
  assert.match(f.gate().output, /acceptance new-path-repair makes the entry breaking/);
  f.entries([{ ...entry, impact: 'breaking', acceptance: 'new-path-repair' }]);
  assert.equal(f.gate('--write').status, 0);
  const manifest = JSON.parse(readFileSync(path.join(f.root, MANIFEST_PATH), 'utf8'));
  assert.match(manifest.changes[0].before, /^schema_version=\d+$/);
  assert.notEqual(manifest.changes[0].before, manifest.changes[0].after);
});

test('a SQL DDL change or a migration file changes the store identity', (t) => {
  const f = fixture(t);
  f.edit('packages/client/src/daemon/journal/sqlite-journal.ts', (text) => text.replace('CREATE TABLE IF NOT EXISTS journal_task (', 'CREATE TABLE IF NOT EXISTS journal_task (\n  extra TEXT,'));
  writeFileSync(path.join(f.root, 'deploy/sql/9999_example.sql'), 'SELECT 1;\n');
  const output = f.gate().output;
  assert.match(output, /store:client-journal changed/);
  assert.match(output, /store:cloud-dataplane-postgres changed/);
});

test('a bin, an entry and a vendored example change are items', (t) => {
  const f = fixture(t);
  f.edit('packages/client/package.json', (text) => text.replace('"bin": {', '"bin": {\n    "byok-agent-next": "./dist/bin/next.js",'));
  f.edit('api-surface/entries.json', (text) => text.replace('"@byok-sdk/client/testing": {', '"@byok-sdk/client/testing-next": {\n    "kind": "exports",\n    "facts": { "target": "packages/client/dist/next.js", "types": [] }\n  },\n  "@byok-sdk/client/testing": {'));
  writeFileSync(path.join(f.root, 'examples/host-execution-core/src/new-module.ts'), 'export const x = 1;\n');
  const output = f.gate().output;
  assert.match(output, /bin:byok-agent-next added/);
  assert.match(output, /entry:@byok-sdk\/client\/testing-next added/);
  assert.match(output, /example:host-execution-core changed/);
});

test('a PATCH bump with a breaking entry fails (Q8); a MINOR bump passes', (t) => {
  const f = fixture(t);
  const released = buildSnapshot(f.root).version;
  const [major, minor, patch] = released.split(/[.-]/).map(Number);
  f.edit('api-surface/core.d.ts', (text) => removeExport(text, 'DEVICE_PROOF_HEADER'));
  f.entries([{ id: 'drop-header', impact: 'breaking', summary: 'Use the literal header name.', migration: `${DOC}#removed-export`, items: ['export:@byok-sdk/core#DEVICE_PROOF_HEADER'] }]);
  let result = f.gate('--write');
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /the next release after \S+ must be a MINOR/);

  f.setVersion(`${major}.${minor}.${patch + 1}`);
  result = f.gate('--write');
  assert.equal(result.status, 1);
  assert.match(result.output, /is a PATCH after .* but carries breaking entries \(drop-header\); breaking changes ship only in a MINOR before 1\.0 \(Q8\)/);

  f.setVersion(`${major}.${minor + 1}.0`);
  assert.equal(f.gate('--write').status, 0);
});

test('a PATCH bump with only additive entries passes', (t) => {
  const f = fixture(t);
  const [major, minor, patch] = buildSnapshot(f.root).version.split(/[.-]/).map(Number);
  f.edit('packages/client/package.json', (text) => text.replace('"bin": {', '"bin": {\n    "byok-agent-next": "./dist/bin/next.js",'));
  f.entries([{ id: 'new-bin', impact: 'additive', summary: 'A new helper bin; classify it in packaging scripts.', migration: 'https://github.com/Ancienttwo/byok-sdk/issues/1102', items: ['bin:byok-agent-next'] }]);
  f.setVersion(`${major}.${minor}.${patch + 1}`);
  assert.equal(f.gate('--write').status, 0);
});

test('entries cannot cover unchanged items, repeat an item, or carry unknown fields', (t) => {
  const f = fixture(t);
  f.edit('api-surface/core.d.ts', (text) => removeExport(text, 'DEVICE_PROOF_HEADER'));
  const item = 'export:@byok-sdk/core#DEVICE_PROOF_HEADER';
  const base = { impact: 'breaking', summary: 'x', migration: `${DOC}#removed-export` };
  f.entries([
    { id: 'a', ...base, items: [item, 'export:@byok-sdk/core#DEVICE_PROOF_VERSION'] },
    { id: 'b', ...base, items: [item], note: 'extra' },
  ]);
  const output = f.gate().output;
  assert.match(output, /entry a: export:@byok-sdk\/core#DEVICE_PROOF_VERSION did not change since \S+; remove it/);
  assert.match(output, /entry b: .* is already covered by entry a/);
  assert.match(output, /entry b: unknown field note/);
});

test('rebaseline snapshots a release checkout and refuses a version that is not newer', (t) => {
  const f = fixture(t);
  assert.throws(() => run(['--root', f.root, '--rebaseline', f.root], { log() {}, error() {} }), /not newer than the baseline/);
  const release = fixture(t);
  const [major, minor] = buildSnapshot(release.root).version.split('.').map(Number);
  release.setVersion(`${major}.${minor + 1}.0`);
  f.setVersion(`${major}.${minor + 1}.0`);
  assert.equal(run(['--root', f.root, '--rebaseline', release.root], { log() {}, error() {} }), 0);
  const manifest = JSON.parse(readFileSync(path.join(f.root, MANIFEST_PATH), 'utf8'));
  assert.equal(manifest.from.version, `${major}.${minor + 1}.0`);
  assert.deepEqual(manifest.entries, []);
});

test('version bump rules', () => {
  assert.equal(bumpKind('0.30.2', '0.30.2'), 'none');
  assert.equal(bumpKind('0.30.2', '0.30.3'), 'patch');
  assert.equal(bumpKind('0.30.2', '0.31.0-rc.1'), 'minor');
  assert.equal(bumpKind('0.30.2', '1.0.0'), 'major');
  assert.throws(() => bumpKind('0.30.2', '0.30.1'), /older than the released baseline/);
  assert.equal(breakingAllowed('0.30.2', '0.30.3'), false);
  assert.equal(breakingAllowed('0.30.2', '0.31.0'), true);
  assert.equal(breakingAllowed('1.2.0', '1.3.0'), false);
  assert.equal(breakingAllowed('1.2.0', '2.0.0'), true);
});

test('markdown anchors follow GitHub heading slugs', () => {
  const anchors = markdownAnchors('# Tool authorization: `auto` and `all` (#1061)\n## Same\n## Same\n```\n# not a heading\n```\n<a id="custom"></a>\n');
  assert.deepEqual([...anchors].sort(), ['custom', 'same', 'same-1', 'tool-authorization-auto-and-all-1061']);
});

test('the declaration parser resolves re-exports and digests non-public closure', () => {
  const golden = [
    '// ==== @x/p dist/index.d.ts ====',
    "export * from './a.js';",
    "export { Inner as Renamed } from './b.js';",
    "export { z } from 'zod';",
    '// ==== @x/p dist/a.d.ts ====',
    "import type { Hidden } from './b.js';",
    'export interface Shown { readonly hidden: Hidden; readonly url: "https://x/{y}" }',
    '// ==== @x/p dist/b.d.ts ====',
    'export type Hidden = `id-${string}`;',
    'export declare function Inner(): void;',
  ].join('\n');
  const surface = (text) => packageSurface({ golden: text, entryFiles: new Map([['@x/p', 'dist/index.d.ts']]) }).entries.get('@x/p');
  const first = surface(golden);
  assert.deepEqual([...first.keys()].sort(), ['Renamed', 'Shown', 'z']);
  // Hidden is not public, so a change to it changes Shown's digest.
  const changed = surface(golden.replace('`id-${string}`', '`key-${string}`'));
  assert.notEqual(changed.get('Shown'), first.get('Shown'));
  assert.equal(changed.get('Renamed'), first.get('Renamed'));
  assert.deepEqual(splitStatements('interface A { b: { c: 1 } }\ntype D = { e: 2 };\n'), ['interface A { b: { c: 1 } }', 'type D = { e: 2 }']);
  assert.throws(() => surface(`${golden}\nexport = Foo;`), /unsupported declaration statement/);
});
