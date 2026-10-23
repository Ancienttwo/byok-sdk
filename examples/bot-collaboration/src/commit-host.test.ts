import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { hash } from '@byok-sdk/example-host-execution-core';
import { openHost, template, type TestHost } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration, type AgentMessageInput } from './host';

let fixture: TestHost | undefined, bot: BotCollaboration | undefined;
afterEach(async () => { await bot?.close(); await fixture?.close(); bot = fixture = undefined; });

/** Real SQLite HostLedger, embedded server, HTTP and daemon. K4 drives the outcome and message callbacks. */
async function open() {
  const received: AgentMessageInput[] = [];
  fixture = await openHost({ externalCore: true, consume: (wake, signal) => bot!.consume(wake, signal),
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
