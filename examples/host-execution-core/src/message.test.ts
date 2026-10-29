import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  HostExecutionCore,
  HostLedger,
  enqueue,
  type AgentMessageInput,
  type ExecutionServer,
  type HostOptions,
  type MessageTransaction,
} from '@byok-sdk/server/execution-core';
import { template } from './test-support';
const ledgers: HostLedger[] = [];
afterEach(() => { ledgers.splice(0).forEach(l => l.close()); });
function fixture(options: HostOptions = {}, filename = ':memory:') {
  const ledger = new HostLedger(filename, 'product:test'); ledgers.push(ledger);
  const execution = { ...template('device'), agentMessageContext: { destinationBinding: 'one' } };
  const intent = ledger.transaction(s => enqueue(s, ledger.tenant, { key: 'chat', source: 'bot', execution, waitUntil: Date.now() + 60_000 }));
  const input = { tenant: ledger.tenant, taskId: intent.taskId, deviceId: 'device', context: execution.agentMessageContext,
    payload: { agentRef: execution.payload.agentRef, messageId: 'one', contentHash: 'sha256:reply', body: 'Reply', contentType: 'text/markdown', byteCount: 5 } } as unknown as AgentMessageInput;
  return { core: new HostExecutionCore({} as ExecutionServer, ledger, options), ledger, input, intent };
}
it('commits acceptance and projection once, including replay after projection delivery', async () => {
  const applyMessage: NonNullable<HostOptions['applyMessage']> = vi.fn((input, tx) => { tx.application.count = Number(tx.application.count ?? 0) + 1; tx.publish(`reply:${input.taskId}`, input.payload.body); return { outcome: 'accepted' as const }; });
  const f = fixture({ applyMessage });
  expect(await f.core.consumeMessage(f.input)).toEqual({ outcome: 'accepted' });
  const recovered = new HostExecutionCore({} as ExecutionServer, f.ledger, { applyMessage });
  expect(await recovered.consumeMessage(f.input)).toEqual({ outcome: 'accepted' });
  const sent: string[] = [];
  await recovered.flushProjections(async id => { sent.push(id); });
  expect(await recovered.consumeMessage(f.input)).toEqual({ outcome: 'accepted' });
  await recovered.flushProjections(async id => { sent.push(id); });
  expect(sent).toEqual([`reply:${f.input.taskId}`]); expect(applyMessage).toHaveBeenCalledTimes(1);
  expect(f.ledger.snapshot().application.count).toBe(1);
});
it.each(['tenant', 'device', 'agent', 'context'])('refuses mismatched %s even on accepted replay', async field => {
  const f = fixture({ applyMessage: () => ({ outcome: 'accepted' }) }); await f.core.consumeMessage(f.input);
  const wrong = structuredClone(f.input) as { -readonly [K in keyof AgentMessageInput]: AgentMessageInput[K] };
  if (field === 'tenant') wrong.tenant = 'other' as AgentMessageInput['tenant'];
  if (field === 'device') wrong.deviceId = 'other';
  if (field === 'agent') wrong.payload.agentRef.agentId = 'other';
  if (field === 'context') wrong.context = { destinationBinding: 'other' };
  expect(await f.core.consumeMessage(wrong)).toEqual({ outcome: 'refused', reasonCode: 'binding_mismatch' });
});
it('refuses unknown/new stale messages but retains exact accepted old-generation replay', async () => {
  const applyMessage = vi.fn(() => ({ outcome: 'accepted' as const })); const f = fixture({ applyMessage });
  expect(await f.core.consumeMessage({ ...f.input, taskId: 'unknown' })).toMatchObject({ reasonCode: 'unknown_task' });
  f.ledger.transaction(s => { s.intents[f.intent.id]!.taskId = 'next'; });
  expect(await f.core.consumeMessage(f.input)).toMatchObject({ reasonCode: 'stale_generation' });
  f.ledger.transaction(s => { s.intents[f.intent.id]!.taskId = f.input.taskId; }); await f.core.consumeMessage(f.input);
  f.ledger.transaction(s => { s.intents[f.intent.id]!.taskId = 'next'; });
  expect(await f.core.consumeMessage(f.input)).toEqual({ outcome: 'accepted' });
  expect(await f.core.consumeMessage({ ...f.input, payload: { ...f.input.payload, contentHash: 'different' } })).toMatchObject({ reasonCode: 'message_conflict' });
  expect(applyMessage).toHaveBeenCalledTimes(1);
});
it('rolls back business writes and projections on exception or asynchronous hook', async () => {
  for (const asynchronous of ['sync', 'resolved', 'rejected']) {
    const f = fixture({ applyMessage: ((_input: AgentMessageInput, tx: MessageTransaction) => { tx.publish('reply', 'body'); tx.application.changed = true;
      if (asynchronous === 'resolved') return Promise.resolve({ outcome: 'accepted' });
      if (asynchronous === 'rejected') return Promise.reject(new Error('async failed'));
      throw new Error('failed');
    }) as unknown as HostOptions['applyMessage'] });
    await expect(f.core.consumeMessage(f.input)).rejects.toThrow();
    expect(f.ledger.snapshot().application).toEqual({});
    expect(f.ledger.snapshot().executions[f.input.taskId]!.messageReceipt).toBeUndefined();
    expect(Object.values(f.ledger.snapshot().outbox).filter(r => r.kind === 'projection')).toEqual([]);
  }
});
it('gives the hook the application rows of its commit, rolls them back with it, and closes the port after it', async () => {
  const f = fixture();
  f.ledger.transaction((_s, rows) => rows.put('records', 'old', 1));
  let kept: MessageTransaction['rows'] | undefined;
  const failing = new HostExecutionCore({} as ExecutionServer, f.ledger, { applyMessage: (_input, tx) => { tx.rows.put('records', 'lost', 1); throw new Error('failed'); } });
  await expect(failing.consumeMessage(f.input)).rejects.toThrow('failed');
  const core = new HostExecutionCore({} as ExecutionServer, f.ledger, { applyMessage: (_input, tx) => {
    kept = tx.rows; tx.rows.put('records', 'new', tx.rows.get('records', 'old') as number + 1); return { outcome: 'refused', reasonCode: 'test' };
  } });
  expect(await core.consumeMessage(f.input)).toEqual({ outcome: 'refused', reasonCode: 'test' });
  expect(f.ledger.transaction((_s, rows) => ['old', 'new', 'lost'].map(id => rows.get('records', id)))).toEqual([1, 2, undefined]);
  expect(() => kept!.get('records', 'old')).toThrow('The application row port is closed');
});
it('revokes publish authority after callback and refuses an unconfigured handler', async () => {
  const f = fixture(); expect(await f.core.consumeMessage(f.input)).toMatchObject({ reasonCode: 'message_handler_unconfigured' });
  let publish!: (id: string, value: string) => void;
  const core = new HostExecutionCore({} as ExecutionServer, f.ledger, { applyMessage: (_input, tx) => { publish = tx.publish; return { outcome: 'accepted' }; } });
  await core.consumeMessage(f.input); expect(() => publish('late', 'body')).toThrow('closed');
});

