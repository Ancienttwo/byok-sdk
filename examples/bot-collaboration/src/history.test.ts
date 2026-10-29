import { expect, it } from 'vitest';
import { template } from '@byok-sdk/example-host-execution-core/test-support';
import type { LedgerState } from '@byok-sdk/server/execution-core';
import { stateOf, type Turn } from './model';
import { applyManagement, roomFields } from './team';
import { roomInput, advanceRooms, applySpeech } from './rooms';
import { turnContext } from './schema';
import { HISTORY_MAX_BYTES } from './history';

function setup(members = ['b0', 'b1', 'b2']) {
  const ledger = { application: {}, intents: {}, executions: {} } as LedgerState;
  const state = stateOf(ledger.application);
  for (const id of ['b0', 'b1', 'b2']) state.team.bots[id] = { id, name: id, role: 'Member', persona: '', model: 'default',
    mainBot: id === 'b0', archived: false, revision: '1', readyRevision: '1', execution: template('device', id) };
  state.team.rooms.r = { id: 'r', ...roomFields(state.team, { name: 'Room', members }), messages: [] };
  const advance = () => advanceRooms(ledger, state, 0, (id, botId, request) => {
    state.turns[id] = { id, root: id, botId, request, source: 'room_slot', hop: 0, status: 'queued' };
  });
  const membersAs = (next: string[], taskId: string) => applyManagement(state, 'b0', taskId,
    { update_room: [{ roomId: 'r', members: next }] }, { default: template('device') }, (_kind, work) => work());
  return { ledger, state, advance, membersAs };
}

it('uses actual UTF-8 JSON bytes and keeps a suffix of complete messages without changing ledger rows', () => {
  const { state, advance } = setup();
  const round = roomInput(state, 'bytes', 'r', 'Current request', ['b1']); advance();
  const turn = state.turns[state.team.rounds[round]!.seats[0]!]!;
  const text = '\0😀"\\'.repeat(1000);
  state.team.rooms.r!.messages = Array.from({ length: 20 }, (_, i) => ({ id: String(i), from: 'user', text, late: false }));
  const saved = structuredClone(state.team.rooms.r!.messages);
  const context = turnContext(state, turn);
  if (!('room' in context)) throw new Error('Expected room context');
  expect(context.room.messages.length).toBeGreaterThan(0);
  expect(context.room.messages.length).toBeLessThan(20);
  expect(context.room.messages).toEqual(saved.slice(-context.room.messages.length));
  expect(context.historyWindow.omittedMessages).toBe(20 - context.room.messages.length);
  expect(context.historyWindow.notice).toContain('Earlier history was omitted');
  expect(Buffer.byteLength(JSON.stringify(context), 'utf8') + Buffer.byteLength(turn.request, 'utf8')).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
  const expanded = structuredClone(context);
  expanded.room.messages.unshift(saved[saved.length - context.room.messages.length - 1]!);
  expanded.historyWindow.omittedMessages--;
  expect(Buffer.byteLength(JSON.stringify(expanded), 'utf8') + Buffer.byteLength(turn.request, 'utf8')).toBeGreaterThan(HISTORY_MAX_BYTES);
  expect(state.team.rooms.r!.messages).toEqual(saved);
});

it('windows only this Bot private history and leaves the current request for the frozen Request section', () => {
  const { state } = setup();
  for (let i = 0; i < 150; i++) state.turns[`old-${i}`] = { id: `old-${i}`, root: `old-${i}`, botId: 'b1',
    source: 'user', request: 'History-'.repeat(400), hop: 0, status: 'succeeded' };
  const turn: Turn = { id: 'current', root: 'current', botId: 'b1', source: 'user', request: 'CURRENT-' + '😀'.repeat(4096), hop: 0, status: 'queued' };
  state.turns[turn.id] = turn;
  state.turns.private = { ...turn, id: 'other', botId: 'b0', request: 'Other Bot secret' };
  const context = turnContext(state, turn);
  if (!('turns' in context)) throw new Error('Expected private context');
  expect(context.turns.length).toBeGreaterThan(0);
  expect(context.turns.length).toBeLessThanOrEqual(100);
  expect(context.turns.at(-1)!.id).toBe('old-149');
  expect(context.turns.some(t => t.id === turn.id)).toBe(false);
  expect(context.historyWindow.omittedTurns).toBe(150 - context.turns.length);
  expect(context.historyWindow.notice).toContain('Earlier history was omitted');
  expect(context.historyWindow.currentRequestBytes).toBe(Buffer.byteLength(turn.request, 'utf8'));
  expect(Buffer.byteLength(JSON.stringify(context), 'utf8') + context.historyWindow.currentRequestBytes).toBeLessThanOrEqual(HISTORY_MAX_BYTES);
  expect(JSON.stringify(context)).not.toContain('Other Bot secret');
  expect(state.turns[turn.id]!.request).toBe('CURRENT-' + '😀'.repeat(4096));
  expect(Object.keys(state.turns)).toHaveLength(152);
});

