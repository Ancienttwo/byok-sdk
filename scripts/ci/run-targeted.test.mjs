import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { planCi } from './plan-ci.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sha = 'a'.repeat(40);
const base = 'b'.repeat(40);
const posixOnly = { skip: process.platform === 'win32' };

// Run the real targeted runner. A recording bun first on PATH logs each
// workspace check instead of running it. The CI job env carries PR evidence,
// so the child gets an explicit push plan without it. Routing-only callers
// also record reader execution: CI runs these contracts before install/build.
function runTargeted(plan, cwd = root, readerExit) {
  const bin = mkdtempSync(path.join(tmpdir(), 'ci-run-targeted-'));
  try {
    const log = path.join(bin, 'bun.log');
    writeFileSync(log, '');
    writeFileSync(path.join(bin, 'bun'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "$FAKE_BUN_LOG"\n`);
    chmodSync(path.join(bin, 'bun'), 0o755);
    const readers = path.join(bin, 'readers.jsonl');
    writeFileSync(readers, '');
    const preload = path.join(bin, 'record-readers.mjs');
    if (readerExit !== undefined) writeFileSync(preload, `
      import cp from 'node:child_process';
      import { appendFileSync } from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const spawn = cp.spawnSync;
      cp.spawnSync = (command, args, options) => {
        if (command === process.execPath && args[0] === '--test') {
          appendFileSync(process.env.READER_LOG, JSON.stringify(args.slice(2)) + '\\n');
          return { status: ${readerExit} };
        }
        return spawn(command, args, options);
      };
      syncBuiltinESMExports();
    `);
    const env = { ...process.env, READER_LOG: readers, CI_EVENT: 'push', CI_BASE: plan.base, CI_PLAN: JSON.stringify(plan),
      FAKE_BUN_LOG: log, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
    delete env.CI_PR_HEAD; delete env.GITHUB_SHA;
    // Under node --test the runner's own node --test child would report to this
    // test process instead of printing; CI runs the runner outside node --test.
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [...(readerExit === undefined ? [] : ['--import', preload]), fileURLToPath(new URL('./run-targeted.mjs', import.meta.url))], { cwd, env, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean),
      readers: readFileSync(readers, 'utf8').split('\n').filter(Boolean).flatMap(line => JSON.parse(line)) };
  } finally { rmSync(bin, { recursive: true, force: true }); }
}

// #671 selects packageability-smoke only for paths it owns. A keys-only change
// selected examples/packaging without that family before #671 too. #1104: the
// example's bundle test runs with it, so a new SDK import.meta site fails here.
test('dependent-only changes run every selected workspace check without the packaging smoke', posixOnly, () => {
  for (const changed of ['packages/client/src/daemon/task-runner.ts', 'packages/keys/src/index.ts']) {
    const plan = planCi({ event: 'push', sha, base, paths: [changed] });
    assert.ok(plan.dirs.includes('examples/packaging'), changed);
    assert.ok(!plan.families.includes('packageability-smoke'), changed);
    const { status, stderr, calls, readers } = runTargeted(plan, root, 0);
    assert.equal(status, 0, `${changed}\n${stderr}`);
    assert.deepEqual(readers.sort(), [
      // Both are registered generator/check pairs, so the documentation test
      // selector qualifies them for any packages/*/src input.
      'scripts/docs/capability-matrix.test.mjs',
      'scripts/docs/device-setup.test.mjs',
      'scripts/architecture/dependency-graph.test.mjs',
      ...(changed.startsWith('packages/client/')
        ? ['scripts/api-surface/check-oar-bridge.test.mjs']
        : ['scripts/release/check-upgrade-manifest.test.mjs', 'scripts/api-surface/check-provisioning-code-alignment.test.mjs']),
    ].sort(), changed);
    const expected = plan.dirs.flatMap(dir => {
      const { scripts } = JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
      return ['typecheck', 'test'].filter(script => scripts[script]).map(script => `run --cwd ${dir} ${script}`);
    });
    assert.deepEqual(calls, expected, changed);
    assert.deepEqual(calls.filter(call => call.startsWith('run --cwd examples/packaging ')),
      ['run --cwd examples/packaging typecheck', 'run --cwd examples/packaging test'], changed);
  }
});

test('a selected reader failure stops workspace execution', posixOnly, () => {
  const plan = planCi({ event: 'push', sha, base, paths: ['packages/keys/src/index.ts'] });
  const result = runTargeted(plan, root, 23);
  assert.equal(result.status, 23, result.stderr);
  assert.ok(result.readers.includes('scripts/api-surface/check-provisioning-code-alignment.test.mjs'));
  assert.deepEqual(result.calls, []);
});

test('another selected workspace without a test check still fails closed', posixOnly, () => {
  const plan = planCi({ event: 'push', sha, base, paths: ['examples/packaging/src/index.ts'] });
  const cwd = mkdtempSync(path.join(tmpdir(), 'ci-run-targeted-cwd-'));
  try {
    writeFileSync(path.join(cwd, 'package.json'), '{}');
    for (const dir of plan.dirs) {
      mkdirSync(path.join(cwd, dir), { recursive: true });
      const scripts = dir === 'examples/packaging' ? { typecheck: 'tsc' } : { typecheck: 'tsc', test: 'vitest' };
      writeFileSync(path.join(cwd, dir, 'package.json'), JSON.stringify({ scripts }));
    }
    const { status, stderr, calls } = runTargeted(plan, cwd);
    assert.notEqual(status, 0);
    assert.match(stderr, /Selected workspace examples\/packaging has no test check/);
    assert.ok(calls.includes('run --cwd examples/packaging typecheck'));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

// #649: a reviewed release script path runs the node tests mapped to it, and no
// workspace check.
test('a reviewed release script path runs its mapped node tests', posixOnly, () => {
  const plan = planCi({ event: 'push', sha, base, paths: ['scripts/api-surface/check-version-authority.mjs'] });
  assert.deepEqual([plan.dirs, plan.families], [[], []]);
  const { status, stdout, stderr, calls } = runTargeted(plan);
  assert.equal(status, 0, stderr);
  assert.match(stdout, /a README keys version that differs from the release train fails/);
  assert.match(stdout, /(?:ℹ|#) fail 0/);
  assert.deepEqual(calls, []);
});

test('manifest-declared documentation checks run for generator, markdown and SDK inputs', posixOnly, () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'ci-doc-projection-'));
  try {
    mkdirSync(path.join(cwd, 'scripts/docs'), { recursive: true });
    writeFileSync(path.join(cwd, 'scripts/docs/capability-matrix.mjs'), '');
    writeFileSync(path.join(cwd, 'scripts/docs/capability-matrix.test.mjs'),
      "import { test } from 'node:test'; test('registered projection executed', () => {});");
    writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ scripts: {
      'docs:capability-matrix': 'node scripts/docs/capability-matrix.mjs --write',
      'check:capability-matrix': 'node scripts/docs/capability-matrix.mjs',
      'test:scripts': 'node --test scripts/docs/capability-matrix.test.mjs',
    } }));
    for (const input of ['docs/adapter-capabilities.md', 'scripts/docs/capability-matrix.mjs',
      'scripts/docs/capability-matrix.test.mjs', 'packages/client/src/adapters/pi/pi-capabilities.ts',
      'packages/client/src/adapters/claude/claude-version.ts']) {
      const plan = planCi({ event: 'push', sha, base, paths: [input], cwd });
      for (const dir of plan.dirs) {
        mkdirSync(path.join(cwd, dir), { recursive: true });
        writeFileSync(path.join(cwd, dir, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc', test: 'vitest' } }));
      }
      const { status, stdout, stderr } = runTargeted(plan, cwd);
      assert.equal(status, 0, stderr);
      assert.match(stdout, /registered projection executed/);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
