import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { freezeRuntimeAdapterDescriptor } from '@byok-sdk/client';
import { BotStubAdapter } from '../../basic/goal-btw.test-support';
import { afterEach, expect, it, vi } from 'vitest';
import { tenantId } from '@byok-sdk/core';
import { HostLedger } from '@byok-sdk/server/execution-core';
import { openHost, template, type TestHost } from '@byok-sdk/example-host-execution-core/test-support';
import { BotCollaboration, type AgentMessageInput, type BotOptions } from './host';
import { inboundKey, type ChannelPort, type InboundMessage } from './channel';
import { channelContract } from './channel-contract';
import { stateOf } from './model';
import { routineOf, seedRoutine } from './routines.test-support';
import { botCompactVeto } from './compaction';

class DraftAdapter extends BotStubAdapter {
  override readonly descriptor = freezeRuntimeAdapterDescriptor({ ...new BotStubAdapter().descriptor,
    capabilities: { ...new BotStubAdapter().descriptor.capabilities, messageDraft: true } });
  private readonly startWaiters = new Map<string, Set<() => void>>();
  started(taskId: string): Promise<void> {
    if (this.sessions.has(taskId)) return Promise.resolve();
    return new Promise(resolve => {
      const waiters = this.startWaiters.get(taskId) ?? new Set<() => void>();
      waiters.add(resolve); this.startWaiters.set(taskId, waiters);
    });
  }
  override async prepare(input: Parameters<BotStubAdapter['prepare']>[0]): ReturnType<BotStubAdapter['prepare']> {
    const prepared = await super.prepare(input);
    if (prepared.kind !== 'prepared') return prepared;
    const operation = prepared.operation;
    return { ...prepared, operation: { ...operation, start: async start => {
      const session = await operation.start(start);
      const taskId = start.manifest.taskId;
      for (const resolve of this.startWaiters.get(taskId) ?? []) resolve();
      this.startWaiters.delete(taskId);
      return session;
    } } };
  }
}
const conversation = { kind: 'direct', id: 'main' } as const;
const owner = { id: 'owner', kind: 'human' } as const;
const outsider = { id: 'outsider', kind: 'human' } as const;
function inbound(id = 'in1', expiresAt = Date.now() + 600_000): InboundMessage {
  return { channel: 'fake', platformMessageId: id, conversation, sender: owner, text: 'Answer me', mentions: [],
    replyRoute: { kind: 'reply', channel: 'fake', inboundId: id, token: `secret-${id}`, expiresAt } };
}
/** Real SQLite HostLedger, embedded server, HTTP and daemon. Only the external ChannelPort is scripted. */
async function openDeliveryHost(port: ChannelPort, rest: Partial<BotOptions> = {}) {
  let bot!: BotCollaboration;
  const received: AgentMessageInput[] = [];
  let now = Date.now();
  const adapter = new DraftAdapter();
  const fixture: TestHost = await openHost({ externalCore: true, ledgerOptions: { compactVeto: botCompactVeto }, adapter, consume: (wake, signal) => bot.consume(wake, signal),
    agentMessage: { consume: async input => { received.push(input); return bot.consumeMessage(input); } } });
  const base = template(fixture.deviceId);
  const options: BotOptions = { botId: 'main', execution: { ...base,
    agentMessageContext: { destinationBinding: 'owner', freshnessCursor: 'delivery' }, payload: { ...base.payload,
      messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 65536 } } },
    connector: async () => null, now: () => now,
    channel: { port, self: { fake: ['own-bot'] }, sendTimeoutMs: 10 }, ...rest };
  let reopened: HostLedger | undefined;
  bot = new BotCollaboration(fixture.server, fixture.ledger, options);
  const ledger = () => reopened ?? fixture.ledger;
  const rows = () => Object.values(bot.snapshot().channel?.deliveries ?? {});
  async function running(id: string) {
    await bot.drain();
    const intent = bot.core.intent(id)!;
    expect(intent).toBeDefined();
    await adapter.started(intent.taskId);
    expect(fixture.adapter.sessions.has(intent.taskId)).toBe(true);
    return fixture.adapter.sessions.get(intent.taskId)!;
  }
  async function finish(id: string, document: unknown = {}) {
    const session = await running(id), taskId = bot.core.intent(id)!.taskId;
    const events = fixture.server.events.subscribe()[Symbol.asyncIterator]();
    try {
      session.finish(document);
      for (;;) {
        const next = await events.next();
        if (next.done) throw new Error('Server event stream ended before the task terminal');
        const event = next.value;
        if (event.kind !== 'task.state' || event.taskId !== taskId || !['Complete', 'Failed', 'Cancelled'].includes(event.state)) continue;
        expect(event.state).toBe('Complete');
        // Read through the server API after its real terminal notification.
        expect(await fixture.server.tasks.deviceTerminal(taskId)).toBeDefined();
        await bot.drain();
        expect(bot.snapshot().turns[id]!.status).toBe('succeeded');
        return;
      }
    } finally { await events.return?.(); }
  }
  function message(id: string, body = 'Final answer'): AgentMessageInput {
    const intent = bot.core.intent(id)!;
    return { tenant: tenantId(ledger().tenant), taskId: intent.taskId, deviceId: fixture.deviceId,
      context: intent.execution.agentMessageContext!, payload: { agentRef: intent.execution.payload.agentRef,
        sessionRef: randomUUID(), contract: 'conversation-turn/v1', messageId: randomUUID(), cursor: 1,
        contentType: 'text/markdown', body, contentHash: `sha256:${createHash('sha256').update(body).digest('hex')}`, byteCount: Buffer.byteLength(body) } };
  }
  return { fixture, received, options, get bot() { return bot; }, ledger, rows, running, finish, message,
    async publish() {
      const root = (await bot.receive(inbound('contract', now + 600_000))).id!;
      await running(root);
      expect(await bot.consumeMessage(message(root))).toEqual({ outcome: 'accepted' });
      await bot.drain();
    },
    async advance(ms: number) { now += ms; await bot.drain(); },
    async drain() { await bot.drain(); },
    deliveries: rows,
    async reopen(path = join(fixture.root, 'host.sqlite')) {
      await bot.close();
      reopened?.close();
      reopened = new HostLedger(path, fixture.ledger.tenant, { compactVeto: botCompactVeto });
      bot = new BotCollaboration(fixture.server, reopened, options);
      await bot.recover();
    },
    async close() {
      await bot.close(); reopened?.close(); await fixture.close();
    },
  };
}
type Harness = Awaited<ReturnType<typeof openDeliveryHost>>;
channelContract('Host delivery outbox with an external fake ChannelPort', openDeliveryHost);
let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; });