it('reopens a committed receipt before SDK disposition and never republishes an acknowledged projection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'k4-reply-'));
  const filename = join(root, 'ledger.sqlite');
  const applyMessage = vi.fn<NonNullable<HostOptions['applyMessage']>>((input, tx) => {
    tx.publish(`reply:${input.taskId}`, input.payload.body); return { outcome: 'accepted' };
  });
  const f = fixture({ applyMessage }, filename);
  await f.core.consumeMessage(f.input); // commit succeeded; caller never records its SDK disposition
  await f.core.close(); f.ledger.close(); ledgers.splice(ledgers.indexOf(f.ledger), 1);
  const reopened = new HostLedger(filename, f.ledger.tenant);
  try {
    const core = new HostExecutionCore({} as ExecutionServer, reopened, { applyMessage });
    expect(await core.consumeMessage(f.input)).toEqual({ outcome: 'accepted' });
    const delivered: string[] = [];
    await core.flushProjections(async id => { delivered.push(id); });
    expect(await core.consumeMessage(f.input)).toEqual({ outcome: 'accepted' });
    await core.flushProjections(async id => { delivered.push(id); });
    expect(delivered).toEqual([`reply:${f.input.taskId}`]); expect(applyMessage).toHaveBeenCalledTimes(1);
    await core.close();
  } finally { reopened.close(); rmSync(root, { recursive: true, force: true }); }
});
