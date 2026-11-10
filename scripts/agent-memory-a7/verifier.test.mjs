import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { BEFORE, SCHEMA, Recorder, readEvidence, validateProfile } from './evidence.mjs';
import { bridge, compare, verify } from './verify.mjs';
import { observe } from './run.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = mkdtempSync(path.join(os.tmpdir(), 'byok-a7-verifier-'));
let repo = root;
after(() => {
  if (repo !== root) execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', repo]);
  rmSync(scratch, { recursive: true, force: true });
});
if (execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== BEFORE) {
  repo = path.join(scratch, 'before');
  execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', repo, BEFORE], { stdio: 'pipe' });
  // Bun's isolated workspace links live in each package, so a root
  // node_modules link alone cannot load the pinned parser's dependencies.
  execFileSync('bun', ['ci'], { cwd: repo, stdio: 'pipe' });
  execFileSync('bun', ['run', '--filter', '@byok-sdk/keys', '--filter', '@byok-sdk/protocol', '--filter', '@byok-sdk/core', 'build'], { cwd: repo, stdio: 'pipe' });
}
const EMPTY = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const BASE = `sha256:${'b'.repeat(64)}`;
const STAMP = '2026-11-10T00:00:00.000Z';
const profile = { id: 'test', osBuild: '10.0.26100', disk: 'disposable disk', virtualController: 'test controller', cacheMode: 'writeback', filesystem: 'NTFS', hypervisor: 'test', hostStorage: 'test disk', cutMechanism: 'process tree kill', dropsUnflushedWrites: false };
const intent = { seq: 0, intentId: '123e4567-e89b-42d3-a456-426614174000', agentRef: { agentId: 'w5-agent-0', profileRevision: '1' }, path: 'notes/a.md', operation: 'replace', baseRevision: EMPTY, targetRevision: EMPTY, operationDigest: `sha256:${'a'.repeat(64)}` };
function fixture(operation = 'replace') {
  const issued = { ...intent, operation, baseRevision: BASE, targetRevision: operation === 'delete' ? null : EMPTY };
  const result = { exists: operation === 'replace', revision: EMPTY };
  const record = { intentId: issued.intentId, profileRevision: '1', path: issued.path, operation,
    operationDigest: issued.operationDigest, baseRevision: BASE, targetRevision: issued.targetRevision, approvalRef: 'approval:w5-0',
    state: 'applied', detail: result, createdAt: STAMP, updatedAt: STAMP, ackedAt: STAMP };
  const completion = { intentId: issued.intentId, agentRef: issued.agentRef, path: issued.path, operation, operationDigest: issued.operationDigest, outcome: 'applied', result };
  const snapshot = { platform: 'win32', arch: 'x64', runtime: 'test', homes: [{ agentId: issued.agentRef.agentId, notesDirectory: true, internalDirectory: true,
    ledgerBase64: Buffer.from(bridge(repo, 'serialize', { records: [record] })).toString('base64'),
    files: { 'notes/a.md': { ...result, size: 0 } }, leftovers: [], leaseMarker: 'absent' }] };
  const identity = (boot) => ({ kind: 'identity', boot, revision: BEFORE, helperManifestDigest: 'manifest', osBuild: profile.osBuild });
  const events = [
    { kind: 'metadata', schema: SCHEMA, before: BEFORE, role: 'before', revision: BEFORE, helperManifestDigest: 'manifest', mode: 'process-kill', storageProfile: profile, seed: 5, triggers: ['host:acked@1'] },
    identity(0), { kind: 'snapshot', boot: 0, snapshot: { ...snapshot, homes: [] } },
    { kind: 'journal', entry: { kind: 'issued', intent: issued } },
    { kind: 'journal', entry: { kind: 'receipt', intentId: issued.intentId, completion } },
    { kind: 'journal', entry: { kind: 'acked', intentId: issued.intentId } },
    { kind: 'journal', entry: { kind: 'cut', round: 0, trigger: 'host:acked@1' } },
    identity(1), { kind: 'snapshot', boot: 1, snapshot },
    { kind: 'cleanup', boot: 1, snapshot: structuredClone(snapshot) },
    { kind: 'report', report: { cuts: [{}], violations: 0 } },
  ];
  return { events, record, snapshot, rows: () => events.map((event) => ({ event, digest: 'test' })) };
}
const serialize = (record) => Buffer.from(bridge(repo, 'serialize', { records: [record] })).toString('base64');
const check = (fixture) => verify(fixture.rows(), repo);

test('independent recorder preserves timestamps, receipt digests, and rejects edits/truncation', () => {
  const file = path.join(scratch, 'evidence.jsonl');
  const recorder = new Recorder(file);
  recorder.append({ kind: 'receipt', completion: { operationDigest: intent.operationDigest } });
  recorder.append({ kind: 'acked', intentId: intent.intentId });
  recorder.close();
  const rows = readEvidence(file);
  assert.equal(rows.length, 2);
  assert.ok(Date.parse(rows[0].at));
  assert.throws(() => new Recorder(file), /EEXIST/);
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, original.replace('receipt', 'changed'));
  assert.throws(() => readEvidence(file), /invalid Host evidence/);
  writeFileSync(file, original.slice(0, -1));
  assert.throws(() => readEvidence(file), /truncated/);
});

