import { afterEach, expect, it, vi } from 'vitest';
import { hash } from '@byok-sdk/server/execution-core';
import { openHost, template, type TestHost } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration, type BotOptions } from './host';
import { inboundKey, type InboundMessage, type Principal } from './channel';
import { botCompactVeto } from './compaction';

let fixture: TestHost;
let bot: BotCollaboration;
afterEach(async () => { await bot?.close(); await fixture?.close(); });
/** Real embedded server, HTTP, daemon and submit_result helper. */
async function setup(rest: Partial<BotOptions> = {}): Promise<BotOptions> {
  fixture = await openHost({ externalCore: true, ledgerOptions: { compactVeto: botCompactVeto }, consume: (wake, signal) => bot.consume(wake, signal), agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
  const base = template(fixture.deviceId);
  const options: BotOptions = { botId: 'main', execution: { ...base,
    agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'channel' }, payload: { ...base.payload,
      messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 } } },
    connector: async id => ({ ok: true, externalId: id }), ...rest };
  bot = new BotCollaboration(fixture.server, fixture.ledger, options);
  return options;
}
const owner: Principal = { id: 'owner', kind: 'human' };
const member: Principal = { id: 'im:member', kind: 'human' };
const direct = (platformMessageId: string, sender: Principal | undefined, text = 'Hello'): InboundMessage =>
  ({ channel: 'fake', platformMessageId, conversation: { kind: 'direct', id: 'main' }, sender, text, mentions: [] });
async function running(id: string) {
  await vi.waitFor(async () => { await bot.drain(); expect(fixture.adapter.sessions.has(bot.core.intent(id)?.taskId ?? '')).toBe(true); }, { timeout: 5000 });
  return fixture.adapter.sessions.get(bot.core.intent(id)!.taskId)!;
}
async function finish(id: string, document: unknown = {}) {
  (await running(id)).finish(document);
  await vi.waitFor(async () => { await bot.drain(); expect(bot.snapshot().turns[id]?.status).toBe('succeeded'); }, { timeout: 5000 });
}

it('runs an owner 1:1 message once, and a redelivered event maps to the same Turn', async () => {
  await setup();
  const inbound = direct('m1', owner, 'Draft a reply');
  const id = hash(['user', 'main', inboundKey(inbound)]);
  expect(await bot.receive(inbound)).toEqual({ kind: 'owner_input', id });
  expect(bot.snapshot().turns[id]).toMatchObject({ source: 'user', authority: 'owner', request: 'Draft a reply' });
  expect(await bot.receive(inbound)).toEqual({ kind: 'owner_input', id });
  await finish(id);
  expect(Object.keys(bot.snapshot().turns)).toEqual([id]);
  expect(fixture.adapter.starts).toHaveLength(1);
  expect(bot.snapshot().audit).toEqual([]);
});

it('refuses an unverified sender and a non-owner human in 1:1, and keeps a 1:1 bot message in the audit only', async () => {
  await setup();
  expect(await bot.receive(direct('m1', undefined))).toEqual({ kind: 'unverified_sender' });
  expect(await bot.receive(direct('m2', member))).toEqual({ kind: 'not_owner' });
  expect(await bot.receive(direct('m3', { id: 'im:other-bot', kind: 'bot' }))).toEqual({ kind: 'bot_audit' });
  expect(await bot.receive(direct('m4', { id: 'owner', kind: 'bot' }))).toEqual({ kind: 'bot_audit' });
  await expect(bot.input('api', 'Run this', 'main', member)).rejects.toThrow('not_owner');
  await bot.drain();
  const state = bot.snapshot();
  expect(state.turns).toEqual({});
  expect(state.audit).toEqual([
    'Inbound unverified_sender: fake direct:main m1',
    'Inbound not_owner: fake direct:main m2 human:im:member',
    'Inbound bot_audit: fake direct:main m3 bot:im:other-bot',
    'Inbound bot_audit: fake direct:main m4 bot:owner',
    'Action refused not_owner: input main human:im:member',
  ]);
  expect(fixture.ledger.snapshot().intents).toEqual({});
  expect(fixture.adapter.starts).toHaveLength(0);
  // Unverified adapter data cannot grow one audit row past 1024 characters.
  await bot.receive(direct('x'.repeat(4096), undefined));
  expect(bot.snapshot().audit.at(-1)).toBe(`Inbound unverified_sender: fake direct:main ${'x'.repeat(4096)}`.slice(0, 1024));
});