it('atomically accepts one payload and one delivery, and refuses a conflicting payload', async () => {
  const send = vi.fn<ChannelPort['send']>(async () => ({ result: 'accepted', platformMessageId: 'platform-1' }));
  h = await openDeliveryHost({ send });
  const root = (await h.bot.receive(inbound())).id!;
  await h.running(root);
  const input = h.message(root);
  expect(await h.bot.consumeMessage(input)).toEqual({ outcome: 'accepted' });
  // Both records exist immediately after acceptance, before a caller has to drain.
  expect(h.bot.snapshot().replies[input.taskId]).toMatchObject({ messageId: input.payload.messageId, contentHash: input.payload.contentHash });
  expect(h.rows()).toEqual([expect.objectContaining({ taskId: input.taskId, messageId: input.payload.messageId, body: input.payload.body })]);
  expect(await h.bot.consumeMessage(input)).toEqual({ outcome: 'accepted' });
  expect(await h.bot.consumeMessage({ ...input, payload: { ...input.payload, messageId: randomUUID() } }))
    .toEqual({ outcome: 'refused', reasonCode: 'message_conflict' });
  await Promise.all([h.bot.drain(), h.bot.drain()]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toMatchObject({ deliveryId: h.rows()[0]!.id, body: 'Final answer', route: { kind: 'reply', inboundId: 'in1', token: 'secret-in1' } });
  expect(h.rows()).toHaveLength(1);
  expect(JSON.stringify(h.ledger().snapshot().outbox)).not.toContain('secret-in1');
});

it('accepts only exact echoes from the configured self bot in the same channel and conversation', async () => {
  h = await openDeliveryHost({ send: async () => { throw new Error('receipt lost'); } });
  await h.publish();
  const id = h.rows()[0]!.id;
  const echo: InboundMessage = { ...inbound('echo'), replyRoute: undefined, sender: { id: 'own-bot', kind: 'bot' }, deliveryId: id };
  for (const bad of [
    { ...echo, sender: undefined },
    { ...echo, sender: { id: 'someone-else', kind: 'bot' as const } },
    { ...echo, sender: { id: 'own-bot', kind: 'human' as const } },
    { ...echo, channel: 'other' },
    { ...echo, conversation: { kind: 'direct' as const, id: 'another' } },
    { ...echo, deliveryId: 'unknown' },
  ]) {
    await h.bot.receive(bad);
    expect(h.rows()[0]!.state).toBe('unknown');
  }
  expect(await h.bot.receive(echo)).toEqual({ kind: 'echo' });
  expect(h.rows()[0]).toMatchObject({ id, state: 'accepted', attempts: 1, platformMessageId: 'echo' });
  expect(Object.keys(h.bot.snapshot().turns)).toHaveLength(1);
});

it('handles an echo during send without deadlock and ignores its later failing completion', async () => {
  h = await openDeliveryHost({ send: async input => {
    await h!.bot.receive({ ...inbound('echo-during-send'), replyRoute: undefined,
      sender: { id: 'own-bot', kind: 'bot' }, deliveryId: input.deliveryId });
    throw new Error('socket closed after authoritative echo');
  } });
  await h.publish();
  expect(h.rows()).toEqual([expect.objectContaining({ state: 'accepted', attempts: 1, platformMessageId: 'echo-during-send' })]);
});

it('requires owner opt-in, revokes push and gives a manual resend a new identity', async () => {
  let reject = true;
  const send = vi.fn<ChannelPort['send']>(async () => { if (reject) throw new Error('unknown'); return { result: 'accepted', platformMessageId: 'resent' }; });
  h = await openDeliveryHost({ send });
  await expect(h.bot.enablePushRoute(conversation, 'fake', 'target', outsider)).rejects.toThrow('not_owner');
  const route = await h.bot.enablePushRoute(conversation, 'fake', 'target');
  const root = await h.bot.input('push', 'Send a reply');
  await h.running(root);
  await h.bot.consumeMessage(h.message(root)); await h.bot.drain();
  const old = h.rows()[0]!;
  expect(old).toMatchObject({ state: 'unknown', route: { kind: 'push', pushRouteId: route } });
  await expect(h.bot.resendDelivery(old.id, outsider)).rejects.toThrow('not_owner');
  reject = false;
  const next = await h.bot.resendDelivery(old.id);
  expect(next).not.toBe(old.id);
  expect(h.rows()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: old.id, state: 'unknown', attempts: 1 }),
    expect.objectContaining({ id: next, resendOf: old.id, state: 'accepted', attempts: 1 }),
  ]));
  await expect(h.bot.revokePushRoute(route, outsider)).rejects.toThrow('not_owner');
  await h.bot.revokePushRoute(route);
  expect(h.bot.snapshot().channel!.pushRoutes[route]!.revokedAt).toEqual(expect.any(Number));
  const nextRoot = await h.bot.input('revoked', 'No longer allowed');
  await h.bot.consumeMessage(h.message(nextRoot)); await h.bot.drain();
  expect(send).toHaveBeenCalledTimes(2);
  expect(h.rows()).toHaveLength(2);
});

