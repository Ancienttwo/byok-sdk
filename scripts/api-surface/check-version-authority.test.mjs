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
  'The current release is `@byok-sdk/core@0.12.0` for every published package,',
  'including `@byok-sdk/keys@0.12.0`. See CHANGELOG.md for the per-train notes.',
  '',
  '```bash',
  'npm install @byok-sdk/client@0.12.0 @byok-sdk/server@0.12.0',
  'npm install @byok-sdk/keys@0.12.0',
  '```',
  '',
  'The bundled Pi runtime is `@byok-sdk/pi-coding-agent@0.86.1001`.',
  '',
].join('\n');

// The real docs/spec.md wraps this sentence across a line break, so the check
// has to match across newlines; the fixture reproduces that shape.
const SPEC = [
  '## Pre-1.0 package version policy',
  '',
  'A version bump does not authorize publish. The current',
  'aligned release is `0.12.0` for all nine public packages, keys included;',
  'publication requires separate release authorization and registry readback.',
  '',
].join('\n');

// The spec wording before 0.28.2, when keys had its own version line.
const SEPARATE_KEYS_SPEC = [
  '## Pre-1.0 package version policy',
  '',
  'A version bump does not authorize publish. The current',
  'aligned dispatch release is `0.12.0`; publication requires separate release',
  'authorization and registry readback. The current independent keys release is',
  '`0.3.9`; its packed and published `@byok-sdk/core` edge must be the exact current',
  'dispatch release, `0.12.0`.',
  '',
].join('\n');

// Builds a fixture repo root; every part can be overridden per test.
function makeRoot(t, { release = '0.12.0', keys = release, readme = README, spec = SPEC } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'version-authority-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const manifest of [
    { name: '@byok-sdk/core', version: release },
    { name: '@byok-sdk/client', version: release },
    { name: '@byok-sdk/server', version: release },
    { name: '@byok-sdk/keys', version: keys },
    { name: '@byok-sdk/testkit', version: '0.0.0', private: true },
  ]) {
    const pkg = manifest.name.slice('@byok-sdk/'.length);
    mkdirSync(path.join(root, 'packages', pkg), { recursive: true });
    writeFileSync(
      path.join(root, 'packages', pkg, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
  writeFileSync(path.join(root, 'README.md'), readme);
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  writeFileSync(path.join(root, 'docs', 'spec.md'), spec);
  return root;
}

const runCheck = (root) =>
  spawnSync(process.execPath, [script, '--root', root], { encoding: 'utf8' });

test('passes when README and spec agree with the release train', (t) => {
  const result = runCheck(makeRoot(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /release train 0\.12\.0 \(packages\/core\/package\.json\)$/m);
});

test('a stale README version on any published train package is reported with file:line', (t) => {
  const root = makeRoot(t, { readme: README.replace('@byok-sdk/server@0.12.0', '@byok-sdk/server@0.8.1') });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /README\.md:9: release train package @byok-sdk\/server is advertised as 0\.8\.1, but the authority says 0\.12\.0/,
  );
});

test('the retired byok-sdk umbrella is rejected even at the current version', (t) => {
  const root = makeRoot(t, { readme: `${README}\nnpm install byok-sdk@0.12.0\n` });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md:\d+: advertises the retired byok-sdk umbrella \(byok-sdk@0\.12\.0\)/);
});

test('private workspace packages and external fork artifacts are not train mentions', (t) => {
  const root = makeRoot(t, { readme: `${README}\nThe repo-internal \`@byok-sdk/testkit@0.0.0\` is not published.\n` });
  const result = runCheck(root);
  assert.equal(result.status, 0, result.stderr);
});

test('a README keys version that differs from the release train fails', (t) => {
  // keys has no version line of its own. A keys manifest and README that agree
  // on a separate version still fail: only the release train version counts.
  const root = makeRoot(t, { keys: '0.3.9', readme: README.replaceAll('@byok-sdk/keys@0.12.0', '@byok-sdk/keys@0.3.9') });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  for (const line of [6, 10]) {
    assert.match(
      result.stderr,
      new RegExp(`README\\.md:${line}: release train package @byok-sdk/keys is advertised as 0\\.3\\.9, but the authority says 0\\.12\\.0`),
    );
  }
});

test('a second, stray dispatch version anywhere in README fails', (t) => {
  const root = makeRoot(t, {
    readme: `${README}\nUpgrading from \`@byok-sdk/client@0.11.0\` needs no migration.\n`,
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release train package @byok-sdk\/client is advertised as 0\.11\.0/);
});

test('a README with no version string at all fails closed', (t) => {
  const root = makeRoot(t, { readme: '# BYOK SDK\n\nNo versions here.\n' });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no release train version string found; expected 0\.12\.0/);
});

test('a stale spec release phrase is reported', (t) => {
  const root = makeRoot(t, {
    spec: SPEC.replace('aligned release is `0.12.0`', 'aligned release is `0.11.0`'),
  });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /docs\/spec\.md:\d+: current aligned release is stated as 0\.11\.0/);
});

test('a spec that still states separate dispatch and keys versions fails closed', (t) => {
  const root = makeRoot(t, { spec: SEPARATE_KEYS_SPEC });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the phrase naming the current aligned release \(0\.12\.0\) is missing/);
});

test('a spec missing the authority phrase fails closed', (t) => {
  const root = makeRoot(t, { spec: '## Pre-1.0 package version policy\n\nNothing stated.\n' });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the phrase naming the current aligned release \(0\.12\.0\) is missing/);
});

test('the manifests, not the docs, are the authority', (t) => {
  // Bumping only the manifest must turn the check red rather than quietly
  // accepting the previous train's strings.
  const root = makeRoot(t, { release: '0.13.0' });
  const result = runCheck(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the authority says 0\.13\.0/);
});
