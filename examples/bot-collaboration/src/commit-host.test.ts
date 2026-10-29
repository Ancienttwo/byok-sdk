import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { tenantId } from '@byok-sdk/core';
import { hash, MIN_TOMBSTONE_RETENTION_MS } from '@byok-sdk/server/execution-core';
import { openHost, template, type TestHost } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration, type AgentMessageInput } from './host';
import { botCompactVeto } from './compaction';
import { stateOf } from './model';

let fixture: TestHost | undefined, bot: BotCollaboration | undefined;
afterEach(async () => { await bot?.close(); await fixture?.close(); bot = fixture = undefined; });

/** Real SQLite HostLedger, embedded server, HTTP and daemon. K4 drives the outcome and message callbacks. */
async function open() {
  const received: AgentMessageInput[] = [];
  fixture = await openHost({ externalCore: true, ledgerOptions: { compactVeto: botCompactVeto }, consume: (wake, signal) => bot!.consume(wake, signal),
    agentMessage: { consume: input => { received.push(input); return bot!.consumeMessage(input); } } });
  const base = template(fixture.deviceId);
  bot = new BotCollaboration(fixture.server, fixture.ledger, { botId: 'main', connector: async () => null, execution: { ...base,
    agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'commit' }, payload: { ...base.payload,
      messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 } } } });
  return { fixture, bot, received };
}

it('L: counts each owner command and each first K4 callback once; K4 replays commit nothing', async () => {
  const { fixture, bot, received } = await open();
  const turnId = await bot.input('k1', 'Hello');
  expect(await bot.input('k1', 'Hello')).toBe(turnId);
  expect(bot.snapshot().revision).toBe(1);
  await vi.waitFor(async () => { await bot.drain(); expect(fixture.adapter.sessions.has(bot.core.intent(turnId)!.taskId)).toBe(true); });
  fixture.adapter.sessions.get(bot.core.intent(turnId)!.taskId)!.finish({});
  await vi.waitFor(async () => { await bot.drain(); expect(bot.snapshot().turns[turnId]!.status).toBe('succeeded'); });
  // One message commit and one outcome commit.
  expect(bot.snapshot().revision).toBe(3);
  const sent = received[0]!;
  // K4 answers a retry from its receipt, and refuses another message for the task, before the Host commits.
  expect(await bot.consumeMessage(sent)).toEqual({ outcome: 'accepted' });
  const body = 'Other';
  expect(await bot.consumeMessage({ ...sent, payload: { ...sent.payload, messageId: randomUUID(), body,
    contentHash: `sha256:${createHash('sha256').update(body).digest('hex')}`, byteCount: Buffer.byteLength(body) } }))
    .toEqual({ outcome: 'refused', reasonCode: 'message_conflict' });
  await bot.recover();
  expect(bot.snapshot().revision).toBe(3);
  expect(Object.keys(bot.snapshot().commands ?? {})).toEqual([hash(['input', 'main', 'k1'])]);
});

it('L: replays a refused message from its moved record, and refuses other content for its id as a conflict (#798)', async () => {
  const { fixture, bot } = await open();
  const turnId = await bot.input('k1', 'Hello');
  await vi.waitFor(async () => { await bot.drain(); expect(fixture.adapter.sessions.has(bot.core.intent(turnId)!.taskId)).toBe(true); });
  const intent = bot.core.intent(turnId)!, message = (body: string): AgentMessageInput => ({ tenant: tenantId(fixture.ledger.tenant),
    taskId: intent.taskId, deviceId: fixture.deviceId, context: intent.execution.agentMessageContext!, payload: { agentRef: intent.execution.payload.agentRef,
      sessionRef: randomUUID(), contract: 'conversation-turn/v1', messageId: 'm1', cursor: 1, contentType: 'text/markdown', body,
      contentHash: `sha256:${createHash('sha256').update(body).digest('hex')}`, byteCount: Buffer.byteLength(body) } });
  // K8 refuses a message for a Turn that is not in its state. K4 writes no receipt for a refusal, so K8 keeps a record.
  fixture.ledger.transaction(s => { delete stateOf(s.application).turns[turnId]; });
  expect(await bot.consumeMessage(message('Answer'))).toEqual({ outcome: 'refused', reasonCode: 'binding_mismatch' });
  const record = `${intent.taskId}:m1`;
  expect(bot.snapshot().commands?.[record]).toBeDefined();
  expect(await bot.retain({ acknowledgedRoots: [], now: Date.now(), retentionMs: MIN_TOMBSTONE_RETENTION_MS })).toMatchObject({ archivedCommands: 1 });
  expect(bot.snapshot().commands?.[record]).toBeUndefined();
  const revision = bot.snapshot().revision;
  expect(await bot.consumeMessage(message('Answer'))).toEqual({ outcome: 'refused', reasonCode: 'binding_mismatch' });
  expect(await bot.consumeMessage(message('Other'))).toEqual({ outcome: 'refused', reasonCode: 'message_conflict' });
  expect(bot.snapshot().revision).toBe(revision);
  expect(bot.snapshot().commands?.[record]).toBeUndefined();
});

it('L: counts one commit for each keyless owner call, with no record; a throw and the Host passes commit nothing (#739 6a, 6b)', async () => {
  const { bot } = await open();
  await bot.setMainBot('main', true);
  await bot.setMainBot('main', true);
  expect(bot.snapshot().revision).toBe(2);
  await expect(bot.revokePushRoute('absent')).rejects.toThrow('Push route not found');
  await bot.drain();
  await bot.recover();
  expect(bot.snapshot().revision).toBe(2);
  const turnId = await bot.input('k1', 'Hello');
  await bot.cancelTurn(turnId);
  expect(bot.snapshot().revision).toBe(4);
  await vi.waitFor(async () => { await bot.drain(); expect(bot.snapshot().turns[turnId]!.conclusion).toBe('cancelled'); });
  await bot.recover();
  expect(bot.snapshot().revision).toBe(4);
  expect(Object.keys(bot.snapshot().commands ?? {})).toEqual([hash(['input', 'main', 'k1'])]);
});
