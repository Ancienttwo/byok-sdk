import { afterEach, expect, it, vi } from 'vitest';
import { HostLedger } from '@byok-sdk/server/execution-core';
import { template } from './k4-fixtures.test-support';
import { createByokServer } from '@byok-sdk/server';
import { BotCollaboration } from './host';
import { addTurn, stateOf } from './model';
import { inboundKey, type InboundMessage } from './channel';
import { cleanReplyTokens, deliveryRoute, enablePush, queueDelivery, refuseRoute, rememberFilteredInbound, rememberInbound, resendUnknown, revokePush } from './delivery-routing';
import { inboundDispositionsOf } from './inbound';
import { botCompactVeto } from './compaction';

const ledgers: HostLedger[] = [];
afterEach(() => { for (const ledger of ledgers.splice(0)) ledger.close(); });
const conversation = { kind: 'direct', id: 'main' } as const;
const incoming = (id = 'in1'): InboundMessage => ({ channel: 'fake', platformMessageId: id,
  conversation, sender: { kind: 'human', id: 'owner' }, mentions: [], text: 'request',
  replyRoute: { kind: 'reply', channel: 'fake', inboundId: id, token: `secret-${id}`, expiresAt: 200 } });
function ledger() {
  const value = new HostLedger(':memory:', 'delivery-routing'); ledgers.push(value);
  value.transaction(s => {
    const state = stateOf(s.application);
    addTurn(state, { id: 'root', root: 'root', botId: 'main', source: 'user', request: 'request', hop: 0, authority: 'owner' });
  });
  return value;
}

it('rolls back input state when a reply credential is bound to another inbound message', () => {
  const db = ledger(), before = db.snapshot();
  expect(() => db.transaction(s => {
    const state = stateOf(s.application);
    addTurn(state, { id: 'new', root: 'new', botId: 'main', source: 'user', request: 'new', hop: 0, authority: 'owner' });
    const message = incoming(); message.replyRoute!.inboundId = 'another-message';
    rememberInbound(state, message, 'new');
  })).toThrow('Invalid reply route binding');
  expect(db.snapshot()).toEqual(before);
});

it('never refreshes the original credential or expiry on platform redelivery', () => {
  const db = ledger();
  db.transaction(s => {
    const state = stateOf(s.application), message = incoming();
    rememberInbound(state, message, 'root');
    message.replyRoute = { ...message.replyRoute!, token: 'replacement-secret', expiresAt: 9999 };
    rememberInbound(state, message, 'root');
    expect(state.channel!.inbounds[inboundKey(message)]!.reply).toMatchObject({ token: 'secret-in1', expiresAt: 200 });
  });
});

it('keeps a blocked root reply route until it resumes and replies', () => {
  ledger().transaction(s => {
    const state = stateOf(s.application), turn = state.turns.root!;
    rememberInbound(state, incoming(), turn.root);
    turn.status = 'blocked'; turn.blockedReason = 'Unavailable model: test';
    cleanReplyTokens(s, state, 100);
    expect(state.channel!.inbounds[inboundKey(incoming())]!.reply?.token).toBe('secret-in1');
    turn.status = 'processing'; delete turn.blockedReason;
    const reply = queueDelivery(s, state, turn, 'task', 'message', 'answer', 150)!;
    expect(deliveryRoute(state, reply, 150)).toMatchObject({ token: 'secret-in1' });
  });
});

it('closes a reply route after a blocked room seat is released', () => {
  ledger().transaction(s => {
    const state = stateOf(s.application), message = { ...incoming(), conversation: { kind: 'group', id: 'room' } as const };
    state.team.rooms.room = { id: 'room', name: 'Room', members: ['main'], mode: 'mention', announcement: '', visibleFrom: { main: 0 }, messages: [] };
    state.team.rounds.round = { id: 'round', root: 'round', roomId: 'room', input: '', seats: ['seat'], limit: 1, counts: { main: 1 }, closed: true };
    state.team.seats.seat = { id: 'seat', roundId: 'round', botId: 'main', status: 'blocked', released: true, late: false };
    const turn = addTurn(state, { id: 'seat', root: 'seat', botId: 'main', source: 'room_slot', request: 'request', hop: 0, authority: 'owner' });
    turn.status = 'blocked';
    rememberInbound(state, message, 'round');
    expect(queueDelivery(s, state, turn, 'task', 'message', 'answer', 100)).toBeUndefined();
    cleanReplyTokens(s, state, 100);
    expect(state.channel!.inbounds[inboundKey(message)]!.reply?.token).toBeUndefined();
  });
});

