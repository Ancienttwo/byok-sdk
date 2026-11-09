import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { familyOwners, knownFamilies, reviewedScripts, selectImpact, vitestTmpRootConsumers, workspaceGraph } from './select-impact.mjs';
const root = new URL('../../', import.meta.url);
const sorted = values => [...values].sort();

test('reviewed graph covers every workspace and all local dependency edges', () => {
  const actual = {};
  for (const prefix of ['packages', 'examples']) {
    for (const entry of readdirSync(new URL(`${prefix}/`, root), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let manifest;
      try { manifest = JSON.parse(readFileSync(new URL(`${prefix}/${entry.name}/package.json`, root), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      actual[`${prefix}/${entry.name}`] = { name: manifest.name, dependencies: [...new Set(
        ['dependencies', 'devDependencies', 'peerDependencies'].flatMap(field => Object.keys(manifest[field] ?? {}).filter(name => name.startsWith('@byok-sdk/'))),
      )].sort() };
    }
  }
  assert.deepEqual(workspaceGraph, actual);
});

test('#654: browser tooling admits only private-root pins and the Worker command/core edge', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-browser-vectors-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const dir = 'examples/hosted-bot-collaboration-worker', path = `${dir}/package.json`;
  const baseline = { name: workspaceGraph[dir].name, private: true, version: '0.0.1', scripts: {}, dependencies: {}, devDependencies: {} };
  const pins = { '@vitest/browser-playwright': '5.1.0', playwright: '1.64.1' };
  const scripts = { 'test:browser': 'vitest run --config src/browser/vitest.config.ts' };
  const dependencies = { '@byok-sdk/core': 'workspace:*' };
  mkdirSync(dirname(join(cwd, path)), { recursive: true });
  const write = (value, target = path) => writeFileSync(join(cwd, target), JSON.stringify(value));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  const rootManifest = { private: true, scripts: { 'test:scripts': 'node --test --test-concurrency=1 scripts/old.test.mjs' }, devDependencies: { vitest: '^5.1.0' } };
  write(rootManifest, 'package.json'); write(baseline); git('init'); git('add', '.');
  git('-c', 'user.name=CI', '-c', 'user.email=ci@example.invalid', 'commit', '-m', 'baseline');
  const context = { cwd, base: git('rev-parse', 'HEAD') };
  const approved = { ...baseline, scripts, dependencies };
  for (const value of [approved, { ...baseline, scripts }, { ...baseline, dependencies }]) {
    write(value);
    assert.deepEqual(selectImpact([path], context).dirs, [dir]);
  }
  for (const value of [
    { ...approved, private: false },
    { ...approved, devDependencies: pins },
    { ...approved, scripts: { 'test:browser': 'echo pass' } },
    { ...approved, dependencies: { '@byok-sdk/core': '^1.0.0' } },
  ]) {
    write(value); assert.throws(() => selectImpact([path], context), /private|reviewed fields/i);
  }
  write(approved);
  const rootApproved = { ...rootManifest, devDependencies: { ...pins, vitest: '5.1.0' } };
  write(rootApproved, 'package.json');
  assert.deepEqual(selectImpact(['package.json'], context).dirs, [dir]);
  for (const value of [
    { ...rootApproved, private: false },
    ...Object.keys(rootApproved.devDependencies).flatMap(name => [
      { ...rootApproved, devDependencies: { ...rootApproved.devDependencies, [name]: `^${rootApproved.devDependencies[name]}` } },
      { ...rootApproved, devDependencies: { ...rootApproved.devDependencies, [name]: '1.0.0' } },
    ]),
    ...Object.keys(pins).map(name => ({ ...rootApproved, devDependencies: { vitest: '5.1.0', [name]: pins[name] } })),
    { ...rootApproved, dependencies: pins, devDependencies: { vitest: '5.1.0' } },
    { ...rootApproved, devDependencies: { ...rootApproved.devDependencies, other: '1.0.0' } },
  ]) {
    write(value, 'package.json'); assert.throws(() => selectImpact(['package.json'], context), /reviewed fields/i);
  }
  for (const relative of ['src/browser/vitest.config.ts', 'src/browser/vectors.browser.ts']) {
    assert.deepEqual(selectImpact([`${dir}/${relative}`]).dirs, [dir]);
  }
});

test('docs and known CI contracts select light checks, not release families', () => {
  assert.deepEqual(selectImpact(['README.md', 'docs/releases/v0.28.1.md']), {
    dirs: [], files: ['README.md', 'docs/releases/v0.28.1.md'], families: [], reason: 'root-ci-scripts',
  });
  for (const path of ['scripts/ci/select-impact.mjs']) {
    assert.equal(selectImpact([path]).reason, 'root-ci-scripts');
    assert.deepEqual(selectImpact([path]).families, []);
  }
});

test('shared device credential fixtures select client consumers and native smoke owners', () => {
  const impact = selectImpact(['scripts/testing/device-credentials.mjs']);
  for (const dir of ['packages/client', 'examples/basic', 'examples/host-execution-core',
    'examples/bot-collaboration', 'examples/byok-mcp-server', 'examples/hosted-bot-collaboration',
    'examples/hosted-bot-collaboration-worker', 'examples/packaging']) {
    assert.ok(impact.dirs.includes(dir), dir);
  }
  assert.deepEqual(impact.families, ['adapter-lifecycle-smoke', 'dataplane', 'packageability-smoke']);
  for (const path of ['scripts/testing/sdk-koffi-asset-root.mjs', 'scripts/testing/sdk-koffi-asset-root.d.mts']) {
    assert.deepEqual(['execution-recovery-native', 'service-upgrade-smoke'].filter(id => selectImpact([path]).families.includes(id)), ['execution-recovery-native', 'service-upgrade-smoke']);
  }
  assert.throws(() => selectImpact(['scripts/testing/unreviewed-backend.mjs']), /Reviewed CI mapping required/);
});

test('the W5 runner probe workflow selects only the CI script checks (#605)', () => {
  assert.deepEqual(selectImpact(['.github/workflows/w5-runner-probe.yml']), {
    dirs: [], files: ['.github/workflows/w5-runner-probe.yml'], families: [], reason: 'root-ci-scripts',
  });
  const workflow = readFileSync(new URL('.github/workflows/w5-runner-probe.yml', root), 'utf8');
  assert.match(workflow, /^on:\n  workflow_dispatch:\n\n/m);
  assert.doesNotMatch(workflow, /actions\/checkout|pull_request|push:/);
});

test('the retention soak workflow and harness select only reviewed light checks (#1105)', () => {
  assert.deepEqual(selectImpact(['.github/workflows/client-retention-soak.yml']), {
    dirs: [], files: ['.github/workflows/client-retention-soak.yml'], families: [], reason: 'root-ci-scripts',
  });
  assert.deepEqual(selectImpact(['scripts/soak/client-retention-soak.mjs']), {
    dirs: [], files: ['scripts/soak/client-retention-soak.mjs'], families: [], reason: 'root-ci-scripts',
  });
});

test('the Pi closure definition selects the release pack jobs and its importer\'s jobs; its collector selects only script checks', () => {
  const importer = selectImpact(['packages/client/src/adapters/pi/input-preparation.ts']).families;
  const releasePack = selectImpact(['scripts/release/pack-and-smoke.mjs']).families;
  assert.deepEqual(selectImpact(['scripts/release/pi-runtime-identity.mjs']), {
    dirs: [], files: ['scripts/release/pi-runtime-identity.mjs'], families: sorted(new Set([...importer, ...releasePack])), reason: 'impacted',
  });
  assert.deepEqual(selectImpact(['scripts/release/collect-official-pi-closure.mjs']), {
    dirs: [], files: ['scripts/release/collect-official-pi-closure.mjs'], families: [], reason: 'root-ci-scripts',
  });
});

test('packages/AGENTS.md and packages/CLAUDE.md are docs-only like the root agent files', () => {
  assert.deepEqual(selectImpact(['packages/AGENTS.md', 'packages/CLAUDE.md']), {
    dirs: [], files: ['packages/AGENTS.md', 'packages/CLAUDE.md'], families: [], reason: 'docs-only',
  });
});

test('#1322: the reviewed ArchContext model, policy, projection config and archimap select no workspace', () => {
  const paths = ['.archcontext/manifest.yaml', '.archcontext/product.yaml', '.archcontext/policies/review.yaml',
    '.archcontext/projections/targets.json', '.archcontext/model/nodes/capability.sdk.sdk-root.yaml',
    '.archcontext/model/nodes/component.sdk.client-session.yaml', '.archcontext/model/nodes/module.sdk.client.yaml',
    '.archcontext/model/relations/relation.sdk.client-to-core.yaml', '.archcontext/model/flows/flow.sdk.offer-home-admission.yaml',
    'docs/architecture/.projection-manifest.json', 'docs/architecture/archimap.html', 'docs/architecture/requests/.gitkeep'];
  assert.deepEqual(selectImpact(paths), { dirs: [], files: sorted(paths), families: [], reason: 'docs-only' });
  for (const path of ['.archcontext/generated/index.md', '.archcontext/policies/other.yaml', '.archcontext/model/nodes/service.sdk.client.yaml',
    '.archcontext/model/nodes/module.sdk.client.json', '.archcontext/model/relations/module.sdk.client.yaml',
    'docs/architecture/other.html', 'docs/architecture/other.json']) {
    assert.throws(() => selectImpact([path]), /reviewed CI mapping required/i, path);
  }
});

test('.gitignore alone selects nothing', () => {
  assert.deepEqual(selectImpact(['.gitignore']), { dirs: [], files: ['.gitignore'], families: [], reason: 'docs-only' });
});

test('ci.yml selects every routine family and the client suites that read it (W7)', () => {
  for (const reader of [
    'packages/cloud-dataplane/src/__tests__/constraints.test.ts',
    'packages/client/src/__tests__/agent-memory-helper-ci-p1-regression.test.ts',
    'packages/client/src/__tests__/support/test-bun-bin.pin.test.ts',
  ]) assert.match(readFileSync(new URL(reader, root), 'utf8'), /\.github\/workflows\/ci\.yml/, reader);
  const impact = selectImpact(['.github/workflows/ci.yml']);
  assert.deepEqual(impact.families, knownFamilies.filter(id => id !== 'build-test' && id !== 'macos-client').sort());
  assert.ok(impact.dirs.includes('packages/client'));
  assert.equal(impact.reason, 'impacted');
  assert.deepEqual(selectImpact(['scripts/ci/select-impact.mjs']).families, []);
});

test('docs/security.md selects the dataplane job that checks its plaintext inventory (#654)', () => {
  const inventory = 'packages/cloud-dataplane/src/__tests__/hosted-plaintext-inventory.test.ts';
  assert.match(readFileSync(new URL(inventory, root), 'utf8'), /docs\/security\.md/);
  assert.deepEqual(selectImpact(['docs/security.md']), {
    dirs: [], files: ['docs/security.md'], families: ['dataplane'], reason: 'impacted',
  });
  assert.deepEqual(selectImpact(['docs/hosted-host-contract.md']).families, []);
});

test('a deploy/sql migration selects cloud-dataplane, its Postgres suites and the packed-tarball migrate job (#654)', () => {
  for (const reader of ['packages/cloud-dataplane/scripts/copy-migrations.mjs', 'scripts/release/pg-migrate-smoke.mjs']) {
    assert.match(readFileSync(new URL(reader, root), 'utf8'), /deploy\/sql/, reader);
  }
  for (const path of ['deploy/sql/0026_agent_message_draft.sql', 'deploy/sql/0027_e2ee_member.sql']) {
    // The hosted example (#793 D2b-1) and its Worker composition (#794 D3) depend on cloud-dataplane, so the graph also selects them.
    assert.deepEqual(selectImpact([path]), {
      dirs: ['examples/hosted-bot-collaboration', 'examples/hosted-bot-collaboration-worker', 'packages/cloud-dataplane'], files: [path], families: ['dataplane', 'release-pack-migrate'], reason: 'impacted',
    });
  }
  for (const path of ['deploy/sql/README.md', 'deploy/sql/0027.sql', 'deploy/sql/0027_e2ee.sh', 'deploy/sql/sub/0027_e2ee.sql']) {
    assert.throws(() => selectImpact([path]), /reviewed CI mapping required/i, path);
  }
});

test('the control-plane SQL invariants select the cloud-dataplane suites that run them (#654)', () => {
  const path = 'tests/sql/control_plane_invariants.sql';
  assert.match(readFileSync(new URL('packages/cloud-dataplane/src/__tests__/invariants.test.ts', root), 'utf8'), /tests\/sql\/control_plane_invariants\.sql/);
  // The hosted example (#793 D2b-1) and its Worker composition (#794 D3) depend on cloud-dataplane, so the graph also selects them.
  assert.deepEqual(selectImpact([path]), {
    dirs: ['examples/hosted-bot-collaboration', 'examples/hosted-bot-collaboration-worker', 'packages/cloud-dataplane'], files: [path], families: ['dataplane'], reason: 'impacted',
  });
  assert.throws(() => selectImpact(['tests/sql/other.sql']), /reviewed CI mapping required/i);
});

test('client source/deleted tests select reverse dependents and only the dataplane family', () => {
  for (const path of [
    'packages/client/src/daemon/task-runner.ts', 'packages/client/src/__tests__/deleted.test.ts', 'api-surface/client.d.ts',
    'packages/client/src/__tests__/native-sessions.test.ts',
    'packages/client/src/__tests__/fixtures/native-sessions/pi-1.5.0.jsonl',
    'packages/client/src/__tests__/fixtures/native-sessions/generate.mjs',
  ]) {
    const impact = selectImpact([path]);
    assert.ok(impact.dirs.includes('packages/client'));
    assert.ok(impact.dirs.includes('examples/host-execution-core'));
    assert.deepEqual(impact.families, ['dataplane'], path);
  }
});

test('#1106: the moved K4 source still selects the example memory jobs and the K4 Windows qualification', () => {
  for (const path of ['packages/server/src/execution-core/memory.ts', 'packages/server/src/execution-core/memory-restore.ts']) {
    const impact = selectImpact([path]);
    assert.ok(impact.dirs.includes('packages/server'), path);
    assert.ok(impact.dirs.includes('examples/host-execution-core'), path);
    assert.ok(impact.families.includes('agent-memory-export-linux'), path);
    assert.ok(impact.families.includes('adapter-lifecycle-smoke'), path);
  }
  const ledger = selectImpact(['packages/server/src/execution-core/ledger.ts']);
  assert.ok(ledger.dirs.includes('examples/host-execution-core'));
  assert.ok(ledger.families.includes('adapter-lifecycle-smoke'));
  assert.ok(!ledger.families.includes('agent-memory-export-linux'));
});

test('a platform family is selected only by a path it owns', () => {
  const owned = {
    'agent-memory-export-linux': 'packages/client/src/daemon/agent-memory-export.ts',
    'agent-memory-helper-non-darwin': 'packages/client/native/agent-memory-fs/main.go',
    'agent-memory-helper': 'packages/client/src/daemon/agent-memory-intent.ts',
    'execution-recovery-native': 'packages/client/src/daemon/journal/sqlite-journal.ts',
    'adapter-lifecycle-smoke': 'packages/client/src/adapters/codex/codex-adapter.ts',
    'windows-client': 'packages/client/src/daemon/auth-manager.ts',
    'packageability-smoke': 'packages/client/src/sdk-native-assets.ts',
    'packaging-consistency': 'packages/client/src/adapters/packaging.ts',
    'windows-service-smoke': 'packages/client/src/lifecycle/winsw.ts',
    'linux-systemd-smoke': 'templates/service/systemd/smoke-test.mjs',
    'service-upgrade-smoke': 'examples/service-upgrade/upgrade-smoke.mjs',
    'ipc-smoke': 'packages/client/src/daemon/control-server.ts',
    'credential-isolation-audit': 'packages/keys/src/index.ts',
    'hermes-real-windows': 'packages/client/src/__tests__/hermes-real.test.ts',
    'agy-real-windows': 'packages/client/src/__tests__/runtime-contract/agy.contract.ts',
    'runtime-contract': 'packages/client/src/__tests__/runtime-contract/contract.ts',
    'npm-release-pack': 'packages/keys/src/pi-projection-windows.test.ts',
  };
  assert.deepEqual(Object.keys(owned).sort(), Object.keys(familyOwners).sort());
  const tracked = new Set(spawnSync('git', ['ls-files'], { cwd: fileURLToPath(root), encoding: 'utf8' }).stdout.split('\n').filter(Boolean));
  for (const path of Object.values(owned)) assert.ok(tracked.has(path), `example path is not tracked: ${path}`);
  for (const [family, owners] of Object.entries(familyOwners)) {
    for (const owner of owners) assert.ok([...tracked].some(path => owner.test(path)), `${family} owner ${owner} matches no tracked file`);
  }
  for (const [family, path] of Object.entries(owned)) assert.ok(selectImpact([path]).families.includes(family), `${family}: ${path}`);
  for (const path of ['packages/client/src/bin/sdk-reserved-helper-runners.ts', 'packages/client/src/bin/byok-agent-result-mcp.ts', 'packages/client/src/lifecycle/sdk-reserved-helper-command.ts']) {
    for (const family of ['runtime-contract', 'credential-isolation-audit', 'npm-release-pack']) assert.ok(selectImpact([path]).families.includes(family), `${family}: ${path}`);
  }
  for (const path of ['packages/client/src/daemon/task-runner/mcp-contexts.ts', 'packages/client/src/sdk-reserved-helper-context.ts']) {
    for (const family of ['runtime-contract', 'credential-isolation-audit']) assert.ok(selectImpact([path]).families.includes(family), `${family}: ${path}`);
  }
  for (const path of ['packages/client/src/daemon/task-runner.ts', 'packages/protocol/src/task.ts', 'packages/core/src/index.ts', 'packages/server/src/index.ts']) {
    assert.deepEqual(selectImpact([path]).families.filter(id => id in familyOwners), [], path);
  }
});

test('shared Windows filesystem helpers select their real Windows consumers', () => {
  assert.deepEqual(selectImpact(['packages/client/src/util/secure-dir.ts']).families, ['dataplane', 'linux-systemd-smoke', 'windows-client', 'windows-service-smoke']);
  assert.deepEqual(selectImpact(['packages/client/src/util/atomic-write.ts']).families, ['dataplane', 'ipc-smoke', 'windows-client']);
  assert.deepEqual(selectImpact(['packages/client/src/daemon/operational-health.ts']).families, ['dataplane', 'service-upgrade-smoke', 'windows-service-smoke']);
});

test('service enrollment handover paths select the WinSW control socket check and the Windows client suite (#1165)', () => {
  for (const path of [
    'packages/client/src/daemon/control-server.ts',
    'packages/client/src/daemon/create-daemon/control-methods.ts',
    'packages/client/src/daemon/create-daemon/lifecycle.ts',
    'packages/client/src/daemon/create-daemon/start-run.ts',
    'packages/client/src/daemon/create-daemon/start.ts',
  ]) {
    const { families } = selectImpact([path]);
    assert.ok(families.includes('windows-service-smoke') && families.includes('windows-client'), path);
  }
  for (const path of ['packages/client/src/daemon/control-client.ts', 'packages/client/src/bin/commands/unpair.ts', 'packages/client/scripts/control-socket-check.mjs']) {
    assert.ok(selectImpact([path]).families.includes('windows-service-smoke'), path);
  }
  assert.ok(selectImpact(['packages/client/src/__tests__/service-enrollment-handover.test.ts']).families.includes('windows-client'));
});

test('Hermes adapter, fake and custody launcher paths select the Windows Hermes suites', () => {
  for (const path of [
    'packages/client/src/adapters/hermes/gateway-pipe-win32.ts',
    'packages/client/src/adapters/hermes/hermes-session-runtime.ts',
    'packages/client/src/__tests__/hermes-custody.test.ts',
    'packages/client/src/__tests__/fixtures/fake-hermes.mjs',
    'packages/client/src/__tests__/fixtures/fake-hermes-command.ts',
    'packages/keys/src/hermes-provider-launcher.ts',
    'packages/keys/src/__tests__/hermes-provider-launcher.test.ts',
    'packages/client/src/runtime/environment.ts',
    'packages/client/src/__tests__/environment.test.ts',
    'packages/client/src/daemon/task-runner/mcp-contexts.ts',
    'packages/client/src/daemon/retention/scratch.ts',
    'packages/client/src/__tests__/task-assertion-broker.test.ts',
  ]) assert.ok(selectImpact([path]).families.includes('windows-client'), path);
  // The job does not run these, so a change to them does not select it.
  for (const path of ['packages/client/src/adapters/codex/codex-adapter.ts', 'packages/keys/src/pi-provider-launcher.ts', 'packages/client/src/__tests__/hermes-pipe-open-errors.test.ts']) {
    assert.ok(!selectImpact([path]).families.includes('windows-client'), path);
  }
});

test('Hermes adapter, real run and custody launcher paths select the real Hermes Windows job (#608)', () => {
  for (const path of [
    'packages/client/src/adapters/hermes/gateway-pipe-win32.ts',
    'packages/client/src/adapters/hermes/hermes-adapter.ts',
    'packages/client/src/__tests__/hermes-real.test.ts',
    'packages/client/src/__tests__/fixtures/hermes-fake-model.ts',
    'packages/keys/src/hermes-provider-launcher.ts',
  ]) assert.ok(selectImpact([path]).families.includes('hermes-real-windows'), path);
  // The fake Hermes suites do not run real Hermes, so they do not select it.
  for (const path of ['packages/client/src/__tests__/hermes-custody.test.ts', 'packages/client/src/__tests__/fixtures/fake-hermes.mjs', 'packages/keys/src/__tests__/hermes-provider-launcher.test.ts']) {
    assert.ok(!selectImpact([path]).families.includes('hermes-real-windows'), path);
  }
});

test('owned helper build scripts keep release packaging qualification', () => {
  for (const path of ['packages/client/scripts/build-agent-memory-helper.mjs', 'packages/client/scripts/check-agent-memory-helper-build.mjs', 'packages/client/scripts/agent-memory-helper-source.mjs']) {
    const families = selectImpact([path]).families;
    for (const id of ['npm-release-pack', 'agent-memory-helper', 'agent-memory-helper-non-darwin']) assert.ok(families.includes(id), `${path}: ${id}`);
  }
});

// Each test file and script that a family job runs must select that family.
// The job steps are read from ci.yml, whatever their shell. The registered
// families run complete workspace suites chosen by package membership, not by
// owned paths.
const suiteFamilies = new Set(['build-test', 'macos-client', 'dataplane']);
// Job inputs and run-step paths that do not have to select the family, each
// with its reason. Each entry must still occur in its job.
const registeredJobInputs = {
  'agent-memory-helper': {
    'packages/client/dist/native/agent-memory-fs/darwin-': 'build output that the macOS step compares with its own helper build',
    'packages/client/dist/native/agent-memory-fs/win32-x64.exe': 'build output that the Windows junction smoke runs',
  },
  'hermes-real-windows': { $installer: 'the pinned upstream Hermes installer, downloaded at run time' },
  'packageability-smoke': {
    'packages/client/scripts/build-agent-memory-helper.mjs': 'build:agent-memory-helper stages the helper binaries this job packages; a change to it runs the helper and pack families',
    'packages/client/scripts/check-agent-memory-helper-build.mjs': 'build:agent-memory-helper stages the helper binaries this job packages; a change to it runs the helper and pack families',
    'templates/packaging/${{ matrix.recipe }}/smoke-test.sh': 'one smoke per recipe under templates/packaging/',
  },
  'packaging-consistency': {
    'packages/client/scripts/build-agent-memory-helper.mjs': 'build:agent-memory-helper stages the helper binaries this job packages; a change to it runs the helper and pack families',
    'packages/client/scripts/check-agent-memory-helper-build.mjs': 'build:agent-memory-helper stages the helper binaries this job packages; a change to it runs the helper and pack families',
  },
  'runtime-contract': { 'packages/client/src/__tests__/runtime-contract/${{ matrix.runtime }}.contract.ts': 'one contract per runtime under src/__tests__/runtime-contract/' },
};
test('family owners cover every test file and script their CI job runs', () => {
  const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  const dirOf = name => Object.keys(workspaceGraph).find(dir => workspaceGraph[dir].name === name);
  const scriptsOf = dir => JSON.parse(readFileSync(new URL(`${dir ? `${dir}/` : ''}package.json`, root), 'utf8')).scripts;
  const unchecked = Object.keys(registeredJobInputs).filter(family => suiteFamilies.has(family) || !knownFamilies.includes(family));
  assert.deepEqual(unchecked, []);
  const repoPath = /(?<![\w./$-])((?:packages|examples|templates|scripts)\/(?:[\w./-]|\$\{\{[^}]*\}\})+)/;
  let checked = 0;
  for (const family of knownFamilies.filter(id => !suiteFamilies.has(id))) {
    const start = workflow.indexOf(`\n  ${family}:\n`);
    assert.ok(start >= 0, family);
    const next = workflow.slice(start + 1).search(/\n  [a-z0-9-]+:\n/);
    const steps = workflow.slice(start, next < 0 ? undefined : start + 1 + next)
      .split('\n').filter(line => !/^\s*#/.test(line)).join('\n').split(/\n {6}- /).slice(1);
    const inputs = [];
    const named = [];
    for (const step of steps) {
      const lines = step.split('\n');
      const at = lines.findIndex(line => /^(?: {8})?run: /.test(line));
      if (at < 0) continue;
      const body = [lines[at].replace(/^\s*run: /, '')];
      for (const line of lines.slice(at + 1)) { if (line && !/^ {9}/.test(line)) break; body.push(line); }
      const run = body.join('\n').replace(/[`\\]\r?\n\s*/g, ' ');
      // A command that names a repo path is a job input; any other path the step names must be registered.
      const captured = new Set();
      for (const match of run.matchAll(/bun run (?:--filter (\S+) |--cwd (\S+) )?(test|[a-z]+:[a-z-]+)(?=\s|$)(?: --([^\n]*))?/g)) {
        const dir = match[2] ?? (match[1] && dirOf(match[1]));
        assert.ok(dir || !match[1], match[0]);
        assert.ok(dir || match[3] !== 'test', `${family}: ${match[0]} runs every workspace suite`);
        if (match[2]) captured.add(match[2]);
        const files = [...(match[4] ?? '').matchAll(/(?:\$\{\{[^}]*\}\}|\S)+/g)].map(([arg]) => arg.replace(/^["']|["')]+$/g, '')).filter(arg => /\.[cm]?[jt]s$/.test(arg));
        const own = files.map(file => `${dir}/${file}`);
        if (match[3] === 'test') own.push(...(files.length ? [] : [`${dir}/src/suite-probe.ts`]));
        else {
          const script = scriptsOf(dir)[match[3]];
          assert.ok(script, `${family}: ${match[0]} names no package script`);
          for (const path of script.matchAll(/(?:node|bun) ((?:packages|examples|templates|scripts)\/[\w./-]+\.mjs)/g)) own.push(dir ? `${dir}/${path[1]}` : path[1]);
          assert.ok(own.length > 0, `${family}: ${match[0]} runs no checkable file`);
        }
        inputs.push(...own);
      }
      for (const [, path] of run.matchAll(/(?:node|bun) ((?:packages|examples|templates|scripts)\/[\w./-]+\.mjs)/g)) { inputs.push(path); captured.add(path); }
      for (const [, path] of run.matchAll(/(?:^|\bbash )((?:packages|examples|templates|scripts)\/(?:[\w./-]|\$\{\{[^}]*\}\})+\.sh)/g)) { inputs.push(path); captured.add(path); }
      for (const [, path] of run.matchAll(/\bpwsh\b[^\n]*? -File (\S+)/g)) inputs.push(path);
      if (/\bgo test\b/.test(run)) {
        const directory = /^ {8}working-directory: (\S+)$/m.exec(step);
        assert.ok(directory, `${family}: a go test step names no working-directory`);
        inputs.push(`${directory[1]}/suite-probe.go`);
      }
      for (const [, path] of run.matchAll(new RegExp(repoPath, 'g'))) {
        if (!captured.has(path)) named.push(path);
      }
    }
    assert.ok(inputs.length > 0, `${family}: no job input checked`);
    const registered = registeredJobInputs[family] ?? {};
    for (const path of named) assert.ok(path in registered, `${family} names ${path} in a run step that no job input pattern reads; register it`);
    for (const input of new Set(inputs)) {
      if (input in registered) continue;
      assert.ok(!/[$*]|\/$/.test(input), `${family} runs ${input}, which names no single path; register it`);
      assert.ok(selectImpact([input]).families.includes(family), `${family} runs ${input} but a change to it does not select ${family}`);
      checked++;
    }
    for (const input of Object.keys(registered)) assert.ok(inputs.includes(input) || named.includes(input), `${family} no longer runs registered ${input}`);
  }
  assert.ok(checked >= 30, `only ${checked} job inputs checked`);
});

test('no routine selection ever includes the complete test suite', () => {
  const tracked = spawnSync('git', ['ls-files'], { cwd: fileURLToPath(root), encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  const selectable = tracked.filter(path => { try { selectImpact([path]); return true; } catch { return false; } });
  assert.ok(selectable.length > 1000);
  const all = selectImpact(selectable);
  assert.ok(!all.families.includes('build-test'));
  assert.notDeepEqual(all.families, [...knownFamilies].sort());
});

test('shared protocol changes propagate through multiple dependency levels', () => {
  const impact = selectImpact(['packages/protocol/src/task.ts']);
  for (const dir of ['packages/server', 'packages/client', 'packages/cloud-dataplane', 'packages/ui-runtime', 'examples/bot-collaboration']) assert.ok(impact.dirs.includes(dir), dir);
  assert.ok(impact.families.includes('dataplane'));
  assert.ok(!impact.dirs.includes('packages/keys'));
});

test('isolated example changes do not select unrelated native families', () => {
  assert.deepEqual(selectImpact(['examples/live-activity-host/src/index.ts']).dirs, ['examples/live-activity-host']);
  assert.deepEqual(selectImpact(['examples/live-activity-host/src/index.ts']).families, []);
});

test('schema, native memory and SEA changes retain relevant qualification', () => {
  const schema = selectImpact(['packages/cloud-dataplane/migrations/0010.sql']);
  assert.ok(schema.families.includes('dataplane'));
  assert.ok(schema.families.includes('release-pack-migrate'));
  for (const path of ['packages/client/native/agent-memory-fs/main.go', 'templates/packaging/sea/build.sh', 'examples/packaging/src/index.ts']) {
    const impact = selectImpact([path]);
    assert.ok(impact.families.includes('packageability-smoke'));
    assert.ok(impact.families.includes('npm-release-pack'));
  }
  for (const path of ['packages/keys/src/pi-provider-launcher-core.ts', 'packages/keys/src/pi-projection-windows.test.ts', 'packages/keys/src/fixtures/acl-evidence-budget.ts']) {
    assert.ok(selectImpact([path]).families.includes('npm-release-pack'), path);
  }
});

test('the removed Windows memory workflow selects the families that run its checks', () => {
  assert.deepEqual(selectImpact(['.github/workflows/agent-memory-windows.yml']).families, ['agent-memory-helper', 'agent-memory-helper-non-darwin']);
});

test('the W5 power-cut harness selects the helper job that runs it (#605)', () => {
  for (const path of ['packages/client/src/__tests__/agent-memory-powercut.test.ts', 'packages/client/src/__tests__/agent-memory-powercut/drivers.ts']) {
    assert.ok(selectImpact([path]).families.includes('agent-memory-helper'), path);
  }
});

test('unknown, broad policy/dependency inputs and malformed paths fail closed', () => {
  for (const path of ['bun.lock', 'package.json', 'packages/client/package.json', 'api-surface/entries.json', '.github/workflows/unreviewed.yml', 'packages/new/src/index.ts', 'packages/client/vendor/new.js', 'scripts/release/pg-unreviewed-smoke.mjs', 'other/a.md', '../README.md', './README.md', '/README.md', 'docs//a.md', 'docs/../README.md', 'docs/a\nb.md', 'docs\\a.md', '', null]) {
    assert.throws(() => selectImpact([path]), /reviewed CI mapping required|requires exact CI_BASE/i, String(path));
  }
  for (const paths of [[], null, {}, 'README.md']) assert.throws(() => selectImpact(paths), /reviewed CI mapping required|requires exact CI_BASE/i);
  assert.throws(() => selectImpact(['README.md', 'unknown']), /reviewed CI mapping required|requires exact CI_BASE/i);
});

// #649: the owner reviewed exactly these release script paths for 0.28.2.
test('reviewed release scripts select the tests and the jobs that run them', () => {
  const tracked = new Set(spawnSync('git', ['ls-files'], { cwd: fileURLToPath(root), encoding: 'utf8' }).stdout.split('\n').filter(Boolean));
  const scripts = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).scripts;
  assert.deepEqual(Object.keys(reviewedScripts).sort(), [
    'scripts/api-surface/check-api-surface.mjs',
    'scripts/api-surface/check-version-authority.mjs', 'scripts/api-surface/check-version-authority.test.mjs',
    'scripts/architecture/dependency-baseline.json', 'scripts/architecture/dependency-graph.mjs', 'scripts/architecture/dependency-graph.test.mjs',
    'scripts/ci/with-secret-service.sh',
    'scripts/docs/device-setup.mjs', 'scripts/docs/device-setup.test.mjs',
    'scripts/release/beta-release.test.mjs', 'scripts/release/check-package-graph.mjs', 'scripts/release/check-retired-identities.mjs',
    'scripts/release/check-upgrade-manifest.mjs', 'scripts/release/check-upgrade-manifest.test.mjs',
    'scripts/release/cloud-do-consumer-smoke.mjs',
    'scripts/release/cloud-do-consumer-worker.mjs',
    'scripts/release/execution-submit-smoke.mjs',
    'scripts/release/pack-and-smoke.mjs',
    'scripts/release/pack-and-smoke.test.mjs',
    'scripts/release/packaging-plugin-smoke.mjs',
    'scripts/release/pg-migrate-smoke.mjs',
    'scripts/release/pi-launcher-smoke.mjs',
    'scripts/release/pi-runtime-identity.mjs',
    'scripts/release/publish-recovery.test.mjs', 'scripts/release/publish.mjs', 'scripts/release/publish.test.mjs', 'scripts/release/published-store-paths.mjs', 'scripts/release/registry-readback.mjs',
    'scripts/release/upgrade-manifest/dts-surface.mjs', 'scripts/release/upgrade-manifest/history.mjs', 'scripts/release/upgrade-manifest/manifest.mjs',
    'scripts/release/upgrade-manifest/snapshot.mjs',
  ]);
  for (const [path, { tests, families = [] }] of Object.entries(reviewedScripts)) {
    assert.ok(tracked.has(path), `reviewed path is not tracked: ${path}`);
    assert.deepEqual(selectImpact([path]), {
      dirs: [], files: [path], families: sorted(families), reason: families.length ? 'impacted' : 'root-ci-scripts',
    });
    if (path.endsWith('.test.mjs')) assert.ok(tests.includes(path), `${path} must run itself`);
    for (const file of tests) {
      assert.ok(tracked.has(file) && scripts['test:scripts'].includes(file), `${path}: ${file} must be a tracked test:scripts file`);
      if (file !== path) assert.ok(readFileSync(new URL(file, root), 'utf8').includes(path.split('/').pop()), `${file} does not run ${path}`);
    }
  }
  // pack-and-smoke.mjs selects exactly the family jobs that run it.
  assert.equal(scripts['check:release-pack'], 'node scripts/release/pack-and-smoke.mjs');
  const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  const runners = knownFamilies.filter(family => {
    const start = workflow.indexOf(`\n  ${family}:\n`);
    assert.ok(start >= 0, family);
    const next = workflow.slice(start + 1).search(/\n  [a-z0-9-]+:\n/);
    return /(?:bun run check:release-pack|node scripts\/release\/pack-and-smoke\.mjs)(?:\s|$)/.test(workflow.slice(start, next < 0 ? undefined : start + 1 + next));
  });
  assert.deepEqual(selectImpact(['scripts/release/pack-and-smoke.mjs']).families, sorted(runners));
  assert.deepEqual(selectImpact(['scripts/release/cloud-do-consumer-smoke.mjs']).families, sorted(runners));
  assert.deepEqual(selectImpact(['scripts/release/cloud-do-consumer-worker.mjs']).families, sorted(runners));
  assert.ok(runners.includes('npm-release-pack'));
  // Its store-path guard runs inside those same jobs.
  assert.deepEqual(selectImpact(['scripts/release/published-store-paths.mjs']).families, sorted(runners));
});

// #1102: the upgrade-manifest data files run the root script checks; the shipped manifest also packs.
test('upgrade-manifest data files select the script checks', () => {
  assert.deepEqual(selectImpact(['scripts/release/upgrade-manifest/baseline.json']), {
    dirs: [], files: ['scripts/release/upgrade-manifest/baseline.json'], families: [], reason: 'root-ci-scripts',
  });
  assert.deepEqual(selectImpact(['packages/client/upgrade-manifest.json']), {
    dirs: [], files: ['packages/client/upgrade-manifest.json'], families: ['npm-release-pack'], reason: 'impacted',
  });
  assert.throws(() => selectImpact(['scripts/release/upgrade-manifest/other.json']), /reviewed CI mapping required/i);
  // #1316: each archived manifest is admitted by its exact path.
  assert.deepEqual(selectImpact(['packages/client/upgrade-history/0.31.0-0.32.0.json']), {
    dirs: [], files: ['packages/client/upgrade-history/0.31.0-0.32.0.json'], families: ['npm-release-pack'], reason: 'impacted',
  });
  assert.throws(() => selectImpact(['packages/client/upgrade-history/0.41.0-0.41.0.json']), /reviewed CI mapping required/i);
});

// #1102: the store precheck fixtures run the suites of the three inspectors (and their dependents).
test('store precheck fixtures select the server, keys and client suites', () => {
  for (const path of ['scripts/release/fixtures/stores/index.json', 'scripts/release/fixtures/stores/generate.mjs',
    'scripts/release/fixtures/stores/0.30.2/server-sqlite.db',
    'scripts/release/fixtures/stores/main/daemon-store/durable-replicas/fixture/durable-fixture.sqlite']) {
    const { dirs } = selectImpact([path]);
    for (const dir of ['packages/server', 'packages/keys', 'packages/client']) assert.ok(dirs.includes(dir), `${path} selects ${dir}`);
  }
  for (const path of ['scripts/release/fixtures/stores/notes.txt', 'scripts/release/fixtures/stores/next/server-sqlite.db']) {
    assert.throws(() => selectImpact([path]), /reviewed CI mapping required/i);
  }
});

test('release script siblings outside the reviewed list still fail closed', () => {
  for (const path of ['scripts/release/publish-unreviewed.test.mjs', 'scripts/release/pg-unreviewed-smoke.mjs', 'scripts/release/registry-contract.mjs',
    'scripts/release/nested/publish.mjs', 'scripts/api-surface/check-api-surface.js', 'scripts/api-surface/check-version-authority.js']) {
    assert.throws(() => selectImpact([path]), /reviewed CI mapping required/i, path);
  }
});

test('selection is deterministic, deduplicated, and uses only known family IDs', () => {
  const paths = ['packages/client/src/a.ts', 'packages/core/src/b.ts', 'README.md'];
  const selection = selectImpact(paths);
  assert.deepEqual(selection, selectImpact([...paths].reverse().concat(paths)));
  assert.ok(selection.families.every(id => knownFamilies.includes(id)));
  assert.equal(knownFamilies.length, 21);
});

test('CLI accepts JSON stdin and fails closed without an output selection on bad JSON', () => {
  const script = fileURLToPath(new URL('./select-impact.mjs', import.meta.url));
  const good = spawnSync(process.execPath, [script], { input: '["README.md"]', encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).reason, 'root-ci-scripts');
  for (const input of ['{', '[]', '["unknown"]']) {
    const bad = spawnSync(process.execPath, [script], { input, encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.equal(bad.stdout, '');
  }
});


test('actual exported migration runner selects installed-tarball upgrade validation', () => {
  const path = 'packages/cloud-dataplane/src/migrate.ts';
  assert.match(readFileSync(new URL(path, root), 'utf8'), /export/);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./select-impact.mjs', import.meta.url))], {
    input: JSON.stringify([path]), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  // The hosted example (#793 D2b-1) and its Worker composition (#794 D3) depend on cloud-dataplane, so the graph also selects them.
  assert.deepEqual(plan.dirs, ['examples/hosted-bot-collaboration', 'examples/hosted-bot-collaboration-worker', 'packages/cloud-dataplane']);
  assert.deepEqual(plan.families, ['dataplane', 'release-pack-migrate']);
});


test('native asset packaging fixtures select their real platform smoke without broad fallback', () => {
  for (const path of ['examples/packaging/native-assets-fixture.ts', 'examples/packaging/native-assets-smoke.mjs']) {
    assert.deepEqual(selectImpact([path]), {
      dirs: ['examples/packaging'], files: [path], families: ['packageability-smoke'], reason: 'impacted',
    });
  }
  for (const path of ['examples/packaging/native-assets-unknown.ts', 'examples/packaging/unreviewed-smoke.mjs']) {
    assert.throws(() => selectImpact([path]), /reviewed CI mapping required/i);
  }
});


// #1104: the packaging consistency lane runs on the paths it bundles and qualifies, and nowhere else.
test('the embedded Host packaging paths select the packaging consistency lane', () => {
  for (const path of ['examples/packaging/embedded-host-fixture.ts', 'examples/packaging/embedded-host-smoke.mjs', 'examples/packaging/bundle-import-meta.test.ts']) {
    const impact = selectImpact([path]);
    assert.ok(impact.families.includes('packaging-consistency') && impact.dirs.includes('examples/packaging'), path);
  }
  assert.deepEqual(selectImpact(['examples/packaging/vitest.config.ts']).families, ['packageability-smoke']);
  for (const path of ['packages/client/src/adapters/packaging.ts', 'packages/client/src/sdk-distribution-bins.json', 'packages/client/src/adapters/pi/runtime-assets.ts',
    'packages/keys/src/pi-provider-launcher-core.ts']) assert.ok(selectImpact([path]).families.includes('packaging-consistency'), path);
  // Package membership alone never selects it: the bundle test in the example suite guards every SDK source change.
  for (const path of ['packages/client/src/daemon/task-runner.ts', 'packages/server/src/index.ts', 'examples/packaging/launcher.ts']) {
    assert.ok(!selectImpact([path]).families.includes('packaging-consistency'), path);
    if (path.startsWith('packages/client/')) assert.ok(selectImpact([path]).dirs.includes('examples/packaging'), path);
  }
  assert.throws(() => selectImpact(['examples/packaging/embedded-host-other.ts']), /reviewed CI mapping required/i);
});

test('SQLite packaging fixtures select only their reviewed packaging owner', () => {
  for (const path of ['examples/packaging/sqlite-fixture.ts', 'examples/packaging/sqlite-smoke.mjs']) {
    assert.deepEqual(selectImpact([path]), {
      dirs: ['examples/packaging'], files: [path], families: ['packageability-smoke'], reason: 'impacted',
    });
  }
  for (const path of ['examples/packaging/sqlite-unknown.ts', 'examples/packaging/sqlite-smoke-extra.mjs',
    'examples/packaging/nested/sqlite-fixture.ts']) {
    assert.throws(() => selectImpact([path]), /reviewed CI mapping required/i);
  }
});

test('gate packaging fixtures select only their reviewed packaging owner (#1149)', () => {
  for (const path of ['examples/packaging/gate-fixture.ts', 'examples/packaging/gate-smoke.mjs']) {
    assert.deepEqual(selectImpact([path]), {
      dirs: ['examples/packaging'], files: [path], families: ['packageability-smoke'], reason: 'impacted',
    });
  }
  assert.throws(() => selectImpact(['examples/packaging/gate-unknown.ts']), /reviewed CI mapping required/i);
});

test('the retired vendored pi-subagents 0.60.0 snapshot selects only the client closure (#701)', () => {
  const client = selectImpact(['packages/client/src/daemon/task-runner.ts']).dirs;
  const vendor = 'packages/client/vendor/pi-subagents/0.60.0';
  for (const path of [`${vendor}/index.ts`, `${vendor}/LICENSE`, `${vendor}/package.json`, `${vendor}/PROVENANCE.md`, `${vendor}/source-manifest.json`,
    `${vendor}/src/extension/index.ts`]) {
    assert.deepEqual(selectImpact([path]), { dirs: client, files: [path], families: ['dataplane'], reason: 'impacted' });
  }
  for (const path of ['packages/client/vendor/pi-subagents/0.61.0/index.ts', 'packages/client/vendor/pi-subagents/0.83.1/index.ts', `${vendor}/src/extension/notes.md`,
    `${vendor}/src/extension/data.json`, `${vendor}/index.js`,
    'packages/client/vendor/other/0.60.0/index.ts']) {
    assert.throws(() => selectImpact([path]), /reviewed CI mapping required/i, path);
  }
});

test('#793 O5: a direct hosted example path selects that example, its Worker composition (#794 D3) and the dataplane family', () => {
  for (const path of ['examples/hosted-bot-collaboration/src/k8-entry.test.ts', 'examples/hosted-bot-collaboration/vitest.config.ts']) {
    assert.deepEqual(selectImpact([path]), { dirs: ['examples/hosted-bot-collaboration', 'examples/hosted-bot-collaboration-worker'], files: [path],
      families: ['dataplane'], reason: 'impacted' });
  }
});

test('#794 D3: a direct Worker example path selects only that example and the dataplane family', () => {
  for (const path of ['examples/hosted-bot-collaboration-worker/src/worker.ts', 'examples/hosted-bot-collaboration-worker/src/wrangler.json',
    'examples/hosted-bot-collaboration-worker/vitest.config.ts']) {
    assert.deepEqual(selectImpact([path]), { dirs: ['examples/hosted-bot-collaboration-worker'], files: [path], families: ['dataplane'], reason: 'impacted' });
  }
  assert.throws(() => selectImpact(['examples/hosted-bot-collaboration-worker/wrangler.json']), /reviewed CI mapping required/i);
});

test('the Codex helper loopback selects client checks without admitting arbitrary scripts', () => {
  const path = 'packages/client/scripts/codex-reserved-mcp-loopback.mjs';
  assert.deepEqual(selectImpact([path]), {
    ...selectImpact(['packages/client/scripts/codex-app-server-real.mjs']), files: [path],
  });
  assert.throws(() => selectImpact(['packages/client/scripts/unreviewed-codex-loopback.mjs']), /reviewed CI mapping required/i);
});

test('the #1022 task events route selects only examples/basic', () => {
  for (const path of ['examples/basic/task-events-route.ts', 'examples/basic/task-events-route.test.ts']) {
    assert.deepEqual(selectImpact([path]).dirs, ['examples/basic'], path);
  }
  assert.throws(() => selectImpact(['examples/basic/task-events-other.ts']));
});

test('the example page selects only examples/basic (#1036)', () => {
  assert.deepEqual(selectImpact(['examples/basic/public/index.html']).dirs, ['examples/basic']);
  assert.throws(() => selectImpact(['examples/basic/public/other.html']));
});

test('wire v4 (#925) reviewed paths select only their owners', () => {
  assert.deepEqual(selectImpact(['examples/packaging/launcher.ts']).families, ['packageability-smoke']);
  assert.ok(selectImpact(['examples/packaging/launcher.ts']).dirs.includes('examples/packaging'));
  for (const path of ['examples/basic/quickstart-smoke.test.ts', 'examples/basic/server.ts', 'examples/basic/clarification.ts', 'examples/basic/goal-btw.ts']) {
    assert.deepEqual(selectImpact([path]).dirs, ['examples/basic'], path);
  }
  for (const path of ['scripts/integration/salesko-recurring.test.ts', 'packages/client/scripts/fixtures/packed-cli-mcp-codex.mjs']) {
    assert.ok(selectImpact([path]).dirs.includes('packages/client'), path);
  }
  assert.ok(selectImpact(['packages/client/scripts/fixtures/packed-cli-mcp-codex.mjs']).families.includes('npm-release-pack'));
  for (const path of ['templates/service/README.md', 'examples/byok-mcp-server/docs/hermes.md']) {
    assert.deepEqual(selectImpact([path]), { dirs: [], files: [path], families: [], reason: 'docs-only' }, path);
  }
  for (const path of ['templates/service/notes.md', 'examples/byok-mcp-server/docs/nested/hermes.md', 'scripts/integration/other.test.ts']) {
    assert.throws(() => selectImpact([path]), /reviewed CI mapping required/i, path);
  }
});

// #1030: the shared vitest globalSetup reruns every consumer suite and every family with a windows-latest vitest leg.
test('scripts/vitest/tmp-root.mjs selects every workspace that uses it and every Windows vitest leg', () => {
  const consumers = spawnSync('git', ['grep', '-l', 'scripts/vitest/tmp-root.mjs', '--', 'packages/*/vitest.config.ts', 'examples/*/vitest.config.ts'],
    { cwd: fileURLToPath(root), encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(file => file.slice(0, -'/vitest.config.ts'.length)).sort();
  assert.deepEqual([...vitestTmpRootConsumers].sort(), consumers);
  const plan = selectImpact(['scripts/vitest/tmp-root.mjs']);
  for (const dir of consumers) assert.ok(plan.dirs.includes(dir), dir);
  assert.deepEqual(plan.families, ['adapter-lifecycle-smoke', 'agent-memory-helper', 'dataplane', 'hermes-real-windows', 'ipc-smoke',
    'npm-release-pack', 'packageability-smoke', 'windows-client']);
  assert.deepEqual(selectImpact(['scripts/vitest/tmp-root.test.mjs']),
    { dirs: [], files: ['scripts/vitest/tmp-root.test.mjs'], families: [], reason: 'root-ci-scripts' });
  assert.match(readFileSync(new URL('scripts/ci/run-targeted.mjs', root), 'utf8'), /extraTests\.push\('scripts\/vitest\/tmp-root\.test\.mjs'\)/);
  assert.throws(() => selectImpact(['scripts/vitest/other.mjs']), /reviewed CI mapping required/i);
});

// #1030: only the Windows client job exercises the 8.3, letter-case and junction branches of the path fold.
test('the configured path fold selects the client suite and the Windows client job', () => {
  // dataplane comes from cloud-dataplane depending on the client.
  assert.deepEqual(selectImpact(['packages/client/src/util/fold-name-aliases.ts']).families, ['dataplane', 'windows-client']);
  assert.ok(selectImpact(['packages/client/src/util/fold-name-aliases.ts']).dirs.includes('packages/client'));
});


test('the todo build config selects the client build that runs it', () => {
  // check-adapters-entry.mjs --build-todo runs tsup.todo.config.ts in the client build.
  const runner = selectImpact(['packages/client/scripts/check-adapters-entry.mjs']);
  const todo = selectImpact(['packages/client/tsup.todo.config.ts']);
  assert.deepEqual(todo, { ...runner, files: todo.files });
  assert.ok(todo.dirs.includes('packages/client'));
  assert.ok(todo.families.includes('npm-release-pack'));
});

test('reviewed M package build configs keep owner consumers and packed artifacts, not adjacent unknown configs', () => {
  for (const owner of ['cloud-dataplane', 'cloud-do', 'cloud', 'protocol', 'server', 'testkit', 'ui-runtime']) {
    const path = `packages/${owner}/tsup.config.ts`;
    const plan = selectImpact([path]);
    const ownerScope = selectImpact([`packages/${owner}/tsconfig.json`]);
    assert.deepEqual(plan.dirs, ownerScope.dirs, path);
    assert.deepEqual(plan.families, sorted(new Set([...ownerScope.families, 'npm-release-pack'])), path);
    assert.throws(() => selectImpact([`packages/${owner}/tsup.unreviewed.config.ts`]), /reviewed CI mapping required/i);
    assert.throws(() => selectImpact([`packages/${owner}/tsup.config.mjs`]), /reviewed CI mapping required/i);
  }
  // #1387: cloud-do's build runs scripts/check-dist.mjs; a sibling script stays unreviewed.
  const checkDist = selectImpact(['packages/cloud-do/scripts/check-dist.mjs']);
  const cloudDo = selectImpact(['packages/cloud-do/tsconfig.json']);
  assert.deepEqual([checkDist.dirs, checkDist.families], [cloudDo.dirs, sorted(new Set([...cloudDo.families, 'npm-release-pack']))]);
  assert.throws(() => selectImpact(['packages/cloud-do/scripts/unreviewed.mjs']), /reviewed CI mapping required/i);
  assert.throws(() => selectImpact(['packages/client/tsup.other.config.ts']), /reviewed CI mapping required/i);
  assert.throws(() => selectImpact(['packages/unreviewed/tsup.config.ts']), /reviewed CI mapping required/i);
});


test('device setup guide selects schema/example admission and generator checks', () => {
  assert.ok(selectImpact(['docs/device-setup.md']).dirs.includes('packages/client'));
  for (const path of ['scripts/docs/device-setup.mjs', 'scripts/docs/device-setup.test.mjs']) {
    assert.deepEqual(reviewedScripts[path].tests, ['scripts/docs/device-setup.test.mjs']);
  }
});
