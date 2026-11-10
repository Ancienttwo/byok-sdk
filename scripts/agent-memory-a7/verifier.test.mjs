import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
const repo = path.join(scratch, 'before');
after(() => {
  execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', repo]);
  rmSync(scratch, { recursive: true, force: true });
});
execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', repo, BEFORE], { stdio: 'pipe' });
// Keep the checker and the tracked-file refusal fixture in an owned checkout.
execFileSync('bun', ['ci'], { cwd: repo, stdio: 'pipe' });
execFileSync('bun', ['run', '--filter', '@byok-sdk/keys', '--filter', '@byok-sdk/protocol', '--filter', '@byok-sdk/core', 'build'], { cwd: repo, stdio: 'pipe' });
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
const check = (fixture, checkerRepo = repo) => verify(fixture.rows(), checkerRepo);

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

test('VM configuration requires a reconnect window within the timer range', () => {
  const file = path.join(scratch, 'vm-config.json');
  for (const reconnectTimeoutMs of [undefined, 0, -1, 1.5, 2_147_483_648]) {
    writeFileSync(file, JSON.stringify({ repo, role: 'before', mode: 'owner-vm-power-cut', storageProfile: profile,
      rounds: 1, seed: 5, maxDelayMs: 400, reconnectTimeoutMs }));
    const result = spawnSync('bun', [fileURLToPath(new URL('run.mjs', import.meta.url)), 'run', '--config', file], { encoding: 'utf8', timeout: 10_000 });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires reconnectTimeoutMs in 1\.\.2147483647/);
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

test('refuses incomplete evidence, wrong profile/revision, and an unacknowledged recovery', async (t) => {
  const event = (f, kind) => f.events.find((row) => row.kind === kind);
  const entry = (f, kind) => f.events.find((row) => row.entry?.kind === kind).entry;
  const vm = (f) => Object.assign(f.events[0], { mode: 'owner-vm-power-cut', ownerAuthorization: 'synthetic fixture only' });
  const cases = [
    ['missing metadata', (f) => { f.events[0].schema = 'other'; }, /missing A7 metadata/],
    ['invalid revision metadata', (f) => { f.events[0].before = 'b'.repeat(40); }, /invalid revision or schedule/],
    ['non-pinned checker', (f) => { f.checkerRepo = root; }, /clean pinned before revision/],
    ['dirty pinned checker', (f) => {
      const file = path.join(repo, 'README.md'), original = readFileSync(file);
      f.restore = () => writeFileSync(file, original);
      writeFileSync(file, Buffer.concat([original, Buffer.from('\nmodified checker fixture\n')]));
    }, /clean pinned before revision/],
    ['missing owner authorization', (f) => { f.events[0].mode = 'owner-vm-power-cut'; }, /missing owner VM authorization/],
    ['missing report', (f) => { f.events.pop(); }, 'experiment did not finish'],
    ['missing cleanup', (f) => { f.events.splice(9, 1); }, 'missing final helper cleanup snapshot'],
    ['incomplete schedule', (f) => { f.events[0].triggers.push('delay:10ms'); }, 'incomplete trigger schedule'],
    ['unacknowledged recovery', (f) => { f.events.splice(5, 1); }, 'recovery left an intent unacknowledged'],
    ['ack without stored receipt', (f) => { f.events.splice(4, 1); }, /no earlier stored receipt/],
    ['ack before its receipt', (f) => { const [receipt] = f.events.splice(4, 1); f.events.splice(5, 0, receipt); }, /no earlier stored receipt/],
    ...Object.entries({ intentId: '123e4567-e89b-42d3-a456-426614174001', operationDigest: `sha256:${'c'.repeat(64)}`,
      path: 'notes/b.md', operation: 'delete', agentRef: { ...intent.agentRef, profileRevision: '2' } }).map(([field, value]) =>
      [`receipt completion mismatches ${field}`, (f) => { entry(f, 'receipt').completion[field] = value; }, /completion does not match the issued intent/]),
    ...['revision', 'osBuild'].map((field) => [`guest ${field} mismatch`, (f) => { f.events[1][field] = 'other'; }, /identity\/profile mismatch/]),
    ['duplicate issued intent', (f) => { f.events.splice(4, 0, structuredClone(f.events[3])); }, /duplicate issued intent/],
    ['unissued reference', (f) => { entry(f, 'receipt').intentId = 'unissued'; }, /references an unissued intent/],
    ['failed notice', (f) => { f.events.splice(-1, 0, { kind: 'journal', entry: { kind: 'failed', intentId: intent.intentId, reason: 'notice failed' } }); }, 'notice failed'],
    ['conflicting repeat', (f) => { f.events.splice(-1, 0, { kind: 'journal', entry: { kind: 'repeat', intentId: intent.intentId, disposition: 'conflict' } }); }, 'conflict'],
    ['snapshot order', (f) => { f.events[8].boot = 2; }, /missing or unordered reboot snapshot/],
    ['snapshot without cut', (f) => { f.events.splice(6, 1); }, /snapshot has no matching cut/],
    ...[['platform', 'linux'], ['arch', 'arm64']].map(([field, value]) =>
      [`non-Windows-x64 ${field}`, (f) => { vm(f); f.events[2].snapshot[field] = value; }, /Windows x64 guest/]),
    ['non-fresh store', (f) => { f.events[2].snapshot.homes = f.snapshot.homes; }, /store was not fresh/],
    ['duplicate cleanup', (f) => { f.events.splice(9, 0, structuredClone(f.events[9])); }, /duplicate cleanup snapshot/],
    ['cleanup boot mismatch', (f) => { event(f, 'cleanup').boot = 0; }, /cleanup boot mismatch/],
    ['duplicate report', (f) => { f.events.push(structuredClone(event(f, 'report'))); }, /duplicate experiment report/],
    ...['not CUT', 'CUT'].map((confirmation) => [`invalid or unmatched confirmation ${confirmation}`, (f) =>
      { f.events.splice(6, 0, { kind: 'cut-confirmed', confirmation }); }, /invalid owner cut confirmation/]),
    ['unknown event', (f) => { f.events.splice(-1, 0, { kind: 'unknown' }); }, /unknown evidence event/],
    ['stopped early', (f) => { event(f, 'report').report.stoppedEarly = 'recovery failed'; }, 'experiment reported a failure'],
    ['reported violations', (f) => { event(f, 'report').report.violations = 1; }, 'experiment reported a failure'],
    ['missing owner cut requests', vm, 'owner cut requests/confirmations do not match'],
    ['identity without snapshot', (f) => { f.events.splice(-1, 0, { ...f.events[7], boot: 2 }); }, 'guest identity has no snapshot'],
    ['missing cut report', (f) => { event(f, 'report').report.cuts = []; }, 'incomplete trigger schedule'],
    ['cut trigger mismatch', (f) => { entry(f, 'cut').trigger = 'host:fetch@1'; }, 'cut schedule mismatch'],
    ['cut round mismatch', (f) => { entry(f, 'cut').round = 1; }, 'cut schedule mismatch'],
    ['lost cleanup home', (f) => { event(f, 'cleanup').snapshot.homes = []; }, 'cleanup lost an issued Agent home'],
  ];
  for (const [name, mutate, expected] of cases) await t.test(name, () => {
    const f = fixture();
    try {
      mutate(f);
      if (expected instanceof RegExp) assert.throws(() => check(f, f.checkerRepo), expected);
      else {
        const result = check(f);
        assert.equal(result.status, 'failed');
        assert.ok(JSON.stringify(result.failures).includes(expected), JSON.stringify(result.failures));
      }
    } finally { f.restore?.(); }
  });
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
