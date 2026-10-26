import { expect, it } from 'vitest';
import { frozenInput, hash, isOccurrenceIntentKey, occurrenceIntentKey, parseRoutineWakeKey, routineWakeKey, taskId } from './index';
import { template } from './test-support';

// #975: the K4 encodings that a switch export derives again, exported so no other module spells them.
it('writes a routine wake key that parseRoutineWakeKey reads back', () => {
  expect(routineWakeKey('routine:a', 2, 1000)).toBe('routine:a:2:1000');
  expect(parseRoutineWakeKey(routineWakeKey('routine:a', 2, 1000))).toEqual({ id: 'routine:a', version: 2, at: 1000 });
});

it('names a routine occurrence intent by its occurrence key, and tells it from a Host key', () => {
  const key = hash(['routine', 1, 'slot']);
  expect(occurrenceIntentKey(key)).toBe(`occurrence:${key}`);
  expect(isOccurrenceIntentKey(occurrenceIntentKey(key))).toBe(true);
  for (const other of ['occurrence:', `occurrence:${key.toUpperCase()}`, `occurrence:${key}0`, key, 'k1']) expect(isOccurrenceIntentKey(other), other).toBe(false);
});

it('freezes one generation as a copy of the execution with its task id', () => {
  const execution = template('device'), task = taskId('k1', 1);
  const input = frozenInput(execution, task);
  expect(input).toEqual({ ...execution, taskId: task });
  (input.payload as { instruction: string }).instruction = 'changed';
  expect(execution.payload.instruction).not.toBe('changed');
});
