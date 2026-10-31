import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSources, inspectRepository, inspectExamplePortability, compareBaseline, compareBaselineHistory, cycleEdges, checkDependencyDirection, graphSourcePath, sourceOwner, directoryLayer } from './dependency-graph.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'byok-direction-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { const target = path.join(root, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, text); return target; };
  const pkg = (name, dependencies = {}) => write(`packages/${name}/package.json`, JSON.stringify({ name: `@byok-sdk/${name}`, dependencies, exports: { '.': { import: './dist/index.js' }, './leaf': { import: './dist/leaf.js' } } }));
  return { root, write, pkg };
}

/** A temporary copy of the real workspace sources, so the portability regression exercises the shipped K4/K8 graph, not a mock. */
function repositorySubset(t) {
  const repo = path.resolve(import.meta.dirname, '../..');
  const root = mkdtempSync(path.join(tmpdir(), 'byok-portability-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skipGenerated = source => !source.split(path.sep).some(part => part === 'node_modules' || part === 'dist');
  cpSync(path.join(repo, 'packages'), path.join(root, 'packages'), { recursive: true, filter: skipGenerated });
  cpSync(path.join(repo, 'examples/bot-collaboration'), path.join(root, 'examples/bot-collaboration'), { recursive: true, filter: skipGenerated });
  return root;
}

test('installed TypeScript AST distinguishes type syntax from runtime expressions (API drift sentinel)', t => {
  const f = fixture(t);
  const file = f.write('input.ts', `
    import type { A } from 'type-clause';
    import { type A, type B as C } from 'type-members';
    import { type A, b } from 'mixed';
    import type from 'default-named-type';
    import {} from 'empty';
    import 'side-effect';
    export type * from 'export-type';
    export { type A } from 'export-members';
    export * from 'export-value';
    type T = import('type-query').T;
    type Q = typeof import('typeof-query');
    const promise = import('dynamic-assignment');
    const promises = [import('dynamic-array')];
    const object = { load: import('dynamic-property') };
    const templated = import(\`dynamic-template\`);
    const required = require('commonjs');
    import equals = require('equals');
    const sqlite = process.getBuiltinModule('node:sqlite');
    // import('comment')
    const text = "import('string')";
  `);
  const parsed = parseSources(f.root, [file]).get(file);
  assert.deepEqual(parsed.edges.map(({ specifier, kind }) => [specifier, kind]), [
    ['type-clause', 'type'], ['type-members', 'type'], ['mixed', 'value'],
    ['default-named-type', 'value'], ['empty', 'value'], ['side-effect', 'value'],
    ['export-type', 'type'], ['export-members', 'type'], ['export-value', 'value'],
    ['type-query', 'type'], ['typeof-query', 'type'], ['dynamic-assignment', 'value'],
    ['dynamic-array', 'value'], ['dynamic-property', 'value'], ['dynamic-template', 'value'],
    ['commonjs', 'value'], ['equals', 'value'],
  ]);
  // `process.getBuiltinModule` is a runtime load with no import statement.
  assert.deepEqual(parsed.builtins.map(({ specifier, form }) => [specifier, form]), [['node:sqlite', 'get-builtin-module']]);
});

test('workspace values must be declared and lower-layer; type-only imports do not create runtime edges', t => {
  const f = fixture(t);
  f.pkg('core', { '@byok-sdk/cloud': 'workspace:*' }); f.pkg('cloud'); f.pkg('client');
  f.write('packages/core/src/index.ts', 'export const core = 1;');
  f.write('packages/core/src/leaf.ts', 'export const leaf = 1;');
  f.write('packages/cloud/src/index.ts', 'export const cloud = 1;');
  f.write('packages/client/src/index.ts', "import type { cloud } from '@byok-sdk/cloud'; import { leaf } from '@byok-sdk/core/leaf';");
  assert.deepEqual(inspectRepository(f.root), [
    'manifest: packages/client/src/index.ts -> @byok-sdk/core',
    'package: packages/core/package.json#dependencies -> @byok-sdk/cloud',
  ]);
  f.write('packages/core/src/leaf.ts', "export { cloud } from '@byok-sdk/cloud';");
  assert.ok(inspectRepository(f.root).includes('source-package: packages/core/src/leaf.ts -> @byok-sdk/cloud'));
});

test('directory inversion, cloud composition separation and cycles through public barrels are enforced', t => {
  const f = fixture(t); f.pkg('client'); f.pkg('cloud');
  f.write('packages/client/src/index.ts', "export * from './daemon/runner';");
  f.write('packages/client/src/daemon/runner.ts', "import { x } from '../adapters/a'; export const run = x;");
  f.write('packages/client/src/adapters/a.ts', "import { run } from '../index'; export const x = run;");
  f.write('packages/cloud/src/index.ts', "export * from './cloud';");
  f.write('packages/cloud/src/cloud.ts', "import { api } from './api/entry'; export const cloud = api;");
  f.write('packages/cloud/src/api/entry.ts', "import { cloud } from '../cloud'; export const api = cloud;");
  const violations = inspectRepository(f.root);
  assert.ok(violations.includes('directory: packages/cloud/src/api/entry.ts -> packages/cloud/src/cloud.ts'));
  assert.ok(violations.includes('directory: packages/client/src/adapters/a.ts -> packages/client/src/daemon/runner.ts'));
  assert.ok(violations.includes('cycle: packages/client/src/adapters/a.ts -> packages/client/src/index.ts'));
  assert.ok(violations.includes('cycle: packages/client/src/index.ts -> packages/client/src/daemon/runner.ts'));
  assert.ok(!violations.some(v => v.startsWith('directory: packages/client/src/index.ts')));
});

test('baseline rejects new/stale/duplicate entries and cannot grow relative to the CI base', () => {
  assert.deepEqual(compareBaseline(['old'], ['old']), []);
  assert.deepEqual(compareBaseline(['new'], ['old']), ['new new', 'stale baseline (remove): old']);
  assert.throws(() => compareBaseline([], ['old', 'old']), /unique/);
  assert.deepEqual(compareBaselineHistory(['old'], ['old', 'removed']), []);
  assert.deepEqual(compareBaselineHistory(['old', 'new'], ['old']), ['baseline must shrink: new']);
  assert.deepEqual(compareBaseline([], []), []);
});

test('cycle edge identities detect a new edge even inside an existing strongly connected component', () => {
  const before = new Map([['a', new Set(['b'])], ['b', new Set(['c'])], ['c', new Set(['a'])]]);
  const baseline = cycleEdges(before).map(edge => edge.join(' -> '));
  before.get('a').add('c');
  assert.deepEqual(compareBaseline(cycleEdges(before).map(edge => edge.join(' -> ')), baseline), ['new a -> c']);
});

test('scope excludes vendor, declarations and tests; unresolved workspace imports fail loudly', t => {
  const f = fixture(t); f.pkg('core');
  f.write('packages/core/src/index.ts', 'export const x = 1;');
  for (const file of ['vendor/x.ts', '__tests__/x.ts', 'x.test.ts', 'x.spec.ts', 'x.d.ts']) {
    f.write(`packages/core/src/${file}`, "import '@byok-sdk/unknown';");
  }
  assert.deepEqual(inspectRepository(f.root), []);
  f.write('packages/core/src/index.ts', "import '@byok-sdk/unknown';");
  assert.throws(() => inspectRepository(f.root), /unknown workspace/);
});

test('checked-in dependency-baseline.json equals the actual source graph', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const baseline = JSON.parse(readFileSync(path.join(root, 'scripts/architecture/dependency-baseline.json'), 'utf8'));
  assert.deepEqual(compareBaseline(inspectRepository(root), baseline), []);
});


test('CI comparison rejects baseline expansion even when the candidate source matches it', t => {
  const f = fixture(t); f.pkg('core'); f.pkg('cloud');
  f.write('packages/core/src/index.ts', 'export const x = 1;');
  f.write('packages/cloud/src/index.ts', 'export const x = 1;');
  f.write('scripts/architecture/dependency-graph.mjs', '// checker already installed; debt cleared');
  const git = (...args) => execFileSync('git', args, { cwd: f.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline');
  const oldBase = process.env.CI_BASE;
  t.after(() => { if (oldBase === undefined) delete process.env.CI_BASE; else process.env.CI_BASE = oldBase; });
  process.env.CI_BASE = git('rev-parse', 'HEAD');
  f.pkg('core', { '@byok-sdk/cloud': 'workspace:*' });
  const actual = inspectRepository(f.root);
  f.write('scripts/architecture/dependency-baseline.json', JSON.stringify(actual));
  assert.deepEqual(checkDependencyDirection(f.root), actual.map(edge => `baseline must shrink: ${edge}`));
});


test('ui-runtime value imports from cloud are locked to exact files and members', t => {
  const f = fixture(t);
  f.pkg('ui-runtime', { '@byok-sdk/cloud': 'workspace:*' }); f.pkg('cloud');
  f.write('packages/cloud/src/index.ts', 'export const TimelineEventSchema = 1, projectTimelineEvents = 2, ApprovalObservationSchema = 3;');
  f.write('packages/ui-runtime/src/timeline.ts', "import { TimelineEventSchema, projectTimelineEvents, type TimelineEvent } from '@byok-sdk/cloud';\nexport const x: TimelineEvent | number = TimelineEventSchema + projectTimelineEvents;");
  f.write('packages/ui-runtime/src/approval-timeline.ts', "import { ApprovalObservationSchema } from '@byok-sdk/cloud';\nexport const y = ApprovalObservationSchema;");
  assert.deepEqual(inspectRepository(f.root), []);
  f.write('packages/ui-runtime/src/timeline.ts', "import { TimelineEventSchema, projectTimelineEvents, ConversationScope } from '@byok-sdk/cloud';\nexport const x = TimelineEventSchema + projectTimelineEvents + ConversationScope;");
  assert.deepEqual(inspectRepository(f.root), [
    'ui-runtime-value: packages/ui-runtime/src/timeline.ts -> @byok-sdk/cloud {ConversationScope, TimelineEventSchema, projectTimelineEvents} (locked: {TimelineEventSchema, projectTimelineEvents})',
  ]);
  f.write('packages/ui-runtime/src/timeline.ts', "import { TimelineEventSchema, projectTimelineEvents } from '@byok-sdk/cloud';\nexport const x = TimelineEventSchema + projectTimelineEvents;");
  f.write('packages/ui-runtime/src/new-value.ts', "import { TimelineEventSchema } from '@byok-sdk/cloud';\nexport const z = TimelineEventSchema;");
  assert.deepEqual(inspectRepository(f.root), [
    'ui-runtime-value: packages/ui-runtime/src/new-value.ts -> @byok-sdk/cloud {TimelineEventSchema} (not in reviewed allowlist)',
  ]);
  rmSync(path.join(f.root, 'packages/ui-runtime/src/new-value.ts'));
  rmSync(path.join(f.root, 'packages/ui-runtime/src/timeline.ts'));
  assert.deepEqual(inspectRepository(f.root), [
    'ui-runtime-value: packages/ui-runtime/src/timeline.ts -> @byok-sdk/cloud (locked import missing)',
  ]);
});

test('the checked-in K8 rules stay clear of the K4 Node-only closure', () => {
  const repo = path.resolve(import.meta.dirname, '../..');
  assert.deepEqual(inspectExamplePortability(repo), []);
});

test('K8 rules importing the K4 root entry reach node:sqlite and fail the check', t => {
  const root = repositorySubset(t);
  assert.deepEqual(inspectExamplePortability(root), []);
  appendFileSync(
    path.join(root, 'examples/bot-collaboration/src/rules/outcome.ts'),
    "\nimport { HostLedger } from '@byok-sdk/server/execution-core';\nvoid HostLedger;\n",
  );
  const violations = inspectExamplePortability(root);
  assert.ok(violations.includes('portability: examples/bot-collaboration/src/rules/outcome.ts -> node:sqlite'), violations.join('\n'));
  assert.ok(violations.includes('portability: examples/bot-collaboration/src/rules/outcome.ts -> node:async_hooks'), violations.join('\n'));
  const baselineFile = path.join(root, 'scripts/architecture/dependency-baseline.json');
  mkdirSync(path.dirname(baselineFile), { recursive: true });
  writeFileSync(baselineFile, JSON.stringify(inspectRepository(root)));
  const previous = process.env.CI_BASE;
  delete process.env.CI_BASE;
  t.after(() => { if (previous !== undefined) process.env.CI_BASE = previous; });
  assert.ok(checkDependencyDirection(root).some(error => error.includes('node:sqlite')), 'the repository check must go RED');
});

test('native Windows paths enter the rule graph as POSIX repo-relative paths', () => {
  const root = path.win32.join('C:\\', 'repo');
  const packages = new Map(['client', 'cloud'].map(dir => [dir, {
    dir, root: graphSourcePath(root, path.win32.join(root, 'packages', dir), path.win32),
  }]));
  for (const [pkg, source, layer] of [
    ['client', ['daemon', 'runner.ts'], 2],
    ['client', ['adapters', 'a.ts'], 1],
    ['cloud', ['cloud.ts'], 4],
    ['cloud', ['api', 'entry.ts'], 3],
  ]) {
    const file = graphSourcePath(root, path.win32.join(root, 'packages', pkg, 'src', ...source), path.win32);
    const owner = sourceOwner(file, packages);
    assert.equal(file, `packages/${pkg}/src/${source.join('/')}`);
    assert.equal(owner, packages.get(pkg));
    assert.equal(directoryLayer(owner.dir, path.posix.relative(`${owner.root}/src`, file)), layer);
  }
  assert.equal(sourceOwner('packages/client-extra/src/x.ts', packages), undefined);
});
