import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostExecutionCore, HostLedger, MIN_TOMBSTONE_RETENTION_MS, enqueue, hash, taskId, type AgentMessageInput, type ExecutionServer } from '@byok-sdk/example-host-execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { stateOf } from './model';
import { promoteReplyReceipts } from './reply-receipts';
const roots: string[] = [], ledgers: HostLedger[] = [];
afterEach(() => { ledgers.splice(0).forEach(l => l.close()); roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'k8-receipts-')); roots.push(root);
  const file = join(root, 'ledger.sqlite');
  const ledger = new HostLedger(file, 'product:test'); ledgers.push(ledger);
  const base = template('device');
  const execution = { ...base, agentMessageContext: { destinationBinding: 'owner' }, payload: { ...base.payload,
    messageEgress: { mode: 'required' as const, contract: 'chat', contentType: 'text/plain' as const, maxBytes: 100 } } };
  const intent = ledger.transaction(s => {
    const intent = enqueue(s, ledger.tenant, { key: 'turn', source: 'user', execution, waitUntil: 5000 });
    const state = stateOf(s.application);
    state.turns.turn = { id: 'turn', root: 'turn', botId: 'main', source: 'user', request: 'Hi', hop: 0, status: 'processing' };
    state.replies[intent.taskId] = { turnId: 'turn', messageId: 'one', contentHash: 'hash', contentType: 'text/plain', acceptedAt: 1 };
    return intent;
  });
  const input = { tenant: ledger.tenant, taskId: intent.taskId, deviceId: 'device', context: execution.agentMessageContext,
    payload: { agentRef: base.payload.agentRef, messageId: 'one', contentHash: 'hash' } } as unknown as AgentMessageInput;
  return { ledger, file, intent, input };
}
it('promotes durable legacy acceptance after generation change and reopens without new projection', async () => {
  const f = fixture();
  f.ledger.transaction(s => { s.intents[f.intent.id]!.generation = 1; s.intents[f.intent.id]!.taskId = taskId('turn', 1); });
  const reopened = new HostLedger(f.file, f.ledger.tenant); ledgers.push(reopened);
  for (let n = 0; n < 2; n++) reopened.transaction(s => promoteReplyReceipts(reopened, s, stateOf(s.application), 10));
  const hook = vi.fn(() => ({ outcome: 'accepted' as const }));
  const core = new HostExecutionCore({} as ExecutionServer, reopened, { applyMessage: hook });
  expect(await core.consumeMessage(f.input)).toEqual({ outcome: 'accepted' });
  expect(await core.consumeMessage({ ...f.input, deviceId: 'wrong' })).toMatchObject({ reasonCode: 'binding_mismatch' });
  expect(hook).not.toHaveBeenCalled();
  expect(Object.values(reopened.snapshot().outbox).filter(r => r.kind === 'projection')).toEqual([]);
});
it('retains business receipts after proven compaction and refuses retired task replay', async () => {
  const f = fixture();
  f.ledger.transaction(s => { const intent = s.intents[f.intent.id]!; intent.phase = 'settled'; intent.conclusion = 'succeeded'; delete s.outbox[`intent:${intent.id}`]; });
  f.ledger.compact({ acknowledgedIntentKeys: ['turn'], now: 10, tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS });
  const reopened = new HostLedger(f.file, f.ledger.tenant); ledgers.push(reopened);
  reopened.transaction(s => promoteReplyReceipts(reopened, s, stateOf(s.application), 20));
  expect(stateOf(reopened.snapshot().application).replies[f.intent.taskId]).toBeDefined();
  const core = new HostExecutionCore({} as ExecutionServer, reopened);
  expect(await core.consumeMessage(f.input)).toMatchObject({ reasonCode: 'unknown_task' });
});
it('keeps the receipt of a compacted routine Turn after its tombstone expired, and refuses one whose occurrence is still open', () => {
  const f = fixture(), id = `occurrence:${'a'.repeat(64)}`, receipt = taskId(id, 0);
  // The state after K4 compacted the routine intent with its occurrence, and the slot tombstone expired.
  f.ledger.transaction(s => {
    const state = stateOf(s.application);
    state.turns[id] = { id, root: id, botId: 'main', source: 'routine', request: 'Report', hop: 0, status: 'succeeded', conclusion: 'succeeded', reported: true };
    state.replies[receipt] = { turnId: id, messageId: 'two', contentHash: 'hash', contentType: 'text/plain', acceptedAt: 1 };
  });
  f.ledger.transaction(s => promoteReplyReceipts(f.ledger, s, stateOf(s.application), 10));
  expect(stateOf(f.ledger.snapshot().application).replies[receipt]).toBeDefined();
  f.ledger.transaction(s => { s.occurrences['a'.repeat(64)] = {} as never; });
  expect(() => f.ledger.transaction(s => promoteReplyReceipts(f.ledger, s, stateOf(s.application), 10))).toThrow('Orphaned legacy reply receipt');
});
it.each(['orphan', 'conflict', 'task', 'context'])('fails closed on invalid legacy %s without altering receipts', kind => {
  const f = fixture();
  f.ledger.transaction(s => {
    if (kind === 'orphan') { delete s.executions[f.intent.taskId]; delete s.intents[hash('turn')]; }
    if (kind === 'conflict') s.executions[f.intent.taskId]!.messageReceipt = { messageId: 'other', contentHash: 'hash' };
    if (kind === 'task') s.executions[f.intent.taskId]!.input.taskId = 'wrong';
    if (kind === 'context') s.executions[f.intent.taskId]!.input.agentMessageContext = undefined;
  });
  const before = f.ledger.snapshot();
  expect(() => f.ledger.transaction(s => promoteReplyReceipts(f.ledger, s, stateOf(s.application), 10))).toThrow();
  expect(f.ledger.snapshot()).toEqual(before);
});
