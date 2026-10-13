import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setup, teardown } from './tmp-root.mjs';

const helper = fileURLToPath(new URL('./tmp-root.mjs', import.meta.url));
const vitest = fileURLToPath(new URL('../../node_modules/vitest/vitest.mjs', import.meta.url));
const keys = ['TMPDIR', 'TEMP', 'TMP'];

test('teardown restores the environment and removes only the owned run root', () => {
  const previous = keys.map(key => process.env[key]);
  const parent = os.tmpdir();
  const untouched = mkdtempSync(path.join(parent, 'tmp-root-sentinel-'));
  let root;
  try {
    setup();
    root = os.tmpdir();
    assert.match(path.basename(root), /^byok-t-/);
    assert.notEqual(root, parent);
    mkdirSync(path.join(root, 'byok-left-by-a-test'));
    assert.throws(setup, /ran twice/);
    teardown();
    assert.equal(existsSync(root), false);
    assert.equal(existsSync(untouched), true);
    assert.deepEqual(keys.map(key => process.env[key]), previous);
    teardown();
    assert.deepEqual(keys.map(key => process.env[key]), previous);
  } finally {
    teardown();
    rmSync(untouched, { recursive: true });
  }
});

for (const fails of [false, true]) {
  test(`real Vitest workers inherit the run root and clean up after ${fails ? 'failure' : 'success'}`, () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), 'tmp-root-fixture-'));
    const recordedRoot = path.join(fixture, 'root.txt');
    try {
      writeFileSync(path.join(fixture, 'vitest.config.mjs'), `export default { test: { globalSetup: [${JSON.stringify(helper)}] } };`);
      writeFileSync(path.join(fixture, 'root.test.mjs'), `
        import { it, expect } from ${JSON.stringify(fileURLToPath(new URL('../../node_modules/vitest/dist/index.js', import.meta.url)))};
        import { mkdtempSync, writeFileSync } from 'node:fs';
        import { tmpdir } from 'node:os';
        import path from 'node:path';
        it('leaves scratch data for teardown', () => {
          writeFileSync(${JSON.stringify(recordedRoot)}, tmpdir());
          mkdtempSync(path.join(tmpdir(), 'byok-deliberately-unremoved-'));
          expect(path.basename(tmpdir())).toMatch(/^byok-t-/);
          expect(${fails}).toBe(false);
        });
      `);
      const result = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.config.mjs'], {
        cwd: fixture, encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(result.status, fails ? 1 : 0, result.stdout + result.stderr);
      // Reading this file also proves the test body ran, rather than accepting
      // an early loader error as the intentional negative control.
      const root = readFileSync(recordedRoot, 'utf8');
      assert.match(path.basename(root), /^byok-t-/);
      assert.equal(existsSync(root), false, `Vitest left ${root} behind`);
    } finally {
      rmSync(fixture, { recursive: true });
    }
  });
}