it('replaces a filtered inbound when the same message is admitted', () => {
  ledger().transaction(s => {
    const state = stateOf(s.application), message = incoming(), turn = state.turns.root!;
    rememberFilteredInbound(state, { ...message, sender: undefined }, 'unverified_sender');
    rememberInbound(state, message, turn.root);
    expect(inboundDispositionsOf(state)).toMatchObject([{ disposition: 'coalesced', turnId: turn.id }]);
    const reply = queueDelivery(s, state, turn, 'task', 'message', 'answer', 100)!;
    expect(deliveryRoute(state, reply, 100)).toMatchObject({ token: 'secret-in1' });
    turn.conclusion = 'succeeded';
    expect(inboundDispositionsOf(state)).toMatchObject([{ disposition: 'answered', turnId: turn.id }]);
  });
});

it('keeps a committed pending reply slot through settlement, then deletes its token after acceptance', () => {
  const db = ledger();
  db.transaction(s => {
    const state = stateOf(s.application), turn = state.turns.root!;
    rememberInbound(state, incoming(), 'root');
    const row = queueDelivery(s, state, turn, 'task', 'message', 'answer', 100)!;
    turn.conclusion = 'succeeded';
    cleanReplyTokens(s, state, 150);
    expect(deliveryRoute(state, row, 150)).toMatchObject({ token: 'secret-in1' });
    row.state = 'accepted';
    cleanReplyTokens(s, state, 150);
    expect(state.channel!.inbounds[inboundKey(incoming())]!.reply?.token).toBeUndefined();
    expect(state.channel!.deliveries[row.id]!.state).toBe('accepted');
  });
});

it('does not acquire a fresh reply slot after its root has settled', () => {
  const db = ledger();
  db.transaction(s => {
    const state = stateOf(s.application), turn = state.turns.root!;
    rememberInbound(state, incoming(), 'root');
    turn.conclusion = 'succeeded';
    expect(queueDelivery(s, state, turn, 'late-task', 'late-message', 'late', 100)).toBeUndefined();
    expect(state.audit).toContain('Delivery reply_route_expired: late-task late-message');
    expect(state.channel!.deliveries).toEqual({});
  });
});

it('clears the reply token once a replacement is accepted and the root concludes', () => {
  ledger().transaction(s => {
    const state = stateOf(s.application), turn = state.turns.root!;
    rememberInbound(state, incoming(), turn.root);
    const old = queueDelivery(s, state, turn, 'task', 'message', 'answer', 100)!;
    old.state = 'unknown'; old.attempts = 1;
    const replacement = resendUnknown(state, old.id, 100);
    replacement.state = 'accepted'; turn.conclusion = 'succeeded';
    cleanReplyTokens(s, state, 150);
    expect(old.state).toBe('unknown');
    expect(state.channel!.inbounds[inboundKey(incoming())]!.reply?.token).toBeUndefined();
  });
});

it('expires pending credentials and uses a separately opted-in push route with a different delivery id', () => {
  const db = ledger();
  db.transaction(s => {
    const state = stateOf(s.application);
    rememberInbound(state, incoming(), 'root');
    const row = queueDelivery(s, state, state.turns.root!, 'task', 'message', 'answer', 100)!;
    const push = enablePush(state, conversation, 'fake', 'target', 'owner', 110);
    cleanReplyTokens(s, state, 200);
    expect(deliveryRoute(state, row, 200)).toBeUndefined();
    refuseRoute(state, row);
    const next = Object.values(state.channel!.deliveries).find(value => value.id !== row.id)!;
    expect(row).toMatchObject({ state: 'rejected', code: 'reply_route_expired' });
    expect(next).toMatchObject({ state: 'pending', attempts: 0, route: { kind: 'push', pushRouteId: push.id } });
    expect(JSON.stringify(state.channel!.pushRoutes)).not.toContain('secret-in1');
  });
});

