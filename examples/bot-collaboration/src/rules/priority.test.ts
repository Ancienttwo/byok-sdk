import { expect, it } from 'vitest';
import { DEVICE_CONCURRENCY, USER_RESERVED_SLOTS, admitDeviceSlot, isUnsubmitted, userFirst, type DispatchIntent, type QueuedIntent } from './priority';

const row = (id: string, sequence: number, rest: Partial<QueuedIntent> = {}): QueuedIntent =>
  ({ id, agent: 'agent-a', sequence, phase: 'queued', attempts: 0, ...rest });
const dispatch = (id: string, source: DispatchIntent['source'], deviceId = 'device', occupies = false): DispatchIntent =>
  ({ id, agent: 'agent-a', sequence: 1, phase: 'queued', attempts: 0, source, deviceId, occupies });

it('puts a user intent ahead of the queued, never-submitted routine and bot_request intents of its Agent FIFO', () => {
  const inflight = row('inflight', 1, { phase: 'inflight', attempts: 1 });
  const routine = row('routine', 2), request = row('request', 3), user = row('user', 4), other = row('other', 5, { agent: 'agent-b' });
  const rows = [inflight, routine, request, user, other];
  const plan = userFirst(rows, 'user', new Set(['routine', 'request']), 5)!;
  expect(plan.assignments).toEqual([{ id: 'user', sequence: 6 }, { id: 'routine', sequence: 7 }, { id: 'request', sequence: 8 }]);
  expect(plan.sequence).toBe(8);
  // Neither a submitted intent nor another Agent's FIFO moves.
  expect(plan.assignments.some(entry => entry.id === 'inflight' || entry.id === 'other')).toBe(false);
});

it('keeps the order of the user intents and of the autonomous intents among themselves', () => {
  const first = row('routine-1', 1), user1 = row('user-1', 2), second = row('routine-2', 3), user2 = row('user-2', 4);
  const plan = userFirst([first, user1, second, user2], 'user-2', new Set(['routine-1', 'routine-2']), 4)!;
  expect(plan.assignments.map(entry => entry.id)).toEqual(['user-1', 'user-2', 'routine-1', 'routine-2']);
  expect(plan.assignments.map(entry => entry.sequence)).toEqual([5, 6, 7, 8]);
});

it('changes nothing when the order already holds, or when the user intent is not queued and unsubmitted', () => {
  expect(userFirst([row('user', 1), row('routine', 2)], 'user', new Set(['routine']), 2)).toBeUndefined();
  expect(userFirst([row('routine', 1), row('user', 2, { phase: 'inflight', attempts: 1 })], 'user', new Set(['routine']), 2)).toBeUndefined();
  expect(userFirst([row('routine', 1), row('user', 2, { attempts: 1 })], 'user', new Set(['routine']), 2)).toBeUndefined();
  expect(userFirst([row('routine', 1)], 'missing', new Set(['routine']), 1)).toBeUndefined();
});

it('moves no intent that a submit already began, and counts only queued intents as movable', () => {
  expect(isUnsubmitted({ phase: 'queued', attempts: 0 })).toBe(true);
  for (const fact of [{ phase: 'queued', attempts: 1 }, { phase: 'inflight', attempts: 1 }, { phase: 'backoff', attempts: 1 }, { phase: 'memory_blocked', attempts: 0 }]) {
    expect(isUnsubmitted(fact)).toBe(false);
  }
});

it('reserves one device slot for user work, and never moves a submitted intent to make room', () => {
  expect(DEVICE_CONCURRENCY).toBe(8);
  expect(USER_RESERVED_SLOTS).toBe(1);
  const occupied = dispatch('running', 'routine', 'device', true);
  expect(admitDeviceSlot(dispatch('next-bot', 'bot'), [occupied], 2)).toBe(false);
  expect(admitDeviceSlot(dispatch('next-user', 'user'), [occupied], 2)).toBe(true);
  // The intent itself is never counted, so the check is the same before and after it becomes in-flight.
  const start = dispatch('start', 'user');
  expect(admitDeviceSlot(start, [start], 1)).toBe(true);
  // A limit of 1 has no spare slot, so it disables the reservation instead of starving autonomous work.
  expect(admitDeviceSlot(dispatch('solo', 'routine'), [], 1)).toBe(true);
  expect(admitDeviceSlot(dispatch('solo', 'routine'), [occupied], 1)).toBe(false);
  // Another device is not counted.
  expect(admitDeviceSlot(dispatch('next-bot', 'routine', 'device-b'), [occupied], 1)).toBe(true);
  expect(() => admitDeviceSlot(dispatch('x', 'user'), [], 0)).toThrow('positive safe integer');
});