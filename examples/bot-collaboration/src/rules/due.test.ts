import { expect, it } from 'vitest';
import { collaborationDue } from './due';

type DueState = Parameters<typeof collaborationDue>[0];
const card = (id: string, state: 'pending' | 'confirmed' | 'rejected' | 'expired', expiresAt: number) =>
  ({ id, turnId: 't1', action: { action: 'send_message', summary: 'Send', draft: { text: 'hi' } }, state, expiresAt });
const seat = (id: string, released: boolean, deadline?: number) =>
  ({ id, roundId: 'r1', botId: 'b1', status: 'running', released, late: false, ...(deadline === undefined ? {} : { deadline }) });

it('lists the open batches\' seals, the pending cards\' expiries, the unreleased seats\' deadlines and the delegation times (#793 S4)', () => {
  const state = {
    inputBatches: { open: { state: 'open', sealAt: 10 }, sealed: { state: 'sealed', sealAt: 1 } },
    cards: { c1: card('c1', 'pending', 20), c2: card('c2', 'confirmed', 2), c3: card('c3', 'expired', 3) },
    team: { seats: { s1: seat('s1', false, 30), s2: seat('s2', true, 4), s3: seat('s3', false) } },
    delegations: { d1: { nextCheckAt: 40 }, d2: { verdict: 'succeeded', status: 'resolved' } },
  } as unknown as DueState;
  expect(collaborationDue(state)).toEqual([10, 20, 30, 40]);
  // The delegation timers come from the caller, as in `settleDelegations`.
  const cancelled = { inputBatches: {}, cards: {}, team: { seats: {} },
    delegations: { d1: { status: 'running', cancel: { requestedAt: 100 }, chainTurnIds: ['t1'] } } } as unknown as DueState;
  expect(collaborationDue(cancelled, { cancelGraceMs: 5, uncertainAfterMs: 7 })).toEqual([105]);
  expect(collaborationDue({ cards: {}, team: { seats: {} }, delegations: {} } as unknown as DueState)).toEqual([]);
  // A running delegation with no claim has no uncertain timer yet.
  expect(collaborationDue({ cards: {}, team: { seats: {} }, delegations: { d1: { status: 'running', chainTurnIds: [] } } } as unknown as DueState)).toEqual([]);
});
