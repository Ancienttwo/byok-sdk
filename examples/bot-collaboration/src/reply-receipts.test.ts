import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostExecutionCore, HostLedger, MIN_TOMBSTONE_RETENTION_MS, enqueue, type AgentMessageInput, type ExecutionServer } from '@byok-sdk/server/execution-core';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import { stateOf } from './model';
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
it('retains business receipts after proven compaction and refuses retired task replay', async () => {
  const f = fixture();
  f.ledger.transaction(s => { const intent = s.intents[f.intent.id]!; intent.phase = 'settled'; intent.conclusion = 'succeeded'; delete s.outbox[`intent:${intent.id}`]; });
  f.ledger.compact({ acknowledgedIntentKeys: ['turn'], now: 10, tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS });
  const reopened = new HostLedger(f.file, f.ledger.tenant); ledgers.push(reopened);
  expect(stateOf(reopened.snapshot().application).replies[f.intent.taskId]).toBeDefined();
  const core = new HostExecutionCore({} as ExecutionServer, reopened);
  expect(await core.consumeMessage(f.input)).toMatchObject({ reasonCode: 'unknown_task' });
});