it('does not send a routine output without an opted-in push route', async () => {
  const send = vi.fn<ChannelPort['send']>(async () => ({ result: 'accepted', platformMessageId: 'routine' }));
  h = await openDeliveryHost({ send });
  // Trigger a real routine wake through its scheduled server entry.
  const id = await seedRoutine(h.bot, 'daily', 'Report daily', { hour: 9, minute: 0, tz: 'UTC' });
  await h.bot.drain();
  const wake = (await h.fixture.server.wakes.pending()).find(row => row.dedupKey === routineOf(h!.bot, id).next!.dedupKey)!;
  expect(wake).toBeDefined();
  await h.bot.consume({ wakeId: wake.wakeId, dedupKey: wake.dedupKey, availableAt: wake.availableAt,
    deliveredAt: wake.availableAt, delivery: 1 }, new AbortController().signal);
  const turn = Object.values(h.bot.snapshot().turns).find(row => row.source === 'routine')!;
  expect(turn).toBeDefined();
  await h.bot.consumeMessage(h.message(turn.id)); await h.bot.drain();
  expect(h.bot.snapshot().replies[h.bot.core.intent(turn.id)!.taskId]).toBeDefined();
  expect(send).not.toHaveBeenCalled();
  expect(h.rows()).toEqual([]);
  expect(h.bot.snapshot().audit).toContainEqual(expect.stringContaining('Delivery no_push_route:'));
});

