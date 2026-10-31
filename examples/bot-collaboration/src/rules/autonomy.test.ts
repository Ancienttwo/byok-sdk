import { expect, it } from 'vitest';
import { addTurn } from './turn';
import { applyTurnOutcome, type OutcomePorts, type OutcomeState } from './outcome';
import { outcomeSchema, type ContextState } from './schema';
import { applySpeech, advanceRooms, roomInput, type RoomsState } from './rooms';
import { autonomyOf, recordWouldDo, wouldDoRows, type AutonomyGate, type AutonomyState } from './autonomy';

/** A Turn of a Bot whose schema offers every ordinary action, and the ports that record an observed action. */
function setup(taskId = 'task') {
  const main = { id: 'main', name: 'Main', role: 'Team owner', mainBot: true, archived: false, readyRevision: '1',
    execution: { deviceId: 'device', payload: { agentRef: { agentId: 'main', profileRevision: '1' } } } };
  const helper = { ...main, id: 'helper', name: 'Helper', mainBot: false };
  const state: OutcomeState & ContextState & AutonomyState = {
    team: { bots: { main, helper }, rooms: {}, rounds: {}, seats: {}, roots: {}, notes: [], homeOperations: [] },
    turns: {}, budgets: {}, delegations: {}, batches: {}, units: {}, replies: {}, rejected: [], audit: [], schemas: {}, cards: {}, questions: {},
  };
  const turn = addTurn(state, { id: 't1', root: 't1', source: 'user', request: 'Work', botId: 'main', hop: 0, authority: 'owner' });
  state.schemas.t1 = outcomeSchema('main', state, turn);
  const calls = { createRoutine: 0, updateRoutine: 0 };
  const ports = (autonomy?: AutonomyGate): OutcomePorts => ({
    now: () => 1000, publish: () => {}, committed: { intent: () => undefined }, manage: () => {},
    createRoutine: () => { calls.createRoutine++; }, updateRoutine: () => { calls.updateRoutine++; }, cancelRoutine: () => {},
    ...(autonomy ? { autonomy } : {}),
  });
  const records: string[] = [];
  const observe = (): AutonomyGate => ({ autonomy: 'observe', record: (action, index, detail) => {
    const row = recordWouldDo(state, { botId: 'main', taskId, action, index, at: 1000, detail });
    if (row) records.push(row.id);
  } });
  return { state, turn, ports, calls, observe, records, taskId };
}
const routine = { localId: 'new_routine_1', schedule: { hour: 9, minute: 0, tz: 'UTC' }, prompt: 'Daily report' } as const;

it('records a create_routine once for one outcome and creates no routine', () => {
  const { state, ports, calls, observe, taskId } = setup();
  applyTurnOutcome(state, 't1', taskId, { create_routine: [routine] }, ports(observe()));
  applyTurnOutcome(state, 't1', taskId, { create_routine: [routine] }, ports(observe()));
  expect(calls.createRoutine).toBe(0);
  expect(wouldDoRows(state)).toEqual([expect.objectContaining({ botId: 'main', taskId, action: 'create_routine', index: 0, detail: routine })]);
  // The same outcome records one row, not one per application.
  expect(Object.keys(state.wouldDo ?? {})).toHaveLength(1);
});

it('records a cross-Bot delegation but still applies a self continuation in observe', () => {
  const { state, ports, observe } = setup();
  applyTurnOutcome(state, 't1', 'task', { delegate: [{ to: 'helper', request: 'Check the totals' }, { to: 'main', request: 'Draft it' }] }, ports(observe()));
  expect(Object.values(state.delegations)).toEqual([]);
  expect(state.batches).toEqual({});
  expect(Object.values(state.turns).filter(row => row.source === 'bot_request')).toEqual([]);
  expect(state.budgets.t1).toEqual({ continuation: 1, delegation: 0 });
  expect(Object.values(state.turns).filter(row => row.source === 'continuation')).toHaveLength(1);
  expect(wouldDoRows(state)).toEqual([expect.objectContaining({ action: 'delegate', index: 0, detail: { to: 'helper', request: 'Check the totals' } })]);
});

it('records a room_call in observe while the accepted speech stays, and creates no seat', () => {
  const team: RoomsState = {
    bots: { a: { archived: false }, b: { archived: false } },
    rooms: { r: { id: 'r', name: 'Room', members: ['a', 'b'], mode: 'mention', announcement: '', visibleFrom: { a: 0, b: 0 }, messages: [] } },
    rounds: {}, seats: {}, roots: {},
  };
  const round = roomInput(team, 'key', 'r', 'Review', ['a']);
  advanceRooms(team, {}, 0);
  const seat = team.rounds[round]!.seats[0]!;
  const state: AutonomyState = {};
  const rows: string[] = [];
  const gate: AutonomyGate = { autonomy: 'observe', record: (action, index, detail) => {
    const row = recordWouldDo(state, { botId: 'a', taskId: 'task', action, index, at: 1000, detail });
    if (row) rows.push(row.id);
  } };
  const accepted: string[] = [];
  const accept = (kind: string, work: () => void) => { work(); accepted.push(kind); };
  applySpeech(team, seat, { speech: { kind: 'post', text: 'Ready' }, room_call: { members: ['b'] } }, 'task', 1, accept, gate);
  expect(team.rooms.r!.messages.map(message => message.text)).toEqual(['Review', 'Ready']);
  expect(Object.keys(team.rounds)).toHaveLength(1);
  expect(Object.keys(team.seats)).toHaveLength(1);
  expect(team.roots[round]).toEqual({ autonomous: 0, late: 0 });
  expect(accepted).toEqual(['speech', 'room_call']);
  expect(wouldDoRows(state)).toEqual([expect.objectContaining({ action: 'room_call', detail: { members: ['b'] } })]);
  expect(rows).toHaveLength(1);
  // The same seat cannot speak twice, so a second application records nothing new either.
  applySpeech(team, seat, { speech: { kind: 'post', text: 'Ready' }, room_call: { members: ['b'] } }, 'task', 1, accept, gate);
  expect(rows).toHaveLength(1);
});

it('applies the autonomous actions in auto, and an absent gate keeps the pre-#1229 behavior', () => {
  for (const gate of [undefined, { autonomy: 'auto' as const, record: () => { throw new Error('auto records nothing'); } }]) {
    const { state, ports, calls } = setup();
    applyTurnOutcome(state, 't1', 'task', { create_routine: [routine] }, ports(gate));
    expect(calls.createRoutine).toBe(1);
    expect(state.wouldDo).toBeUndefined();
  }
});

it('reads an absent autonomy as observe, the default of a new Bot', () => {
  expect(autonomyOf({ autonomy: 'auto' })).toBe('auto');
  expect(autonomyOf({ autonomy: 'observe' })).toBe('observe');
  expect(autonomyOf({})).toBe('observe');
  expect(autonomyOf(undefined)).toBe('observe');
});