it('keeps no-mention messages as background without creating an execution', () => {
  const { state, advance } = setup();
  const background = roomInput(state, 'background', 'r', 'Background evidence', []); advance();
  expect(state.team.rounds[background]!.seats).toEqual([]);
  expect(state.turns).toEqual({});
  const round = roomInput(state, 'selected', 'r', 'Now answer', ['b1']); advance();
  const context = turnContext(state, state.turns[state.team.rounds[round]!.seats[0]!]!);
  if (!('room' in context)) throw new Error('Expected room context');
  expect(context.room.messages.map(m => m.text)).toEqual(['Background evidence', 'Now answer']);
  expect(context.historyWindow.notice).toBeNull();
});

it('hides pre-join messages and an older round root request from a called late joiner', () => {
  const { state, advance, membersAs } = setup(['b0', 'b1']);
  const round = roomInput(state, 'old-root', 'r', 'PRE-JOIN-SECRET', ['b0']); advance();
  const first = state.turns[state.team.rounds[round]!.seats[0]!]!;
  membersAs(['b0', 'b1', 'b2'], 'join');
  expect(state.team.rooms.r!.visibleFrom.b2).toBe(1);
  applySpeech(state, first, { speech: { kind: 'post', text: 'POST-JOIN-CALL' }, room_call: { members: ['b2'] } },
    'call', 0, (_kind, work) => work());
  advance();
  const late = state.turns[state.team.rounds[round]!.seats[1]!]!;
  const context = turnContext(state, late);
  if (!('room' in context)) throw new Error('Expected room context');
  expect(context.room.messages.map(m => m.text)).toEqual(['POST-JOIN-CALL']);
  expect(JSON.stringify(context)).not.toContain('PRE-JOIN-SECRET');
  expect(late.request).not.toContain('PRE-JOIN-SECRET');
  expect(JSON.parse(late.request).request).toBe('POST-JOIN-CALL');
  expect(JSON.stringify(context)).not.toContain('visibleFrom');
  expect(first.request).toContain('PRE-JOIN-SECRET');
  expect(state.team.rooms.r!.messages).toHaveLength(2);
});

it('preserves retained member offsets and resets the boundary after leaving and rejoining', () => {
  const { state, advance, membersAs } = setup();
  roomInput(state, 'before', 'r', 'First membership', []);
  membersAs(['b0', 'b1'], 'leave');
  roomInput(state, 'absent', 'r', 'While absent', []);
  membersAs(['b0', 'b1', 'b2'], 'rejoin');
  expect(state.team.rooms.r!.visibleFrom).toEqual({ b0: 0, b1: 0, b2: 2 });
  const round = roomInput(state, 'after', 'r', 'After rejoin', ['b2']); advance();
  const context = turnContext(state, state.turns[state.team.rounds[round]!.seats[0]!]!);
  if (!('room' in context)) throw new Error('Expected room context');
  expect(context.room.messages.map(m => m.text)).toEqual(['After rejoin']);
  expect(state.team.rooms.r!.messages).toHaveLength(3);
});

it('reports required metadata overflow without pruning authority or hard blocking history', () => {
  const { state, advance } = setup();
  const round = roomInput(state, 'metadata', 'r', 'Current', ['b1']); advance();
  state.team.notes = [{ id: 'oversized-import', text: 'x'.repeat(HISTORY_MAX_BYTES) }];
  const context = turnContext(state, state.turns[state.team.rounds[round]!.seats[0]!]!);
  if (!('room' in context)) throw new Error('Expected room context');
  expect(context.room.messages).toEqual([]);
  expect(context.historyWindow.metadataOverBudget).toBe(true);
  expect(context.historyWindow.omittedMessages).toBe(1);
  expect(context.historyWindow.notice).toContain('Earlier history was omitted');
  expect(context.historyWindow.notice).toContain('Required non-history context exceeds');
  expect(context.teamNotes).toEqual(state.team.notes);
});

it('keeps exactly the newest 100 small private turns independently of the byte limit', () => {
  const { state } = setup();
  for (let i = 0; i < 150; i++) state.turns[`old-${i}`] = { id: `old-${i}`, root: `old-${i}`, botId: 'b1',
    source: 'user', request: 'Small', hop: 0, status: 'succeeded' };
  const turn: Turn = { id: 'current', root: 'current', botId: 'b1', source: 'user', request: 'Current', hop: 0, status: 'queued' };
  const context = turnContext(state, turn);
  if (!('turns' in context)) throw new Error('Expected private context');
  expect(context.turns).toHaveLength(100);
  expect(context.turns[0]!.id).toBe('old-50');
  expect(context.turns.at(-1)!.id).toBe('old-149');
  expect(context.historyWindow.omittedTurns).toBe(50);
});

