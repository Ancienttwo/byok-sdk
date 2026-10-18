import { expect, it } from 'vitest';
import { MAX_FUTURE_MS } from '@byok-sdk/server';
import { ROUTINE_HORIZON_MS } from '@byok-sdk/core';
import { WAKE_HORIZON_MS } from '../../host-execution-core/src/routines';
import { stateOf } from './model';
import { arm, consumeRoutine, createRoutine, lifecycle, updateRoutine } from './routines';
import { outcomeSchema } from './schema';
import { validateResultOutcome } from '@byok-sdk/protocol';

const now = Date.UTC(2026, 9, 19, 8);
const schedule = { minute: 0, hour: 9, tz: 'UTC' };
function setup() {
  const state = stateOf({});
  const routine = createRoutine(state, 'main', 'task-1', 0, { localId: 'new_routine_1', schedule, prompt: 'old prompt' }, now);
  const deliver = (slot = routine.armed!, deliveredAt = slot.at) => consumeRoutine(state, {
    wakeId: 'wake', dedupKey: slot.key, availableAt: slot.at, deliveredAt, delivery: 1,
  }, deliveredAt, () => {});
  return { state, routine, deliver };
}

it('keeps the SDK, routine calendar and K4 horizon at 368 days', () => {
  expect(WAKE_HORIZON_MS).toBe(368 * 86_400_000);
  expect(WAKE_HORIZON_MS).toBe(MAX_FUTURE_MS);
  expect(WAKE_HORIZON_MS).toBe(ROUTINE_HORIZON_MS);
});

it('offers all ordinary Bot actions and rejects a target field', () => {
  const { state, routine } = setup();
  const schema = outcomeSchema('main', state);
  expect(Object.keys(schema.properties!)).toEqual(['delegate', 'ask_user', 'confirmable_action', 'create_routine', 'update_routine', 'cancel_routine']);
  expect(validateResultOutcome(schema, { create_routine: [{ localId: 'new_routine_1', schedule, prompt: 'test', target: 'other' }] }).ok).toBe(false);
  expect(validateResultOutcome(schema, { delegate: [{ to: 'other', request: 'test' }] }).ok).toBe(false);
  expect(validateResultOutcome(schema, { update_routine: [{ routineId: routine.id, prompt: 'new' }] }).ok).toBe(true);
});

it('holds a due undelivered slot on update and uses its old snapshot', () => {
  const { state, routine, deliver } = setup();
  const slot = routine.armed!;
  updateRoutine(state, 'main', { routineId: routine.id, prompt: 'new prompt' }, slot.at + 1);
  expect(routine).toMatchObject({ current: 1, pending: 2, generation: 1, armed: slot });
  deliver(slot, slot.at + 120_000);
  const occurrence = structuredClone(state.occurrences[slot.key]);
  expect(occurrence).toMatchObject({ decision: 'run', trigger: 'catch_up', definition: { version: 1, prompt: 'old prompt' } });
  expect(routine.armed).toBeNull();
  deliver(slot, slot.at + 86_400_000);
  expect(state.occurrences[slot.key]).toEqual(occurrence);
  expect(routine.inflight).toEqual([slot.key]);
});

it('limits admission to two and stops the old chain when an update waits', () => {
  const { state, routine, deliver } = setup();
  deliver(); deliver();
  const third = routine.armed!;
  deliver(third);
  expect(routine.inflight).toHaveLength(2);
  expect(state.occurrences[third.key]?.decision).toBe('capacity');
  updateRoutine(state, 'main', { routineId: routine.id, prompt: 'pending prompt' }, third.at + 1);
  deliver();
  expect(routine.inflight).toHaveLength(2);
  expect(routine.armed).toBeNull();
  expect(routine.current).toBe(1);
  expect(routine.pending).toBe(2);
});

it('resumes the current version while pending work is unsettled', () => {
  const { state, routine, deliver } = setup();
  deliver();
  updateRoutine(state, 'main', { routineId: routine.id, prompt: 'pending' }, now + 3_600_001);
  lifecycle(state, routine, 'paused', now + 3_600_002);
  lifecycle(state, routine, 'active', now + 3_600_003);
  expect(routine).toMatchObject({ current: 1, pending: 2, generation: 3, armed: { version: 1 } });
  expect(routine.inflight).toHaveLength(1);
  expect(state.operations.map(op => op.sequence)).toEqual(state.operations.map((_, i) => i + 1));
});

it('cancels new occurrences and retains unsettled work', () => {
  const { state, routine, deliver } = setup();
  deliver(); const successor = routine.armed!;
  lifecycle(state, routine, 'completed', now + 3_600_001);
  deliver(successor);
  expect(state.occurrences[successor.key]?.decision).toBe('skipped');
  expect(routine.inflight).toHaveLength(1);
  expect(routine.armed).toBeNull();
});

it('switches immediately when idle and fences a late old hook', () => {
  const { state, routine, deliver } = setup();
  const old = routine.armed!;
  updateRoutine(state, 'main', { routineId: routine.id, prompt: 'v2' }, now + 1);
  updateRoutine(state, 'main', { routineId: routine.id, prompt: 'v3' }, now + 2);
  expect(routine).toMatchObject({ current: 3, pending: null, generation: 3 });
  deliver(old);
  expect(state.occurrences[old.key]?.decision).toBe('superseded');
  expect(routine.inflight).toEqual([]);
  expect(routine.versions[1]?.prompt).toBe('old prompt');
});

it('does not commit an invalid update and audits calendar errors', () => {
  const { state, routine } = setup();
  expect(() => updateRoutine(state, 'main', { routineId: routine.id, schedule: { ...schedule, dayOfMonth: 31, month: 4 } }, now)).toThrow('schedule_unreachable');
  expect(routine.pending).toBeNull();
  expect(Object.keys(routine.versions)).toEqual(['1']);
  arm(state, routine, Date.UTC(2300, 0, 1), now);
  expect(routine).toMatchObject({ armed: null, status: 'calendar_error' });
  expect(routine.errors).toHaveLength(1);
  arm(state, routine, now, now);
  expect(routine.status).toBe('ok');
});