it('keeps draft and typed activity out of the delivery outbox until a final message', async () => {
  const send = vi.fn<ChannelPort['send']>(async () => ({ result: 'accepted', platformMessageId: 'final' }));
  h = await openDeliveryHost({ send });
  const root = (await h.bot.receive(inbound())).id!;
  const session = await h.running(root);
  const intent = h.bot.core.intent(root)!;
  const controller = new AbortController();
  const draft = h.fixture.server.tasks.messageDraft(intent.taskId, h.fixture.deviceId, intent.execution.payload.agentRef, { signal: controller.signal })[Symbol.asyncIterator]();
  const first = draft.next();
  session.emit({ type: 'progress', text: 'Working draft' });
  try {
    expect(await first).toEqual({ done: false, value: { kind: 'append', revision: 1, offset: 0, text: 'Working draft' } });
  } finally { controller.abort(); await draft.return?.(); }
  session.emit({ type: 'tool_use', toolCallId: 'tool-1', tool: 'read', input: { path: 'README.md' } });
  await h.bot.drain();
  expect(send).not.toHaveBeenCalled(); expect(h.rows()).toEqual([]);
  await h.finish(root);
  expect(h.received).toHaveLength(1);
  expect(send).toHaveBeenCalledTimes(1);
  expect(h.rows()[0]).toMatchObject({ state: 'accepted', body: h.received[0]!.payload.body });
  expect(h.bot.snapshot().channel!.inbounds[inboundKey(inbound())]!.reply?.token).toBeUndefined();
});

it('expires reply credentials without silently acquiring a push route', async () => {
  const send = vi.fn<ChannelPort['send']>(async () => ({ result: 'accepted', platformMessageId: 'unexpected' }));
  h = await openDeliveryHost({ send });
  const input = inbound('expired', h.options.now!() + 100);
  const root = (await h.bot.receive(input)).id!;
  await h.advance(100);
  await h.bot.consumeMessage(h.message(root)); await h.bot.drain();
  expect(send).not.toHaveBeenCalled(); expect(h.rows()).toEqual([]);
  expect(h.bot.snapshot().channel!.inbounds[inboundKey(input)]!.reply?.token).toBeUndefined();
});