it('refuses a non-owner approval, answer and cancel with an audit row, and the owner then acts', async () => {
  const connector = vi.fn(async (id: string) => ({ ok: true, externalId: id }));
  await setup({ connector });
  const root = await bot.input('setup', 'Ask me and draft a message');
  await finish(root, { ask_user: { question: 'Continue?', answerKind: 'text' },
    confirmable_action: [{ action: 'send_message', summary: 'Send', draft: { text: 'hello' } }] });
  const card = Object.values(bot.snapshot().cards)[0]!, question = Object.values(bot.snapshot().questions)[0]!;
  await expect(bot.decide(card.id, 'confirmed', member)).rejects.toThrow('not_owner');
  await expect(bot.decide(card.id, 'confirmed', { id: 'owner', kind: 'bot' })).rejects.toThrow('not_owner');
  await expect(bot.answer(question.id, 'Yes', member)).rejects.toThrow('not_owner');
  await expect(bot.cancelTurn(root, member)).rejects.toThrow('not_owner');
  // The check runs before the lookup, so a refusal does not show whether the id exists.
  await expect(bot.decide('missing', 'confirmed', member)).rejects.toThrow('not_owner');
  let state = bot.snapshot();
  expect(state.cards[card.id]!.state).toBe('pending');
  expect(state.questions[question.id]!.answer).toBeUndefined();
  expect(Object.values(state.turns).map(turn => turn.source)).toEqual(['user']);
  expect(connector).not.toHaveBeenCalled();
  expect(state.audit).toEqual([
    `Action refused not_owner: decide ${card.id} human:im:member`,
    `Action refused not_owner: decide ${card.id} bot:owner`,
    `Action refused not_owner: answer ${question.id} human:im:member`,
    `Action refused not_owner: cancelTurn ${root} human:im:member`,
    'Action refused not_owner: decide missing human:im:member',
  ]);
  await bot.decide(card.id, 'confirmed', owner);
  await bot.answer(question.id, 'Yes', owner);
  state = bot.snapshot();
  expect(state.cards[card.id]).toMatchObject({ state: 'confirmed', result: { ok: true, externalId: card.id } });
  expect(connector).toHaveBeenCalledTimes(1);
  expect(Object.values(state.turns).map(turn => turn.source).sort()).toEqual(['action_result', 'answer', 'user']);
});

it('refuses a given undefined, null or malformed principal as unverified, while an omitted principal is the owner', async () => {
  const connector = vi.fn(async (id: string) => ({ ok: true, externalId: id }));
  await setup({ connector });
  const root = await bot.input('setup', 'Draft a message');
  await finish(root, { confirmable_action: [{ action: 'send_message', summary: 'Send', draft: { text: 'hello' } }] });
  const card = Object.values(bot.snapshot().cards)[0]!;
  // For example, a button callback whose verification failed and gave no principal.
  for (const given of [undefined, null, { id: '', kind: 'human' }, { id: 'owner', kind: 'admin' }] as unknown as Principal[]) {
    await expect(bot.decide(card.id, 'confirmed', given)).rejects.toThrow('unverified_sender');
  }
  await expect(bot.input('given-undefined', 'Run this', 'main', undefined)).rejects.toThrow('unverified_sender');
  const state = bot.snapshot();
  expect(state.cards[card.id]!.state).toBe('pending');
  expect(connector).not.toHaveBeenCalled();
  expect(Object.keys(state.turns)).toEqual([root]);
  expect(state.audit).toEqual([...Array(4).fill(`Action refused unverified_sender: decide ${card.id}`), 'Action refused unverified_sender: input main']);
  await bot.decide(card.id, 'confirmed');
  expect(bot.snapshot().cards[card.id]!.state).toBe('confirmed');
  expect(connector).toHaveBeenCalledTimes(1);
});

it('uses BotOptions.owner for the owner checks, the default principal and the input sender', async () => {
  const options = await setup({ owner: 'im:alice', coalesce: {} });
  expect(() => new BotCollaboration(fixture.server, fixture.ledger, { ...options, owner: '' })).toThrow('Invalid owner principal');
  const alice: Principal = { id: 'im:alice', kind: 'human' };
  expect(await bot.receive(direct('m1', owner))).toEqual({ kind: 'not_owner' });
  const viaIm = await bot.receive(direct('m2', alice, 'From IM'));
  expect(viaIm.kind).toBe('owner_input');
  // Without a principal, an owner API acts as the configured owner.
  const viaHost = await bot.input('host-ui', 'From the Host UI');
  for (const id of [viaIm.id!, viaHost]) expect(bot.snapshot().inputs![id]).toMatchObject({ sender: 'im:alice', authority: 'owner' });
  await expect(bot.decide('any', 'confirmed', owner)).rejects.toThrow('not_owner');
});
