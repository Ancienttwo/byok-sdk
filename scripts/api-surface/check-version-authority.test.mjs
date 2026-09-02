import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'check-version-authority.mjs',
);

const README = [
  '# BYOK SDK',
  '',
  '## Current release',
  '',
  'The current release is `byok-sdk@0.12.0`, with the independently versioned',
  '`@byok-sdk/keys@0.3.9`. See CHANGELOG.md for the per-train notes.',
  '',
  '```bash',
  'npm install byok-sdk@0.12.0',
  'npm install @byok-sdk/keys@0.3.9',
  '```',
  '',
].join('\n');

// The real docs/spec.md wraps this sentence across a line break, so the check
// has to match across newlines; the fixture reproduces that shape.
const SPEC = [
  '## Pre-1.0 package version policy',
  '',
  'A version bump does not authorize publish. The current',
  'aligned dispatch release is `0.12.0`; publication requires separate release',
  'authorization and registry readback. The current independent keys candidate is',
  '`0.3.9`; its packed and published `@byok-sdk/core` edge must be the exact current',
  'dispatch release, `0.12.0`.',
  '',
].join('\n');

// Builds a fixture repo root; every part can be overridden per test.
function makeRoot(t, { dispatch = '0.12.0', keys = '0.3.9', readme = README, spec = SPEC } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'version-authority-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [pkg, version] of [
    ['core', dispatch],
    ['keys', keys],
  ]) {
    mkdirSync(path.join(root, 'packages', pkg), { recursive: true });
    writeFileSync(
      path.join(root, 'packages', pkg, 'package.json'),
      `${JSON.stringify({ name: `@byok-sdk/${pkg}`, version }, null, 2)}\n`,
    );
  }
  writeFileSync(path.join(root, 'README.md'), readme);
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'spec.md'), spec);
  return root;
}

const runCheck = (root) =>
  spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });

test('passes when README and spec agree with both manifests', (t) => {
  const result = runCheck(makeRoot(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /byok-sdk@0\.12\.0 and @byok-sdk\/keys@0\.3\.9/);
});

test('a stale README dispatch version is reported with file:line', (t) => {
  const root = makeRoot(t, { readme: README.replace('npm install byok-sdk@0.12.0', 'npm install byok-sdk@0.8.1') });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md:9: dispatch release is advertised as 0\.8\.1, but the authority says 0\.12\.0/);
});

test('a stale README keys version is reported', (t) => {
  const root = makeRoot(t, { readme: README.replace('@byok-sdk/keys@0.3.9`.', '@byok-sdk/keys@0.3.2`.') });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /keys release is advertised as 0\.3\.2, but the authority says 0\.3\.9/);
});

test('a second, stray dispatch version anywhere in README fails', (t) => {
  const root = makeRoot(t, {
    readme: `${README}\nUpgrading from \`byok-sdk@0.11.0\` needs no migration.\n`,
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dispatch release is advertised as 0\.11\.0/);
});

test('a README with no version string at all fails closed', (t) => {
  const root = makeRoot(t, { readme: '# BYOK SDK\n\nNo versions here.\n' });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no dispatch release version string found; expected 0\.12\.0/);
  assert.match(result.stderr, /no keys release version string found; expected 0\.3\.9/);
});

test('a stale spec dispatch phrase is reported', (t) => {
  const root = makeRoot(t, {
    spec: SPEC.replace('aligned dispatch release is `0.12.0`', 'aligned dispatch release is `0.11.0`'),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/spec\.md:\d+: current aligned dispatch release is stated as 0\.11\.0/);
});

test('a stale spec keys phrase is reported', (t) => {
  const root = makeRoot(t, {
    spec: SPEC.replace('`0.3.9`; its packed', '`0.3.8`; its packed'),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /current independent keys candidate is stated as 0\.3\.8/);
});

test('a spec missing the authority phrase fails closed', (t) => {
  const root = makeRoot(t, { spec: '## Pre-1.0 package version policy\n\nNothing stated.\n' });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the phrase naming the current aligned dispatch release \(0\.12\.0\) is missing/);
  assert.match(result.stderr, /the phrase naming the current independent keys candidate \(0\.3\.9\) is missing/);
});

test('the manifests, not the docs, are the authority', (t) => {
  // Bumping only the manifest must turn the check red rather than quietly
  // accepting the previous train's strings.
  const root = makeRoot(t, { dispatch: '0.13.0' });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the authority says 0\.13\.0/);
});