test('records complete messages and discards a partial message only at an intentional cut', async () => {
  for (const intentional of [true, false]) {
    const input = new PassThrough();
    const rows = [];
    const raw = { start: async () => ({ link: { input, output: new PassThrough() } }), cut: async () => input.destroy() };
    const driver = observe(raw, { append: (row) => rows.push(row) }, { revision: BEFORE, helperManifestDigest: 'manifest', storageProfile: profile });
    let failure;
    driver.failure.catch((error) => { failure = error; });
    const run = await driver.start();
    const forwarded = [];
    const ended = (async () => { for await (const chunk of run.link.input) forwarded.push(chunk.toString()); })();
    input.write(`W5 ${JSON.stringify({ type: 'a7-identity', revision: BEFORE, helperManifestDigest: 'manifest', osBuild: profile.osBuild })}\nW5 {"partial":`);
    if (intentional) await driver.cut();
    else input.end();
    await ended;
    assert.equal(rows.length, 1);
    assert.ok(!forwarded.join('').includes('partial'));
    if (intentional) assert.equal(failure, undefined);
    else assert.match(failure.message, /truncated device message outside an intentional cut/);
  }
});

test('all storage profile fields are required', () => {
  assert.equal(validateProfile(profile), profile);
  for (const field of Object.keys(profile)) {
    const value = { ...profile };
    delete value[field];
    assert.throws(() => validateProfile(value), new RegExp(field));
  }
});

test('verifies durable empty replace and durable delete with the real strict checker', () => {
  for (const operation of ['replace', 'delete']) {
    const result = check(fixture(operation));
    assert.equal(result.status, 'passed', JSON.stringify(result.failures));
    assert.equal(result.evidence, 'harness-validation-not-A7');
  }
});

test('detects I1 through I4, including both #996 existence regressions', async (t) => {
  const cases = [
    ['I1 corrupt ledger', 'I1', (f) => { f.snapshot.homes[0].ledgerBase64 = Buffer.from('{bad').toString('base64'); }],
    ['I2 missing durable terminal', 'I2', (f) => { f.snapshot.homes[0].ledgerBase64 = null; }],
    ['I3 missing durable ackedAt', 'I3', (f) => { f.record.ackedAt = null; f.snapshot.homes[0].ledgerBase64 = serialize(f.record); }],
    ['I4 empty replace observed missing', 'I4', (f) => { f.snapshot.homes[0].files['notes/a.md'].exists = false; }],
    ['I4 delete observed empty', 'I4', (f) => { f.snapshot.homes[0].files['notes/a.md'].exists = true; }, 'delete'],
  ];
  for (const [name, invariant, mutate, operation] of cases) await t.test(name, () => {
    const f = fixture(operation);
    mutate(f);
    const result = check(f);
    assert.equal(result.status, 'failed');
    assert.ok(result.failures.some((failure) => failure.id === invariant), JSON.stringify(result.failures));
  });
});

test('allows raw interrupted-write temporaries but requires final helper cleanup', () => {
  const f = fixture();
  f.snapshot.homes[0].leftovers.push('.byok-agent-memory-replace-interrupted');
  assert.equal(check(f).status, 'passed');
  f.events.find((event) => event.kind === 'cleanup').snapshot.homes[0].leftovers.push('.byok-agent-memory-replace-leaked');
  assert.equal(check(f).status, 'failed');
});

test('refuses incomplete evidence, wrong profile/revision, and an unacknowledged recovery', () => {
  for (const mutate of [
    (f) => f.events.pop(),
    (f) => f.events.splice(f.events.findIndex((event) => event.kind === 'cleanup'), 1),
    (f) => { f.events[0].triggers.push('delay:10ms'); },
    (f) => f.events.splice(f.events.findIndex((event) => event.entry?.kind === 'acked'), 1),
  ]) {
    const f = fixture(); mutate(f);
    assert.equal(check(f).status, 'failed');
  }
  for (const field of ['revision', 'osBuild']) {
    const f = fixture();
    f.events[1][field] = 'other';
    assert.throws(() => check(f), /identity\/profile mismatch/);
  }
});

test('VM-mode evidence requires an explicit completed-cut confirmation', () => {
  const f = fixture();
  f.events[0].mode = 'owner-vm-power-cut';
  f.events[0].ownerAuthorization = 'synthetic verifier fixture; no VM operation';
  const index = f.events.findIndex((event) => event.entry?.kind === 'cut');
  f.events.splice(index, 0, { kind: 'cut-request' }, { kind: 'cut-confirmed', confirmation: 'CUT' });
  assert.equal(check(f).status, 'passed');
  f.events.splice(index + 1, 1);
  assert.equal(check(f).status, 'failed');
});

test('pairs only the same profile and workload, retaining a failing before result', () => {
  const before = check(fixture());
  const afterResult = { ...before, role: 'after', revision: 'b'.repeat(40) };
  assert.equal(compare(before, afterResult).status, 'passed');
  assert.equal(compare(before, { ...afterResult, storageProfile: Object.fromEntries(Object.entries(profile).reverse()) }).status, 'passed');
  assert.throws(() => compare(before, { ...afterResult, revision: BEFORE }), /distinct after/);
  assert.equal(compare({ ...before, status: 'failed' }, afterResult).status, 'failed');
  for (const field of ['storageProfile', 'seed', 'triggers', 'mode']) {
    assert.throws(() => compare(before, { ...afterResult, [field]: 'different' }), /differs/);
  }
});
