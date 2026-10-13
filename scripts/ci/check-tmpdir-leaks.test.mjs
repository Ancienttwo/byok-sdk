import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findNewEntries } from './check-tmpdir-leaks.mjs';

const script = fileURLToPath(new URL('./check-tmpdir-leaks.mjs', import.meta.url));

describe('check-tmpdir-leaks', () => {
  let root;
  let tmp;
  let snapshot;
  const run = mode => spawnSync(process.execPath, [script, mode, snapshot], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp },
  });

  before(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'tmpleak-test-'));
    tmp = path.join(root, 'tmp');
    mkdirSync(tmp);
    snapshot = path.join(root, 'snapshot.txt');
    mkdirSync(path.join(tmp, 'byok-preexisting'));
    mkdirSync(path.join(tmp, 'unrelated'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('passes when nothing new appeared, ignoring pre-existing residue', () => {
    assert.equal(run('snapshot').status, 0);
    const verify = run('verify');
    assert.equal(verify.status, 0, verify.stderr);
  });

  it('ignores new entries without the byok- prefix', () => {
    mkdirSync(path.join(tmp, 'other-new'));
    assert.equal(run('verify').status, 0);
  });

  it('fails and names the entry when a byok-* directory is leaked', () => {
    mkdirSync(path.join(tmp, 'byok-deliberate-leak'));
    const verify = run('verify');
    assert.equal(verify.status, 1);
    assert.match(verify.stderr, /1 new byok-\* entries/);
    assert.match(verify.stderr, /byok-deliberate-leak/);
    assert.doesNotMatch(verify.stderr, /byok-preexisting/);
  });

  it('rejects a missing mode or file', () => {
    const result = spawnSync(process.execPath, [script, 'verify'], { encoding: 'utf8' });
    assert.equal(result.status, 2);
  });

  it('findNewEntries returns only names absent from the baseline', () => {
    assert.deepEqual(findNewEntries(['byok-a'], ['byok-a', 'byok-b']), ['byok-b']);
  });

  it('also rejects a run root leaked into the fixed short root', { skip: process.platform === 'win32' }, () => {
    assert.equal(run('snapshot').status, 0);
    const leaked = mkdtempSync('/tmp/byok-t-');
    try {
      const result = run('verify');
      assert.equal(result.status, 1, result.stdout);
      assert.match(result.stderr, new RegExp(path.basename(leaked)));
    } finally {
      rmSync(leaked, { recursive: true });
    }
  });

  it('fails closed on an empty snapshot', () => {
    writeFileSync(snapshot, '[]');
    assert.notEqual(run('verify').status, 0);
  });
});