it('never borrows another conversation push route for routine output', () => {
  const db = ledger();
  db.transaction(s => {
    const state = stateOf(s.application);
    enablePush(state, { kind: 'direct', id: 'other' }, 'fake', 'other-target', 'owner', 100);
    const turn = addTurn(state, { id: 'routine', root: 'routine', botId: 'main', source: 'routine', request: 'report', hop: 0, authority: 'bot' });
    expect(queueDelivery(s, state, turn, 'routine-task', 'routine-message', 'report', 100)).toBeUndefined();
    expect(state.audit).toContain('Delivery no_push_route: routine-task routine-message');
  });
});

it('revokes pending work immediately, preserves unknown evidence and uses a new opt-in identity', () => {
  const db = ledger();
  db.transaction(s => {
    const state = stateOf(s.application), turn = state.turns.root!;
    const old = enablePush(state, conversation, 'fake', 'target', 'owner', 100);
    const pending = queueDelivery(s, state, turn, 'task', 'message', 'answer', 100)!;
    const unknown = queueDelivery(s, state, turn, 'task', 'uncertain-message', 'uncertain', 100)!;
    unknown.state = 'unknown'; unknown.attempts = 1;
    revokePush(state, old.id, 101);
    expect(pending).toMatchObject({ state: 'rejected', code: 'push_route_revoked' });
    expect(unknown.state).toBe('unknown');
    const next = enablePush(state, conversation, 'fake', 'target', 'owner', 101);
    expect(next.id).not.toBe(old.id);
    const resend = resendUnknown(state, unknown.id, 101);
    expect(resend).toMatchObject({ resendOf: unknown.id, state: 'pending', attempts: 0, route: { kind: 'push', pushRouteId: next.id } });
    expect(resend.id).not.toBe(unknown.id);
    expect(unknown.state).toBe('unknown');
    expect(() => resendUnknown(state, unknown.id, 102)).toThrow('already been resent');
    resend.state = 'unknown';
    expect(resendUnknown(state, resend.id, 102).resendOf).toBe(resend.id);
  });
});

it('rejects prototype keys as route or delivery identities', () => {
  const db = ledger();
  db.transaction(s => {
    const state = stateOf(s.application);
    enablePush(state, conversation, 'fake', 'target', 'owner', 100);
    for (const id of ['__proto__', 'constructor']) {
      expect(() => revokePush(state, id, 100)).toThrow('Push route not found');
      expect(() => resendUnknown(state, id, 100)).toThrow('Only an unknown delivery');
    }
    expect(Object.hasOwn(Object.prototype, 'revokedAt')).toBe(false);
  });
});

it('keeps persisted pending deliveries dormant when the channel is not configured', async () => {
  vi.useFakeTimers();
  const server = createByokServer({ productId: 'm3-disabled' });
  const db = new HostLedger(':memory:', 'product:m3-disabled', { compactVeto: botCompactVeto });
  const bot = new BotCollaboration(server, db, { botId: 'main', execution: template('unused-device'), connector: async () => null, dreaming: false });
  try {
    db.transaction(s => {
      const state = stateOf(s.application);
      const route = enablePush(state, conversation, 'fake', 'target', 'owner', 100);
      state.channel!.deliveries.dormant = { id: 'dormant', taskId: 'finished-task', turnId: 'finished-turn', messageId: 'final', body: 'final', channel: 'fake',
        conversation, route: { kind: 'push', pushRouteId: route.id }, state: 'pending', attempts: 0 };
    });
    const timers = vi.getTimerCount();
    await bot.drain();
    expect(vi.getTimerCount()).toBe(timers);
    expect(bot.snapshot().channel!.deliveries.dormant).toMatchObject({ state: 'pending', attempts: 0 });
  } finally {
    await bot.close(); await server.close(); db.close(); vi.useRealTimers();
  }
});
