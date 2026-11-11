import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { syncOar } from './oar-sync.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'oar-sync-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'oar');
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const put = (file, text) => { mkdirSync(path.dirname(path.join(repo, file)), { recursive: true }); writeFileSync(path.join(repo, file), text); };
  const commit = message => { git('add', '-A'); git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message); return git('rev-parse', 'HEAD'); };
  mkdirSync(repo);
  git('init', '-q');
  put('packages/oar/package.json', '{"version":"1.0.0"}');
  put('packages/oar/src/kept.ts', 'export const kept = 1;\n');
  put('packages/oar/src/changed.ts', 'export const changed = 1;\n');
  const base = commit('base');
  put('packages/oar/src/changed.ts', 'export const changed = 2;\n');
  const fork = commit('fork delta');
  const vendorRoot = path.join(root, 'vendor');
  const dir = path.join(vendorRoot, base.slice(0, 7));
  mkdirSync(dir, { recursive: true });
  const manifest = {
    format: 'byok.vendor-source', version: 1, commit: base, release: { version: '1.0.0', gitCommit: base },
    files: [
      { path: 'kept.ts', sourcePath: 'packages/oar/src/kept.ts', upstreamSha256: '', vendoredSha256: '' },
      { path: 'changed.ts', sourcePath: 'packages/oar/src/changed.ts', upstreamSha256: '', vendoredSha256: '', delta: 'fixture delta' },
    ],
  };
  writeFileSync(path.join(dir, 'source-manifest.json'), JSON.stringify(manifest));
  const snapshot = () => Object.fromEntries(readdirSync(dir).sort().map(name => [name, readFileSync(path.join(dir, name), 'utf8')]));
  return { repo, base, fork, vendorRoot, dir, put, commit, snapshot };
}

test('a sync of the pinned fork commit reproduces the vendor tree byte for byte', t => {
  const f = fixture(t);
  syncOar({ repo: f.repo, fork: f.fork, base: f.base, vendorRoot: f.vendorRoot });
  const first = f.snapshot();
  assert.equal(first['changed.ts'], 'export const changed = 2;\n');
  assert.deepEqual(JSON.parse(first['source-manifest.json']).fork, { repository: 'https://github.com/Ancienttwo/oar', branch: 'byok/1.0.0', commit: f.fork });
  syncOar({ repo: f.repo, fork: f.fork, base: f.base, vendorRoot: f.vendorRoot });
  assert.deepEqual(f.snapshot(), first);
});

test('a changed fork byte reaches the vendor tree and its maintained hash', t => {
  const f = fixture(t);
  syncOar({ repo: f.repo, fork: f.fork, base: f.base, vendorRoot: f.vendorRoot });
  const before = JSON.parse(f.snapshot()['source-manifest.json']).files[1];
  f.put('packages/oar/src/changed.ts', 'export const changed = 3;\n');
  const next = f.commit('one byte');
  syncOar({ repo: f.repo, fork: next, base: f.base, vendorRoot: f.vendorRoot });
  const after = f.snapshot();
  assert.equal(after['changed.ts'], 'export const changed = 3;\n');
  const row = JSON.parse(after['source-manifest.json']).files[1];
  assert.equal(row.upstreamSha256, before.upstreamSha256);
  assert.notEqual(row.vendoredSha256, before.vendoredSha256);
});

test('a manifest path the fork lacks fails with that path and writes nothing', t => {
  const f = fixture(t);
  const manifestPath = path.join(f.dir, 'source-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files.push({ path: 'absent.ts', sourcePath: 'packages/oar/src/absent.ts', upstreamSha256: '', vendoredSha256: '' });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const before = f.snapshot();
  assert.throws(() => syncOar({ repo: f.repo, fork: f.fork, base: f.base, vendorRoot: f.vendorRoot }), /packages\/oar\/src\/absent\.ts \(fork /);
  assert.deepEqual(f.snapshot(), before);
});
