import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { agentMemoryIntentOperationDigest } from '@byok-sdk/core';
import { AgentHomeManager } from '../src/agent-home.ts';
import { createAgentMemoryIntentProcessor, helperAgentMemoryIntentBackend } from '../src/daemon/agent-memory-intent.ts';

// The intent processor over the real SDK helper under Bun (#605 W4): replace,
// a redelivered notice, a lost complete response and delete. The processor is
// not a public export, so Bun runs it from source. Node runs the same flow in
// agent-memory-intent.test.ts. Windows claims B here as a test seam only: the
// Windows helper has no OS-crash or power-loss proof, so production never runs
// intents there.
assert.ok(process.versions.bun, 'run this smoke with bun');
assert.ok(process.platform === 'darwin' || (process.platform === 'win32' && process.arch === 'x64'));
const TENANT = 'tenant-w4';
const DEVICE = 'device-w4';
const agentRef = { agentId: 'agent-w4', profileRevision: '1' };
const sha = (content) => `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;

class Host {
  intents = new Map();
  completes = [];
  loseNextCompleteResponse = false;

  async fetch(request) {
    const entry = this.intents.get(request.intentId);
    assert.ok(entry !== undefined && entry.stored === undefined, `unexpected fetch for ${request.intentId}`);
    assert.equal(request.reservation, 'held');
    return { disposition: 'release', intent: entry.intent };
  }

  async complete(completion) {
    this.completes.push(completion);
    const entry = this.intents.get(completion.intentId);
    assert.ok(entry !== undefined);
    const disposition = entry.stored === undefined ? 'recorded' : 'idempotent';
    if (entry.stored === undefined) entry.stored = completion;
    else assert.deepEqual(completion, entry.stored);
    if (this.loseNextCompleteResponse) {
      this.loseNextCompleteResponse = false;
      throw new Error('response lost');
    }
    return { tenantId: TENANT, deviceId: DEVICE, intentId: completion.intentId, disposition, completion: entry.stored, recordedAt: '2026-10-23T00:00:00.000Z' };
  }
}

async function intent(host, operation, relative, baseRevision, content) {
  const intentId = randomUUID();
  const targetRevision = operation === 'replace' ? sha(content) : null;
  const approvalRef = `approval:${intentId.slice(0, 8)}`;
  const operationDigest = await agentMemoryIntentOperationDigest({
    tenantId: TENANT, deviceId: DEVICE, intentId, agentRef, path: relative, operation, baseRevision, targetRevision, approvalRef,
  });
  const value = { intentId, agentRef, path: relative, operation, baseRevision, targetRevision, ...(operation === 'replace' ? { content } : {}), approvalRef, operationDigest };
  host.intents.set(intentId, { intent: value });
  return value;
}

const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'byok-intent-helper-')));
try {
  const file = process.platform === 'win32' ? 'win32-x64.exe' : `darwin-${process.arch}`;
  const helperBin = fileURLToPath(new URL(`../dist/native/agent-memory-fs/${file}`, import.meta.url));
  const helper = helperAgentMemoryIntentBackend(helperBin);
  assert.equal(helper.strictLedgerBarrier, process.platform !== 'win32');
  const backend = process.platform === 'win32' ? { ...helper, strictLedgerBarrier: true } : helper;
  const homes = new AgentHomeManager({ hostStorageRoot: root });
  const host = new Host();
  const processor = () => createAgentMemoryIntentProcessor({ tenantId: TENANT, deviceId: DEVICE, transport: host, homes, backend });
  const notice = (value) => ({ intentId: value.intentId, agentRef });
  const note = (relative) => path.join(root, 'agents', agentRef.agentId, ...relative.split('/'));

  const replace = await intent(host, 'replace', 'notes/a.md', sha(''), 'alpha');
  const applied = await processor()(notice(replace));
  assert.equal(applied.kind, 'acknowledged');
  assert.equal(applied.completion.outcome, 'applied');
  assert.equal(readFileSync(note('notes/a.md'), 'utf8'), 'alpha');
  const index = statSync(note('notes/a.md'), { bigint: true }).ino;
  const replayed = await processor()(notice(replace));
  assert.equal(replayed.kind, 'acknowledged');
  assert.equal(replayed.readback.disposition, 'idempotent');
  assert.equal(statSync(note('notes/a.md'), { bigint: true }).ino, index);

  const lost = await intent(host, 'replace', 'notes/b.md', sha(''), 'beta');
  host.loseNextCompleteResponse = true;
  await assert.rejects(processor()(notice(lost)), (error) => error.reason === 'complete_failed');
  const lostIndex = statSync(note('notes/b.md'), { bigint: true }).ino;
  const settled = await processor()(notice(lost));
  assert.equal(settled.kind, 'acknowledged');
  assert.equal(settled.completion.outcome, 'applied');
  assert.equal(statSync(note('notes/b.md'), { bigint: true }).ino, lostIndex);

  const remove = await intent(host, 'delete', 'notes/a.md', replace.targetRevision);
  const removed = await processor()(notice(remove));
  assert.equal(removed.kind, 'acknowledged');
  assert.equal(removed.completion.outcome, 'applied');
  assert.throws(() => statSync(note('notes/a.md')), { code: 'ENOENT' });

  const ledger = JSON.parse(readFileSync(path.join(root, 'agents', agentRef.agentId, '.byok', 'agent-memory-intents-v1.json'), 'utf8'));
  assert.deepEqual(ledger.records.map((record) => [record.intentId, record.state, record.ackedAt !== null]), [
    [replace.intentId, 'applied', true], [lost.intentId, 'applied', true], [remove.intentId, 'applied', true],
  ]);
  assert.deepEqual(host.completes.map((completion) => completion.outcome), ['applied', 'applied', 'applied', 'applied', 'applied']);
  console.log(JSON.stringify({ runtime: 'bun', platform: process.platform, arch: process.arch, claimedB: backend !== helper, intents: ledger.records.length }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
