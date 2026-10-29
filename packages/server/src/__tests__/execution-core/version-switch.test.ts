import { expect, it } from 'vitest';
import type { Occurrence, Routine, RoutineDefinition } from '../../execution-core/model';
import { versionSwitchDue } from '../../execution-core/routines';

// The switch rule is pure: no HostLedger, server or clock.
const definition = (version: number): RoutineDefinition => ({ id: 'watch', version, timeZone: 'UTC',
  rule: { anchorMs: 0, everyMs: 60_000 }, hostJob: { type: 'watchlist', input: { list: 'abc' } }, waitMs: 60_000, lateAfterMs: 1000 });
const routine = (rest: Partial<Routine> = {}): Routine => ({ definition: definition(1), pending: definition(2),
  lifecycle: 'active', status: 'ok', next: { dedupKey: 'watch:1:120000', availableAt: 120_000 }, ...rest });
const occurrence = (rest: Partial<Occurrence> = {}): Occurrence => ({ key: 'occurrence', routineId: 'watch', definitionVersion: 1,
  trigger: { kind: 'scheduled', plannedAt: 60_000 }, wakeKey: 'watch:1:60000', recordedAt: 60_000, nextAt: null, attempts: 0, ...rest });

it.each([
  ['a staged version with a future old slot', routine(), [], true],
  ['a staged version with no reserved slot', routine({ next: null }), [], true],
  ['settled occurrences only', routine(), [occurrence({ conclusion: 'succeeded' }), occurrence({ conclusion: 'superseded' })], true],
  ['unsettled work of another routine', routine(), [occurrence({ routineId: 'other' })], true],
  ['no staged version', routine({ pending: undefined }), [], false],
  ['a paused routine', routine({ lifecycle: 'paused', next: null }), [], false],
  ['a completed routine', routine({ lifecycle: 'completed', next: null }), [], false],
  ['an unsettled occurrence', routine(), [occurrence()], false],
  ['an unsettled occurrence of an older version', routine({ definition: definition(2), pending: definition(3) }),
    [occurrence({ definitionVersion: 1 })], false],
  ['an old slot due at exactly now', routine({ next: { dedupKey: 'watch:1:100000', availableAt: 100_000 } }), [], false],
] as const)('versionSwitchDue at 100000 ms: %s', (_case, row, rows, due) => {
  expect(versionSwitchDue(row, rows, 100_000)).toBe(due);
});
