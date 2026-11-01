import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { audit, parseResult, vendorInventory } from './security-advisories.mjs';

const advisory = { id: 'GHSA-35jh-r3h4-6jhm', aliases: ['CVE-2021-23337'], summary: 'Command Injection in lodash' };
const result = (vulnerabilities = []) => ({ status: vulnerabilities.length ? 1 : 0, stdout: JSON.stringify({ results: [{ source: { path: 'bun.lock', type: 'lockfile' }, packages: [{ package: { name: 'lodash', version: '4.17.20', ecosystem: 'npm' }, vulnerabilities }] }] }), stderr: '' });
function fixture(t, manifest = { format: 'byok.vendor-source', version: 1, package: 'lodash', packageVersion: '4.17.20' }) {
  const root = mkdtempSync(join(tmpdir(), 'byok-security-advisories-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'packages/client/vendor/example'), { recursive: true });
  writeFileSync(join(root, 'packages/client/vendor/example/source-manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(root, 'bun.lock'), readFileSync(new URL('./security-advisories-fixtures/vulnerable-bun.lock', import.meta.url)));
  return { root, output: join(root, 'report'), scannerPath: 'test-scanner' };
}

const oarCommit = 'ddec7e575a5f8e65ea35011e64c0d35eef08f6bd';
const oarRelease = {
  ecosystem: 'npm',
  name: '@botiverse/oar',
  version: '0.83.0',
  integrity: 'sha512-NcuJljjWXegNwgeb8i91TOCC5N7+iL4nG1DyWiMur48p5l0ur3WACpOgMQf317+UYhTXv50Rv+eC0tLPbSv0aQ==',
  gitCommit: oarCommit,
  provenance: 'https://registry.npmjs.org/-/npm/v1/attestations/@botiverse%2foar@0.83.0',
};
const oarManifest = (overrides = {}) => ({
  format: 'byok.vendor-source', version: 1, package: '@botiverse/oar', packageVersion: '0.83.0',
  commit: oarCommit, repository: 'https://github.com/botiverse/oar', release: oarRelease, ...overrides,
});

test('known lodash advisory is retained without severity exemptions and fails the report', t => {
  const options = fixture(t);
  const calls = [];
  const report = audit({ ...options, execute: (_, args) => { calls.push(args); return result([advisory]); } });
  assert.equal(report.status, 'ADVISORIES FOUND');
  assert.equal(report.findings.length, 2);
  assert.deepEqual(report.findings[0].advisory, advisory);
  assert.match(readFileSync(join(options.output, 'summary.md'), 'utf8'), /GHSA-35jh-r3h4-6jhm/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(args => args.includes('--all-vulns') && args.includes('--all-packages')));
  assert.match(calls[0].at(-1), /bun.lock$/);
  assert.match(calls[1].at(-1), /osv-scanner:.*vendor-osv-scanner.json$/);
});

test('exact inventory projects source and third-party authorities without guessed versions', t => {
  const options = fixture(t);
  writeFileSync(join(options.root, 'packages/client/vendor/third-party-manifest.json'), JSON.stringify({ format: 'byok.todo-build-inputs', version: 1, packages: [{ name: 'typebox', version: '1.3.27' }] }));
  const inventory = vendorInventory(options.root);
  assert.deepEqual(inventory.input.results[0].packages.map(p => p.package).sort((a, b) => a.name.localeCompare(b.name)), [
    { name: 'lodash', version: '4.17.20', ecosystem: 'npm' }, { name: 'typebox', version: '1.3.27', ecosystem: 'npm' },
  ]);
  assert.equal(inventory.gaps.length, 0);
});

test('build outputs are not a second vendor inventory authority', t => {
  const options = fixture(t);
  mkdirSync(join(options.root, 'packages/client/dist/assets'), { recursive: true });
  writeFileSync(join(options.root, 'packages/client/dist/assets/source-manifest.json'), '{');
  assert.equal(vendorInventory(options.root).inventory.length, 1);
});

test('commit-only OAR provenance remains a coverage gap after a zero-advisory query', t => {
  const options = fixture(t, { format: 'byok.vendor-source', version: 1, package: '@botiverse/oar', packageVersion: '0.75.0', commit: 'a'.repeat(40), repository: 'https://github.com/botiverse/oar' });
  const report = audit({ ...options, execute: () => result() });
  assert.equal(report.status, 'COVERAGE GAP');
  assert.equal(report.coverageGaps.length, 1);
  const input = JSON.parse(readFileSync(join(options.output, 'vendor-osv-scanner.json')));
  assert.deepEqual(input.results[0].packages[0].package, { name: 'https://github.com/botiverse/oar', commit: 'a'.repeat(40) });
});

test('release evidence makes a commit-pinned vendor query the authoritative npm version', t => {
  const options = fixture(t, oarManifest());
  const report = audit({ ...options, execute: () => result() });
  assert.equal(report.status, 'NO KNOWN ADVISORIES');
  assert.equal(report.coverageGaps.length, 0);
  assert.equal(report.coverage.length, 1);
  assert.deepEqual(report.coverage[0], {
    source: 'packages/client/vendor/example/source-manifest.json',
    name: '@botiverse/oar', version: '0.83.0', ecosystem: 'npm', commit: oarCommit,
    integrity: oarRelease.integrity, provenance: oarRelease.provenance,
  });
  assert.equal(report.inventory[0].commit, oarCommit);
  assert.deepEqual(report.inventory[0].release, {
    ecosystem: 'npm', name: '@botiverse/oar', version: '0.83.0', integrity: oarRelease.integrity,
    commit: oarCommit, provenance: oarRelease.provenance,
  });
  const input = JSON.parse(readFileSync(join(options.output, 'vendor-osv-scanner.json')));
  assert.deepEqual(input.results[0].packages[0].package, { name: '@botiverse/oar', version: '0.83.0', ecosystem: 'npm' });
  assert.match(readFileSync(join(options.output, 'summary.md'), 'utf8'), /AUTHORITATIVE COVERAGE: .*@botiverse\/oar@0\.83\.0 from npm release \(provenance commit ddec7e5/);
});

test('release evidence that disagrees with the vendored identity fails closed', t => {
  const mismatches = [
    { gitCommit: 'b'.repeat(40) },
    { version: '0.80.0' },
    { name: '@botiverse/other' },
    { integrity: 'sha256-abc' },
    { provenance: 'https://example.com/attestation' },
  ];
  for (const mismatch of mismatches) {
    const options = fixture(t, oarManifest({ release: { ...oarRelease, ...mismatch } }));
    const report = audit({ ...options, execute: () => assert.fail('must not scan a contradictory release claim') });
    assert.equal(report.status, 'SCAN ERROR');
    assert.match(report.errors[0], /Release evidence disagrees/);
  }
});

test('the authoritative release query still fails the report when OSV finds an advisory', t => {
  const report = audit({ ...fixture(t, oarManifest()), execute: () => result([advisory]) });
  assert.equal(report.status, 'ADVISORIES FOUND');
  assert.equal(report.coverageGaps.length, 0);
  assert.equal(report.findings.length, 2);
});

test('missing or ranged vendor versions are coverage gaps, never inferred from paths', t => {
  const options = fixture(t, { format: 'byok.vendor-source', version: 1, package: 'lodash', packageVersion: '^4.17.20' });
  const inventory = vendorInventory(options.root);
  assert.equal(inventory.gaps.length, 1);
  assert.deepEqual(inventory.input.results[0].packages, []);
});

for (const [name, run] of [
  ['malformed JSON', { status: 0, stdout: '{', stderr: 'bad response' }],
  ['empty success', { status: 0, stdout: '{"results":[]}', stderr: '' }],
  ['network failure', { status: 127, stdout: '', stderr: 'OSV API unavailable' }],
  ['timeout', { status: null, signal: 'SIGTERM', error: new Error('ETIMEDOUT'), stdout: '', stderr: '' }],
  ['inconsistent success', { ...result([advisory]), status: 0 }],
]) test(`${name} cannot become clean; raw output and report survive`, t => {
  const options = fixture(t);
  const report = audit({ ...options, execute: () => run });
  assert.equal(report.status, 'SCAN ERROR');
  assert.equal(report.errors.length, 2);
  assert.equal(readFileSync(join(options.output, 'lockfile.stderr.log'), 'utf8'), run.stderr);
  assert.equal(JSON.parse(readFileSync(join(options.output, 'report.json'))).status, 'SCAN ERROR');
});

test('unknown manifest schema fails closed and retains a report', t => {
  const options = fixture(t, { format: 'unknown', version: 1 });
  const report = audit({ ...options, execute: () => assert.fail('must not scan invalid authority') });
  assert.equal(report.status, 'SCAN ERROR');
  assert.match(report.errors[0], /Unsupported vendor manifest/);
});

test('valid zero-advisory scan is clean only with complete exact vendor coverage', t => {
  const report = audit({ ...fixture(t), execute: () => result() });
  assert.equal(report.status, 'NO KNOWN ADVISORIES');
  assert.equal(report.errors.length, 0);
});

// Integration proof uses the real pinned scanner and live OSV database when supplied.
// OSV_SCANNER=/absolute/path/to/verified/osv-scanner node --test scripts/ci/security-advisories.test.mjs
// https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm affects lodash <4.17.21.
test('real scanner finds the known vulnerable bun.lock fixture', { skip: !process.env.OSV_SCANNER }, () => {
  const path = new URL('./security-advisories-fixtures/vulnerable-bun.lock', import.meta.url).pathname;
  const run = spawnSync(process.env.OSV_SCANNER, ['scan', 'source', '--format=json', '--all-packages', '--all-vulns', `--lockfile=bun.lock:${path}`], { encoding: 'utf8', timeout: 120_000 });
  assert.equal(run.status, 1, run.stderr);
  assert.ok(parseResult(run).findings.some(finding => finding.advisory.id === advisory.id || finding.advisory.aliases?.includes('CVE-2021-23337')));
});
