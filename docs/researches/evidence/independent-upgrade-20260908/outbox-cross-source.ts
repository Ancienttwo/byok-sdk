// Disposable source probe. Run with Bun; no product/runtime/cloud state is used.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const [oldRoot, newRoot] = process.argv.slice(2);
assert(oldRoot && newRoot, 'usage: bun outbox-cross-source.ts OLD_SOURCE NEW_SOURCE');
const oldModule = await import(pathToFileURL(path.join(oldRoot, 'packages/client/src/daemon/agent-message-outbox.ts')).href);
const newModule = await import(pathToFileURL(path.join(newRoot, 'packages/client/src/daemon/agent-message-outbox.ts')).href);
const agentRef = { agentId: 'upgrade-probe', profileRevision: '1' };
const requirement = { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 100_000 };
const result: Record<string, unknown> = { runtime: process.version, bun: Bun.version, oldRoot, newRoot };
const homes: string[] = [];
async function home() { const p = await mkdtemp(path.join(tmpdir(), 'sdk-upgrade-outbox-')); homes.push(p); return p; }
function draft(taskId: string) { return { taskId, tenantId: 'upgrade-tenant', agentRef, requirement, contentType: 'text/markdown', body: `body-${taskId}`, sessionRef: 'same-session', maxPendingEvents: 8, maxPendingBytes: 200_000 }; }
function ack(record: any) { return { agentRef, sessionRef: record.sessionRef, contract: record.contract, messageId: record.messageId, cursor: record.cursor, contentHash: record.contentHash, outcome: 'accepted', receiptId: '11111111-1111-4111-8111-111111111111' }; }
try {
  const validHome = await home();
  const old = await oldModule.AgentMessageOutbox.open(validHome);
  const record = await old.appendDraft(draft('retained'));
  const upgraded = await newModule.AgentMessageOutbox.open(validHome);
  assert.deepEqual(upgraded.records(), [record]);
  assert.equal(await upgraded.applyDisposition(record.taskId, { ...ack(record), cursor: record.cursor + 1 }), 'mismatch');
  assert.equal(upgraded.records().length, 1);
  assert.equal(await upgraded.applyDisposition(record.taskId, ack(record)), 'accepted');
  assert.deepEqual((await newModule.AgentMessageOutbox.open(validHome)).records(), []);
  result.validOldState = 'PASS: immutable identity/body preserved; wrong ACK retained; exact ACK retired across reopen';
  for (const [label, mod] of [['old', oldModule], ['new', newModule]] as const) {
    const root = await home();
    const box = await mod.AgentMessageOutbox.open(root);
    await box.appendDraft(draft('keep'));
    for (let i = 0; i < 256; i++) { const r = await box.appendDraft(draft(`cycle-${i}`)); await box.applyDisposition(r.taskId, ack(r)); }
    await box.appendDraft(draft('after-compact'));
    const before = await readFile(box.outboxPath);
    let failure: string | undefined;
    try { await mod.AgentMessageOutbox.open(root); } catch (e) { failure = String(e); }
    if (label === 'old') {
      assert(failure, 'old source must reproduce R7');
      await assert.rejects(newModule.AgentMessageOutbox.open(root));
      assert.deepEqual(await readFile(box.outboxPath), before);
      result.oldCompaction = { defectReproduced: true, error: failure, newReaderPreservesCorruptBytes: true };
    } else {
      assert.equal(failure, undefined);
      assert.equal((await mod.AgentMessageOutbox.open(root)).records().length, 2);
      result.newCompaction = 'PASS: retained draft + append survive reopen';
    }
  }
  console.log(JSON.stringify(result, null, 2));
} finally { await Promise.all(homes.map(p => rm(p, { recursive: true, force: true }))); }