it('reloads a persisted sending claim as unknown without blindly sending after restart', async () => {
  let release!: (value: Awaited<ReturnType<ChannelPort['send']>>) => void;
  let observed!: () => void;
  const started = new Promise<void>(resolve => { observed = resolve; });
  let checkpoint!: string;
  const send = vi.fn<ChannelPort['send']>(() => {
    // Capture the real committed database before this call returns any outcome.
    const db = new DatabaseSync(join(h!.fixture.root, 'host.sqlite'));
    checkpoint = join(h!.fixture.root, 'sending-checkpoint.sqlite');
    db.exec(`VACUUM INTO '${checkpoint.replaceAll("'", "''")}'`); db.close();
    const waiting = new Promise<Awaited<ReturnType<ChannelPort['send']>>>(resolve => { release = resolve; });
    observed();
    return waiting;
  });
  h = await openDeliveryHost({ send });
  const root = (await h.bot.receive(inbound())).id!;
  await h.running(root);
  await h.bot.consumeMessage(h.message(root));
  await started;
  const disk = new HostLedger(checkpoint, h.ledger().tenant);
  const claim = Object.values(stateOf(disk.snapshot().application).channel!.deliveries)[0]!;
  expect(claim).toMatchObject({ state: 'sending', attempts: 1 });
  disk.close();
  release({ result: 'accepted', platformMessageId: 'late' });
  await h.bot.drain();
  // The replacement Host opens the exact crash-boundary SQLite snapshot.
  await h.reopen(checkpoint);
  expect(h.rows()).toEqual([expect.objectContaining({ id: claim.id, state: 'unknown', attempts: 1, code: 'interrupted' })]);
  await h.advance(60_000); await h.bot.recover();
  expect(send).toHaveBeenCalledTimes(1);
});

it('selects the latest authenticated inbound route for a coalesced reply', async () => {
  const send = vi.fn<ChannelPort['send']>(async () => ({ result: 'accepted', platformMessageId: 'batch-final' }));
  h = await openDeliveryHost({ send }, { coalesce: {} });
  const busy = await h.bot.input('busy', 'Work first');
  await h.running(busy);
  const first = await h.bot.receive(inbound('batch-1', h.options.now!() + 600_000));
  const second = await h.bot.receive(inbound('batch-2', h.options.now!() + 600_000));
  expect(second.id).toBe(first.id);
  await h.finish(busy);
  await h.running(first.id!);
  await h.bot.consumeMessage(h.message(first.id!)); await h.bot.drain();
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0]).toMatchObject({ route: { kind: 'reply', inboundId: 'batch-2', token: 'secret-batch-2' } });
  expect(h.rows()[0]!.route).toEqual({ kind: 'reply', inboundId: inboundKey(inbound('batch-2')) });
});

it('lets a late verified echo stop a readback-authorized pending retry before its due time', async () => {
  const send = vi.fn<ChannelPort['send']>(async () => { throw new Error('receipt lost'); });
  const readback = vi.fn<NonNullable<ChannelPort['readback']>>(async () => 'absent');
  h = await openDeliveryHost({ send, readback });
  await h.publish(); await h.bot.drain();
  const row = h.rows()[0]!;
  expect(row).toMatchObject({ state: 'pending', attempts: 1, nextAttemptAt: h.options.now!() + 1_000 });
  expect(send).toHaveBeenCalledTimes(1);
  expect(readback).toHaveBeenCalledWith(row.id);
  expect(await h.bot.receive({ ...inbound('late-echo'), replyRoute: undefined,
    sender: { id: 'own-bot', kind: 'bot' }, deliveryId: row.id })).toEqual({ kind: 'echo' });
  expect(h.rows()[0]).toMatchObject({ id: row.id, state: 'accepted', attempts: 1, platformMessageId: 'late-echo' });
  await h.advance(1_000); await h.bot.drain();
  expect(send).toHaveBeenCalledTimes(1);
  expect(h.rows()[0]).toMatchObject({ state: 'accepted', attempts: 1 });
});

