import { afterEach, expect, it, vi } from 'vitest';
import * as protocol from '@byok-sdk/protocol';
import { stateOf } from './model';
import { outcomeSchema } from './schema';
import { routineViews } from './routines.test-support';

afterEach(() => vi.restoreAllMocks());

it('retries only schema-over-budget with flat schedules and preserves valid outcomes', () => {
  const compose = vi.spyOn(protocol, 'composeBotTurnOutcomeSchema').mockImplementationOnce(() => {
    throw new protocol.BotTurnOutcomeSchemaError('schema-over-budget', 'injected checked schema cap');
  });
  const schema = outcomeSchema('main', stateOf({}));
  expect(compose).toHaveBeenCalledTimes(2);
  expect(compose.mock.calls[0]![0].create_routine!.items!.properties!.schedule!.oneOf).toBeDefined();
  expect(compose.mock.calls[1]![0].create_routine!.items!.properties!.schedule!.oneOf).toBeUndefined();
  expect(protocol.validateResultOutcome(schema, { create_routine: [{ localId: 'new_routine_1',
    schedule: { minute: 0, hour: 9, tz: 'UTC' }, prompt: 'report' }] }).ok).toBe(true);
});

it.each(['not-subset', 'over-budget'] as const)('reports %s as a Host defect without flat fallback', code => {
  const error = new protocol.BotTurnOutcomeSchemaError(code, 'injected Host defect');
  const compose = vi.spyOn(protocol, 'composeBotTurnOutcomeSchema').mockImplementationOnce(() => { throw error; });
  expect(() => outcomeSchema('main', stateOf({}))).toThrow(error);
  expect(compose).toHaveBeenCalledTimes(1);
});

it('keeps both schema and outcome bounds at the eight-routine limit, with self delegation only', () => {
  const routines = routineViews('main', 8, 'report');
  const schema = outcomeSchema('main', stateOf({}), undefined, ['default'], routines);
  expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThanOrEqual(protocol.RESULT_SCHEMA_MAX_BYTES);
  expect(protocol.resultOutcomeMaxBytes(schema)).toBeLessThanOrEqual(protocol.RESULT_OUTCOME_MAX_BYTES);
  expect(schema.properties!.delegate!.items!.properties!.to!.enum).toEqual(['main']);
  expect(schema.properties!.update_routine!.items!.properties!.routineId!.enum).toEqual(routines.map(routine => routine.id));
});
