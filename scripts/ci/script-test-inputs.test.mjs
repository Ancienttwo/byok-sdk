import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { scriptChecksForPaths, selectImpact } from './select-impact.mjs';
import { needsBuild, planCi } from './plan-ci.mjs';
import { resolveScriptChecks, scriptTestInputs } from './script-test-inputs.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const schema = 'packages/client/daemon-config.schema.json';
const upgrade = 'scripts/release/check-upgrade-manifest.test.mjs';
const preFix = 'e1ec36df6e6db3bfb14190e80428f5618b983a66';

test('artifact readers select generically, deduplicate, and carry their install requirement', () => {
  const custom = { 'scripts/example.test.mjs': { inputs: [/^docs\/example\.md$/], install: true } };
  assert.deepEqual(resolveScriptChecks(['docs/example.md', 'docs/example.md'], {}, custom), {
    tests: ['scripts/example.test.mjs'], families: [], install: true,
  });
  assert.deepEqual(resolveScriptChecks(['docs/another.md'], {}, custom), { tests: [], families: [], install: false });
  assert.ok(scriptChecksForPaths([schema]).tests.includes(upgrade));
  assert.ok(!scriptChecksForPaths(['docs/unrelated.md']).tests.includes(upgrade));
  assert.ok(!scriptChecksForPaths(['packages/server/src/unrelated.ts']).tests.includes(upgrade));
  assert.ok(scriptChecksForPaths(['README.md']).tests.includes('scripts/release/install-matrix.test.mjs'));
  assert.ok(needsBuild(planCi({ event: 'push', sha: 'a'.repeat(40), paths: ['scripts/api-surface/check-provisioning-code-alignment.test.mjs'] })));
  assert.throws(() => selectImpact(['scripts/release/unreviewed.mjs']), /unmapped/,
    'an input declaration cannot bypass path admission');
});


test('reader inventory includes copied fixtures, native identity and built cross-package inputs', () => {
  for (const [input, reader] of [
    ['packages/client/upgrade-manifest.json', upgrade],
    ['api-surface/core.d.ts', upgrade],
    ['packages/client/native/agent-memory-fs/main.go', 'scripts/release/agent-memory-helper-source.test.mjs'],
    ['packages/client/src/daemon/agent-memory-helper-release-pin.ts', 'scripts/release/agent-memory-helper-source.test.mjs'],
    ['packages/client/src/runtime/codex-session-runtime.d.ts', 'scripts/api-surface/check-oar-bridge.test.mjs'],
    ['packages/protocol/src/provisioning.ts', 'scripts/api-surface/check-provisioning-code-alignment.test.mjs'],
    ['packages/client/src/adapters/pi/official-pi-closure.json', 'scripts/release/beta-release.test.mjs'],
    ['packages/core/README.md', 'scripts/release/pack-and-smoke.test.mjs'],
    ['packages/client/daemon-config.schema.json', 'scripts/docs/device-setup.test.mjs'],
    ['scripts/release/registry-expectations.json', 'scripts/release/registry-contract.test.mjs'],
  ]) assert.ok(scriptChecksForPaths([input]).tests.includes(reader), `${input} -> ${reader}`);
});

test('every declared reader is a tracked root script test with real repository input matches', () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  for (const [reader, { inputs }] of Object.entries(scriptTestInputs)) {
    assert.ok(tracked.includes(reader) && manifest.scripts['test:scripts'].split(' ').includes(reader), reader);
    for (const pattern of inputs) {
      assert.ok(!pattern.global && !pattern.sticky, `${reader}: stateless matcher`);
      assert.ok(tracked.some(path => pattern.test(path)), `${reader}: ${pattern} matches no repository input`);
    }
    assert.ok(scriptChecksForPaths([reader]).tests.includes(reader));
  }
});

// Run the actual historical and current runners, recording their subprocess
// selection. Workspace execution is stubbed so this regression proves routing
// independently of the schema's contents or installed product artifacts.
test('#1168: pre-fix schema-only routing omits the gate test; fixed routing executes it', t => {
  const cwd = mkdtempSync(join(tmpdir(), 'ci-schema-reader-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const historical = join(cwd, 'historical'); mkdirSync(historical);
  const moduleNames = ['select-impact.mjs', 'plan-ci.mjs', 'run-targeted.mjs', 'documentation-checks.mjs'];
  for (const name of moduleNames) {
    const source = execFileSync('git', ['show', `${preFix}:scripts/ci/${name}`], { cwd: root, encoding: 'utf8' })
      .replace(/from '(\.\.?\/[^']+)'/g, (match, relative) => moduleNames.includes(relative.slice(2))
        ? match : `from '${new URL(relative, new URL(`./${name}`, import.meta.url)).href}'`);
    writeFileSync(join(historical, name), source);
  }
  const plan = planCi({ event: 'push', sha: 'a'.repeat(40), base: preFix, paths: [schema] });
  writeFileSync(join(cwd, 'package.json'), '{}');
  for (const dir of plan.dirs) {
    mkdirSync(join(cwd, dir), { recursive: true });
    writeFileSync(join(cwd, dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'check', test: 'check' } }));
  }
  const record = join(cwd, 'calls.jsonl');
  const preload = join(cwd, 'record.mjs');
  writeFileSync(preload, `import cp from 'node:child_process'; import {appendFileSync} from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    cp.spawnSync = (command, args) => { appendFileSync(process.env.RECORD, JSON.stringify({command,args})+'\\n'); return {status:0}; }; syncBuiltinESMExports();`);
  const run = runner => {
    writeFileSync(record, '');
    const env = { ...process.env, CI_EVENT: 'push', CI_BASE: preFix, CI_PLAN: JSON.stringify(plan), RECORD: record };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--import', preload, runner], { cwd, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).flatMap(line => JSON.parse(line).args);
  };
  assert.ok(!run(join(historical, 'run-targeted.mjs')).includes(upgrade));
  assert.ok(run(fileURLToPath(new URL('./run-targeted.mjs', import.meta.url))).includes(upgrade));
});
