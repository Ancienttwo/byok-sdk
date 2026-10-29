import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

test('docs and known CI contracts select light checks, not release families', () => {
  assert.deepEqual(selectImpact(['README.md', 'docs/releases/v0.28.1.md']), {
    dirs: [], files: ['README.md', 'docs/releases/v0.28.1.md'], families: [], reason: 'docs-only',
  });
  for (const path of ['.github/workflows/release.yml', 'scripts/ci/select-impact.mjs']) {
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

test('packages/AGENTS.md and packages/CLAUDE.md are docs-only like the root agent files', () => {
  assert.deepEqual(selectImpact(['packages/AGENTS.md', 'packages/CLAUDE.md']), {
    dirs: [], files: ['packages/AGENTS.md', 'packages/CLAUDE.md'], families: [], reason: 'docs-only',
  });
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
  assert.deepEqual(selectImpact(['.github/workflows/release.yml']).families, []);
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
  for (const path of ['packages/client/src/daemon/task-runner.ts', 'packages/client/src/__tests__/deleted.test.ts', 'api-surface/client.d.ts']) {
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
    'ipc-smoke': 'packages/client/src/daemon/control-server.ts',
    'credential-isolation-audit': 'packages/keys/src/index.ts',
    'hermes-real-windows': 'packages/client/src/__tests__/hermes-real.test.ts',
    'runtime-contract': 'packages/client/src/__tests__/runtime-contract/contract.ts',
  };
  assert.deepEqual(Object.keys(owned).sort(), Object.keys(familyOwners).sort());
  const tracked = new Set(spawnSync('git', ['ls-files'], { cwd: fileURLToPath(root), encoding: 'utf8' }).stdout.split('\n').filter(Boolean));
  for (const path of Object.values(owned)) assert.ok(tracked.has(path), `example path is not tracked: ${path}`);
  for (const [family, owners] of Object.entries(familyOwners)) {
    for (const owner of owners) assert.ok([...tracked].some(path => owner.test(path)), `${family} owner ${owner} matches no tracked file`);
  }
  for (const [family, path] of Object.entries(owned)) assert.ok(selectImpact([path]).families.includes(family), `${family}: ${path}`);
  for (const path of ['packages/client/src/daemon/task-runner.ts', 'packages/protocol/src/task.ts', 'packages/core/src/index.ts', 'packages/server/src/index.ts']) {
    assert.deepEqual(selectImpact([path]).families.filter(id => id in familyOwners), [], path);
  }
});

test('shared Windows filesystem helpers select their real Windows consumers', () => {
  assert.deepEqual(selectImpact(['packages/client/src/util/secure-dir.ts']).families, ['dataplane', 'windows-client', 'windows-service-smoke']);
  assert.deepEqual(selectImpact(['packages/client/src/util/atomic-write.ts']).families, ['dataplane', 'ipc-smoke', 'windows-client']);
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
  for (const path of ['packages/client/src/bin/control-client.ts', 'packages/client/src/bin/commands/unpair.ts', 'packages/client/scripts/control-socket-check.mjs']) {
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
test('family owners cover every test file and script their CI job runs', () => {
  const workflow = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8');
  const dirOf = name => Object.keys(workspaceGraph).find(dir => workspaceGraph[dir].name === name);
  const clientScripts = JSON.parse(readFileSync(new URL('packages/client/package.json', root), 'utf8')).scripts;
  let checked = 0;
  for (const family of Object.keys(familyOwners)) {
    const start = workflow.indexOf(`\n  ${family}:\n`);
    assert.ok(start >= 0, family);
    const next = workflow.slice(start + 1).search(/\n  [a-z0-9-]+:\n/);
    const block = workflow.slice(start, next < 0 ? undefined : start + 1 + next).replace(/[`\\]\r?\n\s*/g, ' ');
    const paths = [];
    for (const match of block.matchAll(/bun run (?:--filter (\S+)|--cwd (\S+)) (test|[a-z]+:[a-z-]+)(?=\s|$)(?: --([^\n]*))?/g)) {
      const dir = match[2] ?? dirOf(match[1]);
      assert.ok(dir, match[0]);
      if (match[3] === 'test') {
        const files = (match[4] ?? '').split(/\s+/).map(file => file.replace(/\)$/, '')).filter(file => /\.test\.ts$/.test(file));
        paths.push(...(files.length ? files.map(file => `${dir}/${file}`) : [`${dir}/src/suite-probe.ts`]));
      } else if (dir === 'packages/client' && match[3] !== 'build:agent-memory-helper') {
        for (const script of clientScripts[match[3]].matchAll(/scripts\/[a-z-]+\.mjs/g)) paths.push(`packages/client/${script[0]}`);
      }
    }
    for (const match of block.matchAll(/(?:node|bun) ((?:packages|examples|templates|scripts)\/[\w./-]+\.mjs)/g)) paths.push(match[1]);
    for (const match of block.matchAll(/working-directory: (\S+)\s+run: [^\n]*\bgo test\b/g)) paths.push(`${match[1]}/suite-probe.go`);
    assert.ok(paths.length > 0, `${family}: no job input checked`);
    for (const path of paths) {
      assert.ok(selectImpact([path]).families.includes(family), `${family} runs ${path} but a change to it does not select ${family}`);
      checked++;
    }
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
  for (const path of ['bun.lock', 'package.json', 'packages/client/package.json', 'api-surface/entries.json', '.github/workflows/unreviewed.yml', 'packages/new/src/index.ts', 'packages/client/vendor/new.js', 'scripts/release/pg-migrate-smoke.mjs', 'other/a.md', '../README.md', './README.md', '/README.md', 'docs//a.md', 'docs/../README.md', 'docs/a\nb.md', 'docs\\a.md', '', null]) {
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
    'scripts/api-surface/check-version-authority.mjs', 'scripts/api-surface/check-version-authority.test.mjs',
    'scripts/architecture/dependency-baseline.json', 'scripts/architecture/dependency-graph.mjs', 'scripts/architecture/dependency-graph.test.mjs',
    'scripts/docs/device-setup.mjs', 'scripts/docs/device-setup.test.mjs',
    'scripts/release/beta-release.test.mjs', 'scripts/release/check-package-graph.mjs',
    'scripts/release/check-upgrade-manifest.mjs', 'scripts/release/check-upgrade-manifest.test.mjs',
    'scripts/release/execution-submit-smoke.mjs',
    'scripts/release/pack-and-smoke.mjs',
    'scripts/release/pack-and-smoke.test.mjs',
    'scripts/release/packaging-plugin-smoke.mjs',
    'scripts/release/pi-launcher-smoke.mjs',
    'scripts/release/publish.mjs', 'scripts/release/registry-readback.mjs',
    'scripts/release/upgrade-manifest/dts-surface.mjs', 'scripts/release/upgrade-manifest/manifest.mjs',
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
  assert.ok(runners.includes('npm-release-pack'));
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
  for (const path of ['scripts/release/publish.test.mjs', 'scripts/release/pg-migrate-smoke.mjs', 'scripts/release/registry-contract.mjs',
    'scripts/release/nested/publish.mjs', 'scripts/api-surface/check-api-surface.mjs', 'scripts/api-surface/check-version-authority.js']) {
    assert.throws(() => selectImpact([path]), /reviewed CI mapping required/i, path);
  }
});

test('selection is deterministic, deduplicated, and uses only known family IDs', () => {
  const paths = ['packages/client/src/a.ts', 'packages/core/src/b.ts', 'README.md'];
  const selection = selectImpact(paths);
  assert.deepEqual(selection, selectImpact([...paths].reverse().concat(paths)));
  assert.ok(selection.families.every(id => knownFamilies.includes(id)));
  assert.equal(knownFamilies.length, 18);
});

test('CLI accepts JSON stdin and fails closed without an output selection on bad JSON', () => {
  const script = fileURLToPath(new URL('./select-impact.mjs', import.meta.url));
  const good = spawnSync(process.execPath, [script], { input: '["README.md"]', encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(JSON.parse(good.stdout).reason, 'docs-only');
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


test('the sealed client build config retains the ordinary client build scope', () => {
  const ordinary = selectImpact(['packages/client/tsup.config.ts']);
  const sealed = selectImpact(['packages/client/tsup.sealed.config.ts']);
  assert.deepEqual(sealed.dirs, ordinary.dirs);
  assert.deepEqual(sealed.families, ordinary.families);
  assert.equal(sealed.reason, ordinary.reason);
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
  assert.throws(() => selectImpact(['packages/client/tsup.other.config.ts']), /reviewed CI mapping required/i);
  assert.throws(() => selectImpact(['packages/unreviewed/tsup.config.ts']), /reviewed CI mapping required/i);
});


test('device setup guide selects schema/example admission and generator checks', () => {
  assert.ok(selectImpact(['docs/device-setup.md']).dirs.includes('packages/client'));
  for (const path of ['scripts/docs/device-setup.mjs', 'scripts/docs/device-setup.test.mjs']) {
    assert.deepEqual(reviewedScripts[path].tests, ['scripts/docs/device-setup.test.mjs']);
  }
});
