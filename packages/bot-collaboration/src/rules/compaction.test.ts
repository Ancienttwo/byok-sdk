import { expect, it } from 'vitest';
import { compactVeto, type CompactFacts } from './compaction';
import type { Turn } from './turn';
import type { AcceptedReply, Delegation } from './delegation';
import type { Seat } from './rooms';

// #793 S8: the one compact veto of L and H, on plain rows and store facts.
function rows() {
  const state = { turns: {} as Record<string, Turn>, delegations: {} as Record<string, Delegation>,
    team: { seats: {} as Record<string, Seat> }, replies: {} as Record<string, AcceptedReply> };
  const intents = new Set<string>(), receipts = new Map<string, { messageId: string; contentHash: string }>();
  const facts: CompactFacts = { hasIntent: turnId => intents.has(turnId), receipt: taskId => receipts.get(taskId) };
  const turn = (id: string, fields: Partial<Turn> = {}) => {
    state.turns[id] = { id, root: id, botId: 'main', source: 'user', request: '', hop: 0, status: 'succeeded', conclusion: 'succeeded', reported: true, ...fields };
  };
  const delegation = (id: string, fields: Partial<Delegation>) => {
    state.delegations[id] = { id, root: 'r', fromBotId: 'main', fromTurnId: 'x', fromTaskId: 'x', index: 0, toBotId: 'b', request: '', hop: 1,
      chainTurnIds: [], batch: 'x', status: 'running', revision: 0, ...fields };
  };
  return { state, intents, receipts, turn, delegation, veto: (key: string) => compactVeto(state, key, facts) };
}

it('refuses a Turn that is not concluded, and a concluded Turn with an intent that is not reported', () => {
  const r = rows();
  r.turn('open', { status: 'processing', conclusion: undefined }); r.intents.add('open');
  r.turn('queued', { status: 'queued', conclusion: undefined });
  r.turn('unreported', { reported: undefined }); r.intents.add('unreported');
  // A Turn that ended without an intent has nothing to report, for example an unpromoted routine Turn of an archived owner.
  r.turn('ended', { status: 'failed', conclusion: 'cancelled', reported: undefined });
  r.turn('settled'); r.intents.add('settled');
  expect(['open', 'queued', 'unreported'].map(r.veto)).toEqual(Array(3).fill('The Turn is not concluded and reported'));
  expect(r.veto('ended')).toBeUndefined();
  expect(r.veto('settled')).toBeUndefined();
});

it('refuses a chain Turn or a cancel target of an unresolved delegation, and a late Turn of any delegation', () => {
  const r = rows();
  for (const id of ['chain', 'target', 'late', 'resolved', 'cancelled']) r.turn(id);
  r.delegation('d1', { chainTurnIds: ['chain'] });
  r.delegation('d2', { chainTurnIds: ['other'], cancel: { requestedAt: 0, targetTurnId: 'target', delivered: true } });
  r.delegation('d3', { verdict: 'answered', status: 'resolved', chainTurnIds: ['resolved'], lateTurnId: 'late' });
  r.delegation('d4', { verdict: 'cancelled', status: 'resolved', chainTurnIds: ['other'], cancel: { requestedAt: 0, targetTurnId: 'cancelled', delivered: true } });
  for (const key of ['chain', 'target', 'late']) expect(r.veto(key)).toBe('An unresolved delegation references the Turn');
  expect(r.veto('resolved')).toBeUndefined();
  expect(r.veto('cancelled')).toBeUndefined();
});

it('refuses the Turn of an unreleased room seat', () => {
  const r = rows();
  r.turn('seat'); r.turn('released');
  r.state.team.seats.seat = { id: 'seat', roundId: 'round', botId: 'main', status: 'post', released: false, late: false };
  r.state.team.seats.released = { id: 'released', roundId: 'round', botId: 'main', status: 'post', released: true, late: false };
  expect(r.veto('seat')).toBe('The room seat of the Turn is not released');
  expect(r.veto('released')).toBeUndefined();
});

it('refuses a reply whose receipt the store does not hold, and a delegated reply body before its verdict', () => {
  const r = rows();
  const reply = (turnId: string, body?: string): AcceptedReply =>
    ({ turnId, messageId: 'm', contentHash: 'h', contentType: 'text/markdown', acceptedAt: 0, ...(body === undefined ? {} : { body }) });
  r.turn('receipt'); r.state.replies.task = reply('receipt');
  expect(r.veto('receipt')).toBe('The reply receipt of the Turn is not settled');
  r.receipts.set('task', { messageId: 'm', contentHash: 'other' });
  expect(r.veto('receipt')).toBe('The reply receipt of the Turn is not settled');
  r.receipts.set('task', { messageId: 'm', contentHash: 'h' });
  expect(r.veto('receipt')).toBeUndefined();
  r.turn('chain', { delegationId: 'd1' }); r.state.replies.chain = reply('chain', 'Answer'); r.receipts.set('chain', { messageId: 'm', contentHash: 'h' });
  r.delegation('d1', { status: 'reply_pending', chainTurnIds: ['other'] });
  expect(r.veto('chain')).toBe('The reply receipt of the Turn is not settled');
  r.delegation('d1', { verdict: 'answered', status: 'resolved', chainTurnIds: ['other'] });
  expect(r.veto('chain')).toBeUndefined();
});

it('allows a key without a Turn, an inherited property name included', () => {
  const r = rows();
  expect(r.veto('host-job')).toBeUndefined();
  expect(r.veto('constructor')).toBeUndefined();
});