it('does not claim an invisible pre-join request is present when a pass calls a later member', () => {
  const { state, advance, membersAs } = setup(['b0', 'b1']);
  const round = roomInput(state, 'old-root', 'r', 'PRE-JOIN-REQUEST', ['b0']); advance();
  const first = state.turns[state.team.rounds[round]!.seats[0]!]!;
  membersAs(['b0', 'b1', 'b2'], 'join');
  applySpeech(state, first, { speech: { kind: 'pass' }, room_call: { members: ['b2'] } }, 'call', 0, (_kind, work) => work());
  for (let i = 0; i < 101; i++) roomInput(state, `background-${i}`, 'r', `After join ${i}`, []);
  advance();
  const late = state.turns[state.team.rounds[round]!.seats[1]!]!;
  const context = turnContext(state, late);
  expect(JSON.parse(late.request)).not.toHaveProperty('request');
  expect(JSON.stringify(context)).not.toContain('PRE-JOIN-REQUEST');
  expect(JSON.stringify(context)).not.toContain('visibleFrom');
  expect(context.historyWindow.notice).toBe('Earlier history was omitted.');
});

it('keeps an autonomous caller post in the frozen Request even after it leaves the recent message window', () => {
  const { state, advance, membersAs } = setup(['b0', 'b1']);
  const round = roomInput(state, 'old-root', 'r', 'PRE-JOIN-REQUEST', ['b0']); advance();
  const seatId = state.team.rounds[round]!.seats[0]!;
  membersAs(['b0', 'b1', 'b2'], 'join');
  Object.assign(state.team.seats[seatId]!, { status: 'late', released: true, late: true });
  state.team.rounds[round]!.closed = true;
  applySpeech(state, state.turns[seatId]!, { speech: { kind: 'post', text: 'CURRENT CALLER REQUEST' }, room_call: { members: ['b2'] } },
    'autonomous-call', 0, (_kind, work) => work());
  for (let i = 0; i < 101; i++) roomInput(state, `background-${i}`, 'r', `New background ${i}`, []);
  advance();
  const called = Object.values(state.turns).find(t => t.botId === 'b2')!;
  const context = turnContext(state, called);
  if (!('room' in context)) throw new Error('Expected room context');
  expect(JSON.parse(called.request)).toMatchObject({ request: 'CURRENT CALLER REQUEST', requestFrom: 'b0' });
  expect(context.room.messages).toHaveLength(100);
  expect(context.room.messages.some(message => message.text === 'CURRENT CALLER REQUEST')).toBe(false);
  expect(context.historyWindow.omittedMessages).toBe(2);
  expect(JSON.stringify(context)).not.toContain('PRE-JOIN-REQUEST');
  expect(JSON.stringify(context)).not.toContain('visibleFrom');
});


it('inherits the visible caller post when an intermediate member passes and calls another member', () => {
  const { state, advance } = setup();
  const round = roomInput(state, 'root', 'r', 'Older root request', ['b0']); advance();
  const first = state.turns[state.team.rounds[round]!.seats[0]!]!;
  applySpeech(state, first, { speech: { kind: 'post', text: 'Current caller post' }, room_call: { members: ['b1'] } },
    'first-call', 0, (_kind, work) => work());
  advance();
  const middle = state.turns[state.team.rounds[round]!.seats[1]!]!;
  applySpeech(state, middle, { speech: { kind: 'pass' }, room_call: { members: ['b2'] } },
    'pass-call', 0, (_kind, work) => work());
  advance();
  const last = state.turns[state.team.rounds[round]!.seats[2]!]!;
  expect(JSON.parse(last.request)).toMatchObject({ request: 'Current caller post', requestFrom: 'b0' });
  expect(state.team.rooms.r!.messages).toHaveLength(2);
});

it('admits a current Request at the UTF-8 limit and refuses one extra emoji without changing history', () => {
  const { state } = setup();
  const turn: Turn = { id: 'boundary', root: 'boundary', botId: 'b1', source: 'user',
    request: '😀'.repeat(HISTORY_MAX_BYTES / 4), hop: 0, status: 'queued' };
  state.turns[turn.id] = turn;
  const saved = structuredClone(state);
  const context = turnContext(state, turn);
  expect(context.historyWindow.currentRequestBytes).toBe(HISTORY_MAX_BYTES);
  expect(context.historyWindow.metadataOverBudget).toBe(true);
  expect(context.historyWindow.notice).toContain('Required non-history context exceeds');
  expect(state).toEqual(saved);
  expect(() => turnContext(state, { ...turn, request: turn.request + '😀' }))
    .toThrow(`Current Request is ${HISTORY_MAX_BYTES + 4} UTF-8 bytes; budget is ${HISTORY_MAX_BYTES} bytes`);
  expect(state).toEqual(saved);
});