it('delivers the final message, card summary and question through the received reply route', async () => {
  const send = vi.fn<ChannelPort['send']>(async input => ({ result: 'accepted', platformMessageId: `platform-${input.deliveryId}` }));
  h = await openDeliveryHost({ send });
  const root = (await h.bot.receive(inbound('actions', h.options.now!() + 600_000))).id!;
  await h.finish(root, {
    confirmable_action: [{ action: 'send_message', summary: 'Confirm this external message', draft: { text: 'Unapproved draft body' } }],
    ask_user: { question: 'Which account should receive it?', answerKind: 'text' },
  });
  const state = h.bot.snapshot();
  const card = Object.values(state.cards)[0]!, question = Object.values(state.questions)[0]!;
  expect(card).toMatchObject({ state: 'pending', action: { draft: { text: 'Unapproved draft body' } } });
  expect(question.value.question).toBe('Which account should receive it?');
  expect(h.received).toHaveLength(1);
  const final = h.received[0]!;
  const deliveries = h.rows();
  expect(deliveries).toHaveLength(3);
  expect(deliveries).toEqual(expect.arrayContaining([
    expect.objectContaining({ messageId: final.payload.messageId, body: final.payload.body, state: 'accepted' }),
    expect.objectContaining({ messageId: `card:${card.id}`, body: 'Confirm this external message', state: 'accepted' }),
    expect.objectContaining({ messageId: `question:${question.id}`, body: 'Which account should receive it?', state: 'accepted' }),
  ]));
  expect(deliveries.find(row => row.messageId === `card:${card.id}`)!.body).not.toBe('Unapproved draft body');
  expect(send).toHaveBeenCalledTimes(3);
  for (const [input] of send.mock.calls) {
    expect(input.route).toMatchObject({ kind: 'reply', channel: 'fake', inboundId: 'actions', token: 'secret-actions' });
  }
});

it('delivers a real room speech post to its group reply route and sends nothing for pass', async () => {
  const send = vi.fn<ChannelPort['send']>(async input => ({ result: 'accepted', platformMessageId: `platform-${input.deliveryId}` }));
  h = await openDeliveryHost({ send });
  const setup = await h.bot.input('create-delivery-room', 'Create a review room');
  await h.finish(setup, { create_room: [{ localId: 'new_room_1', name: 'Delivery room', members: ['main'] }] });
  const room = Object.values(h.bot.snapshot().team.rooms)[0]!;
  expect(room).toMatchObject({ name: 'Delivery room', members: ['main'] });
  expect(send).not.toHaveBeenCalled();
  // This direct route must never become authority to push into the room.
  await h.bot.enablePushRoute(conversation, 'fake', 'direct-target');
  const group: InboundMessage = { ...inbound('group-post', h.options.now!() + 600_000),
    conversation: { kind: 'group', id: room.id }, sender: outsider, mentions: ['main'] };
  const post = await h.bot.receive(group);
  expect(post.kind).toBe('room_input');
  const seat = h.bot.snapshot().team.rounds[post.id!]!.seats[0]!;
  await h.finish(seat, { speech: { kind: 'post', text: 'The group review is complete.' } });
  expect(h.bot.snapshot().team.seats[seat]!.status).toBe('post');
  expect(h.bot.snapshot().team.rooms[room.id]!.messages).toContainEqual(expect.objectContaining({ id: seat, from: 'main', text: 'The group review is complete.' }));
  expect(h.rows()).toEqual([expect.objectContaining({ messageId: `speech:${seat}`, body: 'The group review is complete.',
    state: 'accepted', conversation: { kind: 'group', id: room.id }, route: { kind: 'reply', inboundId: inboundKey(group) } })]);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send.mock.calls[0]![0].route).toMatchObject({ kind: 'reply', inboundId: 'group-post', token: 'secret-group-post' });
  const passInbound: InboundMessage = { ...group, platformMessageId: 'group-pass',
    replyRoute: { kind: 'reply', channel: 'fake', inboundId: 'group-pass', token: 'secret-pass', expiresAt: h.options.now!() + 600_000 } };
  const pass = await h.bot.receive(passInbound);
  const passSeat = h.bot.snapshot().team.rounds[pass.id!]!.seats[0]!;
  await h.finish(passSeat, { speech: { kind: 'pass' } });
  expect(h.bot.snapshot().team.seats[passSeat]!.status).toBe('pass');
  expect(send).toHaveBeenCalledTimes(1);
  expect(h.rows()).toHaveLength(1);
});
