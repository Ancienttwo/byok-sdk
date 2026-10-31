import { describe, expect, it } from 'vitest';
import {
  TRANSITIONS,
  reduce,
  transitionTable,
  type ReducerEventType,
  type TaskPhase,
} from '../daemon/task-runner/state';
import { ROW_FIXTURES, makeEvent, makeSnapshot } from './fixtures/task-runner-reducer';

const EVENT_TYPES: readonly ReducerEventType[] = [
  'offer.sealed_opening',
  'offer.received',
  'offer.sealed_opened',
  'offer.sealed_declined',
  'admission.begin',
  'admission.stage',
  'admission.declined',
  'admission.claimable',
  'claim.journaled',
  'claim.journal_failed',
  'claim.sent',
  'startup.registered',
  'startup.transferred',
  'startup.disposed',
  'runtime.session_bound',
  'runtime.started',
  'runtime.activation_failed',
  'runtime.start_failed',
  'runtime.run_failed',
  'turn.ended',
  'stream.ended',
  'resource.exceeded',
  'approval.requested',
  'approval.dispatch_next',
  'approval.decided',
  'approval.withdrawn',
  'approval.stale',
  'terminal.requested',
  'terminal.evidence',
  'terminal.envelope_ready',
  'terminal.envelope_failed',
  'terminal.sent',
  'terminal.close',
  'terminal.commit',
  'finish.completed',
  'retry.finalization',
  'cancel.received',
  'steer.received',
  'steer.failed',
  'message.accepted',
  'message.refused',
  'message.send_attempted',
  'shutdown.stop_accepting',
  'shutdown.drain',
  'shutdown.completed',
];

const PHASES: readonly TaskPhase[] = [
  'received',
  'admitting',
  'claiming',
  'claimed',
  'running',
  'awaiting_approval',
  'terminalizing',
  'retiring',
  'finished',
  'declined',
];

describe('TRANSITIONS table contract (#1099 S1)', () => {
  it('has unique row ids and every row declares events, a phase scope and rejection semantics', () => {
    const ids = TRANSITIONS.map(row => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of TRANSITIONS) {
      expect(row.events.length).toBeGreaterThan(0);
      expect(row.rejection.trim().length).toBeGreaterThan(0);
      expect(
        row.phase === '*' || row.phase === 'none' || row.phase.length > 0,
      ).toBe(true);
    }
    expect(transitionTable().every(row => Object.isFrozen(row))).toBe(true);
  });

  it('executes every transition row through its fixture and lands on that exact row', () => {
    for (const row of TRANSITIONS) {
      const fixture = ROW_FIXTURES.get(row.id);
      expect(fixture, 'missing fixture for row ' + row.id).toBeDefined();
      if (fixture === undefined) continue;
      const result = reduce(fixture.snapshot, fixture.event);
      expect(result.rowId, 'fixture for ' + row.id + ' landed on ' + result.rowId).toBe(row.id);
      expect(result.effects.every(effect => effect.id.startsWith(row.id + '#'))).toBe(true);
    }
  });

  it('every row id has a fixture and every fixture id has a row', () => {
    const rowIds = new Set(TRANSITIONS.map(row => row.id));
    for (const id of ROW_FIXTURES.keys()) expect(rowIds.has(id), id).toBe(true);
    for (const id of rowIds) expect(ROW_FIXTURES.has(id), id).toBe(true);
  });

  it('every (event, phase) pair, including no task, matches a row and never throws', () => {
    const snapshots = [
      ...PHASES.map(phase => makeSnapshot({ task: { phase } })),
      makeSnapshot({}),
    ];
    for (const type of EVENT_TYPES) {
      for (const snapshot of snapshots) {
        const event = makeEvent(type);
        const result = reduce(snapshot, event);
        expect(result.rowId.length).toBeGreaterThan(0);
        const phaseLabel = snapshot.task?.phase ?? 'none';
        const matches = TRANSITIONS.filter(row =>
          row.events.includes(type)
          && (row.phase === '*'
            || (row.phase === 'none' ? snapshot.task === undefined : snapshot.task !== undefined && row.phase.includes(snapshot.task.phase)))
          && (row.when === undefined || row.when(snapshot, event)));
        expect(matches.length, type + ' / ' + phaseLabel).toBeGreaterThan(0);
        expect(matches[0]?.id).toBe(result.rowId);
      }
    }
  });

  it('explicit fallbacks are drop/audit only and carry no wire effect', () => {
    for (const row of TRANSITIONS.filter(candidate => candidate.id.startsWith('F-'))) {
      const fixture = ROW_FIXTURES.get(row.id);
      expect(fixture).toBeDefined();
      if (fixture === undefined) continue;
      const result = reduce(fixture.snapshot, fixture.event);
      expect(result.disposition).toBe('dropped');
      expect(result.effects.map(effect => effect.effect.kind)).toEqual(['audit']);
      expect(result.runner).toBe(fixture.snapshot.runner);
      expect(result.task).toBe(fixture.snapshot.task);
    }
  });

  it('fixed rows keep their documented disposition', () => {
    const expected: Readonly<Record<string, 'applied' | 'dropped' | 'rejected' | 'threw'>> = {
      A3: 'rejected',
      C9: 'applied',
      T8: 'threw',
      T5: 'dropped',
      X7: 'dropped',
      X6: 'dropped',
      ST2: 'dropped',
      A11: 'dropped',
      M4: 'dropped',
      SH2: 'dropped',
    };
    for (const [id, disposition] of Object.entries(expected)) {
      const fixture = ROW_FIXTURES.get(id);
      expect(fixture).toBeDefined();
      if (fixture === undefined) continue;
      expect(reduce(fixture.snapshot, fixture.event).disposition, id).toBe(disposition);
    }
  });
});
