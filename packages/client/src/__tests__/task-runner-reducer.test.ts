import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_PENDING_APPROVALS_PER_TASK,
  TRANSITIONS,
  createTaskState,
  reduce,
  serialize,
  stateBytes,
  transitionTable,
  type EffectEnvelope,
  type ReducerEvent,
  type ReduceResult,
  type ReducerSnapshot,
  type TaskStateV1,
} from '../daemon/task-runner/state';
import {
  makeEvent,
  makeSnapshot,
  makeTask,
  terminalState,
} from './fixtures/task-runner-reducer';

function apply(snapshot: ReducerSnapshot, event: ReducerEvent): ReduceResult {
  return reduce(snapshot, event);
}

function snapshotOf(result: ReduceResult): ReducerSnapshot {
  return {
    runner: result.runner,
    ...(result.task === undefined ? {} : { task: result.task }),
  };
}

function kinds(effects: readonly EffectEnvelope[]): string[] {
  return effects.map(effect => effect.effect.kind);
}

function deepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (!Object.isFrozen(value)) return false;
  return Object.values(value as Record<string, unknown>).every(deepFrozen);
}

/**
 * Reducer-level executor model for ordering tests only. It models exactly the
 * #1218 rules: every event for one task is FIFO; a barrier completion is
 * appended at the tail by the host when it settles; atomic effects and their
 * synchronous completion events form a group no queued event can enter.
 */
class ReducerQueue {
  snapshot: ReducerSnapshot;
  readonly rows: string[] = [];
  readonly effects: EffectEnvelope[] = [];

  constructor(snapshot: ReducerSnapshot) {
    this.snapshot = snapshot;
  }

  dispatch(event: ReducerEvent): void {
    this.queue.push(event);
  }

  drain(): void {
    while (this.queue.length > 0) {
      const event = this.queue.shift();
      if (event === undefined) break;
      this.apply(event);
    }
  }

  private readonly queue: ReducerEvent[] = [];

  private apply(event: ReducerEvent): void {
    const result = reduce(this.snapshot, event);
    this.rows.push(result.rowId);
    this.snapshot = snapshotOf(result);
    this.effects.push(...result.effects);
    for (const effect of result.effects) {
      if (effect.mode !== 'atomic' || effect.completion === undefined) continue;
      this.apply({
        ...effect.completion,
        atMs: event.atMs,
        taskId: event.taskId,
      } as ReducerEvent);
    }
  }
}

describe('task-runner reducer core (#1099 S1)', () => {
  it('drives offer → admission → claim → started with the documented effect order', () => {
    let snapshot = makeSnapshot({});
    const first = apply(snapshot, makeEvent('offer.received', { offer: makeTask().offer }));
    expect(first.rowId).toBe('O1');
    expect(first.task?.phase).toBe('received');
    expect(first.task?.revision).toBe(1);
    snapshot = snapshotOf(first);

    for (const [event, rowId] of [
      [makeEvent('admission.begin'), 'O3'],
      [makeEvent('admission.stage', { stage: 'home' }), 'O4'],
      [makeEvent('admission.stage', { stage: 'limits' }), 'O4'],
      [makeEvent('admission.stage', { stage: 'runtime' }), 'O4'],
      [makeEvent('admission.stage', { stage: 'workspace' }), 'O4'],
      [makeEvent('admission.stage', { stage: 'manifest' }), 'O4'],
      [makeEvent('admission.claimable'), 'C1'],
    ] as const) {
      const result = apply(snapshot, event);
      expect(result.rowId, event.type).toBe(rowId);
      snapshot = snapshotOf(result);
    }
    expect(snapshot.task?.phase).toBe('claiming');
    expect(snapshot.task?.claim).toEqual({ journaled: false, sent: false });

    const journaled = apply(snapshot, makeEvent('claim.journaled'));
    expect(journaled.rowId).toBe('C2');
    expect(kinds(journaled.effects)).toEqual(['send.claim']);
    expect(journaled.effects[0]?.mode).toBe('atomic');
    expect(journaled.effects[0]?.completion?.type).toBe('claim.sent');
    snapshot = snapshotOf(journaled);

    const sent = apply(snapshot, makeEvent('claim.sent'));
    expect(sent.rowId).toBe('C3');
    expect(sent.task?.phase).toBe('claimed');
    expect(sent.task?.claim.sent).toBe(true);
    expect(kinds(sent.effects)).toEqual(['start.runtime']);
    snapshot = snapshotOf(sent);

    const bound = apply(snapshot, makeEvent('runtime.session_bound', {
      execution: {
        sessionRef: 'session-1', runtimeId: 'pi', home: '/h', cwd: '/w',
        leaseId: 'l1', startedAtMs: 90,
      },
    }));
    expect(bound.rowId).toBe('C4');
    expect(kinds(bound.effects)).toEqual(['bind.session', 'persist.handoff', 'activate.message']);
    snapshot = snapshotOf(bound);

    const started = apply(snapshot, makeEvent('runtime.started'));
    expect(started.rowId).toBe('C5');
    expect(started.task?.phase).toBe('running');
    expect(started.task?.execution?.sessionRef).toBe('session-1');
    expect(kinds(started.effects)).toEqual([
      'send.started', 'register.active', 'arm.max_duration', 'start.pump',
    ]);
    expect(started.effects.every(effect => effect.mode === 'atomic')).toBe(true);
    expect(started.task?.revision).toBe((snapshot.task?.revision ?? 0) + 1);
  });

  it('reduces a cancel during the claim journal before claim.journaled and never sends task.claim (#1218, X2a)', () => {
    let snapshot = makeSnapshot({ task: { phase: 'claiming' } });
    const cancelled = apply(snapshot, makeEvent('cancel.received', { reason: 'wire cancel' }));
    expect(cancelled.rowId).toBe('X2a');
    expect(cancelled.task?.phase).toBe('declined');
    expect(cancelled.task?.terminal?.kind).toBe('declined');
    expect(cancelled.task?.terminal?.reason).toBe('cancelled before claim: wire cancel');
    expect(cancelled.task?.terminal?.retryable).toBe(false);
    expect(kinds(cancelled.effects)).not.toContain('send.claim');
    expect(kinds(cancelled.effects)).toContain('send.decline');
    expect(kinds(cancelled.effects)).toContain('consume.pendingCancelled');
    snapshot = snapshotOf(cancelled);

    const lateJournal = apply(snapshot, makeEvent('claim.journaled'));
    expect(lateJournal.rowId).toBe('F-CLAIM');
    expect(lateJournal.disposition).toBe('dropped');
    expect(lateJournal.task?.claim.journaled).toBe(false);
    expect(kinds(lateJournal.effects)).toEqual(['audit']);
    expect(lateJournal.task?.revision).toBe(snapshot.task?.revision);
  });

  it('declines retryably when the claim journal fails, without sending task.claim (#1217)', () => {
    const result = apply(makeSnapshot({ task: { phase: 'claiming' } }), makeEvent('claim.journal_failed', {
      reason: 'claim journal unavailable: disk full',
      retryable: true,
    }));
    expect(result.rowId).toBe('C9');
    expect(result.disposition).toBe('applied');
    expect(result.task?.phase).toBe('declined');
    expect(result.task?.terminal?.kind).toBe('declined');
    expect(result.task?.terminal?.retryable).toBe(true);
    expect(result.task?.claim.sent).toBe(false);
    expect(kinds(result.effects)).toContain('send.decline');
    expect(kinds(result.effects)).not.toContain('send.claim');
    expect(result.effects.find(effect => effect.effect.kind === 'send.decline')?.effect.retryable).toBe(true);
  });

  it('appends a barrier completion at the queue tail instead of the front (#1218)', () => {
    const queue = new ReducerQueue(makeSnapshot({ task: { phase: 'claiming' } }));
    // The cancel arrives while beforeClaim is in flight; the journal barrier
    // completes afterwards, so its completion event lands behind the cancel.
    queue.dispatch(makeEvent('cancel.received', { reason: 'stop' }));
    queue.dispatch(makeEvent('claim.journaled'));
    queue.drain();
    expect(queue.rows).toEqual(['X2a', 'F-CLAIM']);
    expect(queue.effects.some(effect => effect.effect.kind === 'send.claim')).toBe(false);
    expect(queue.snapshot.task?.phase).toBe('declined');
  });

  it('keeps the atomic journaled → send.claim group uninterruptible (#1218)', () => {
    const queue = new ReducerQueue(makeSnapshot({ task: { phase: 'claiming' } }));
    queue.dispatch(makeEvent('claim.journaled'));
    queue.dispatch(makeEvent('cancel.received', { reason: 'stop' }));
    queue.drain();
    // claim.journaled → send.claim → claim.sent happen first; the cancel then
    // sees a claimed task (X3b), never the pre-claim X2a row.
    expect(queue.rows).toEqual(['C2', 'C3', 'X3b']);
    expect(queue.snapshot.task?.phase).toBe('claimed');
    expect(queue.snapshot.task?.claim.sent).toBe(true);
    expect(queue.effects.some(effect => effect.effect.kind === 'send.decline')).toBe(false);
  });

  it('never sends task.started when a cancel is reduced before runtime.started (#1218, C6)', () => {
    const queue = new ReducerQueue(makeSnapshot({ task: { phase: 'claimed' } }));
    queue.dispatch(makeEvent('cancel.received', { reason: 'stop' }));
    queue.dispatch(makeEvent('runtime.session_bound'));
    queue.dispatch(makeEvent('runtime.started'));
    queue.drain();
    expect(queue.rows).toEqual(['X3b', 'C4', 'C6']);
    expect(queue.effects.some(effect => effect.effect.kind === 'send.started')).toBe(false);
    expect(queue.snapshot.task?.phase).toBe('terminalizing');
    expect(queue.snapshot.task?.terminal?.kind).toBe('cancelled');
    expect(queue.snapshot.task?.terminal?.reason).toBe('stop');
  });

  it('runs the started atomic group before a queued cancel is reduced', () => {
    const queue = new ReducerQueue(makeSnapshot({ task: { phase: 'claimed' } }));
    queue.dispatch(makeEvent('runtime.started'));
    queue.dispatch(makeEvent('cancel.received', { reason: 'stop' }));
    queue.drain();
    expect(queue.rows).toEqual(['C5', 'X4']);
    expect(queue.effects.some(effect => effect.effect.kind === 'send.started')).toBe(true);
    expect(queue.snapshot.task?.phase).toBe('terminalizing');
  });

  it('queues approvals FIFO and rejects the request past the per-task ceiling', () => {
    let snapshot = makeSnapshot({ task: { phase: 'running', teardown: { batcher: 'running' } } });
    const first = apply(snapshot, makeEvent('approval.requested', {
      approvalId: 'a1', requestId: 'r1', kind: 'task-terminal',
    }));
    expect(first.rowId).toBe('A1');
    expect(first.task?.phase).toBe('awaiting_approval');
    expect(first.task?.approval.pending?.requestId).toBe('r1');
    expect(kinds(first.effects)).toEqual([
      'audit', 'flush.batcher', 'send.approval_request', 'register.approval', 'arm.approval_timeout',
    ]);
    snapshot = snapshotOf(first);

    for (let index = 2; index <= 1 + MAX_PENDING_APPROVALS_PER_TASK; index += 1) {
      const queued = apply(snapshot, makeEvent('approval.requested', {
        approvalId: 'a' + String(index),
        requestId: 'r' + String(index),
        kind: 'tool-authorization',
      }));
      expect(queued.rowId).toBe('A2');
      snapshot = snapshotOf(queued);
    }
    expect(snapshot.task?.approval.queue).toHaveLength(MAX_PENDING_APPROVALS_PER_TASK);

    const overflow = apply(snapshot, makeEvent('approval.requested', {
      approvalId: 'a99', requestId: 'r99', kind: 'tool-authorization',
    }));
    expect(overflow.rowId).toBe('A3');
    expect(overflow.disposition).toBe('rejected');
    expect(kinds(overflow.effects)).toEqual(['resolve.approval_promise']);
    expect(overflow.task?.approval.queue).toHaveLength(MAX_PENDING_APPROVALS_PER_TASK);

    const decided = apply(snapshot, makeEvent('approval.decided', {
      approvalId: 'a1', decision: 'approve', origin: 'in-process',
    }));
    expect(decided.rowId).toBe('A5');
    expect(kinds(decided.effects)).toEqual([
      'clear.timeout', 'send.approval_resolved', 'resolve.approval_promise', 'dispatch.next_approval',
    ]);
    expect(decided.task?.approval.pending).toBeUndefined();
    const dispatched = apply(snapshotOf(decided), makeEvent('approval.dispatch_next'));
    expect(dispatched.rowId).toBe('A4');
    expect(dispatched.task?.approval.pending?.requestId).toBe('r2');
    expect(dispatched.task?.approval.queue).toHaveLength(MAX_PENDING_APPROVALS_PER_TASK - 1);
  });

  it('keeps the first terminal and never rebuilds it', () => {
    let snapshot = makeSnapshot({ task: { phase: 'running', claim: { journaled: true, sent: true } } });
    const failed = apply(snapshot, makeEvent('terminal.requested', {
      kind: 'failed', reason: 'runtime exploded', retryable: true,
    }));
    expect(failed.rowId).toBe('T3');
    expect(failed.task?.phase).toBe('terminalizing');
    const token = failed.task?.terminal?.token;
    expect(token).toBeDefined();
    snapshot = snapshotOf(failed);

    const second = apply(snapshot, makeEvent('terminal.requested', {
      kind: 'complete', reason: 'late success',
    }));
    expect(second.rowId).toBe('T5');
    expect(second.disposition).toBe('dropped');
    expect(second.task?.terminal).toEqual(failed.task?.terminal);
    expect(kinds(second.effects)).toEqual(['audit']);

    const evidence = apply(snapshot, makeEvent('terminal.evidence', { token, ok: false }));
    expect(evidence.rowId).toBe('T6');
    expect(evidence.task?.terminal?.evidence).toBe('degraded');
    snapshot = snapshotOf(evidence);

    const ready = apply(snapshot, makeEvent('terminal.envelope_ready', { token }));
    expect(ready.rowId).toBe('T7');
    expect(kinds(ready.effects)).toEqual(['send.terminal']);
    snapshot = snapshotOf(ready);

    const sent = apply(snapshot, makeEvent('terminal.sent', { token }));
    expect(sent.rowId).toBe('T9');
    expect(sent.task?.phase).toBe('retiring');
    expect(kinds(sent.effects)).toEqual(['mark.finished', 'await.close']);
    snapshot = snapshotOf(sent);

    const closed = apply(snapshot, makeEvent('terminal.close', { token, ok: true }));
    expect(closed.rowId).toBe('T10');
    snapshot = snapshotOf(closed);

    const committed = apply(snapshot, makeEvent('terminal.commit', { token, ok: true }));
    expect(committed.rowId).toBe('T12');
    expect(kinds(committed.effects)).toEqual([
      'publish.record', 'snapshot.memory', 'persist.handoff',
      'release.lease', 'release.pin', 'delete.contexts', 'finish',
    ]);
    expect(committed.effects.slice(0, 3).every(effect => effect.mode === 'bestEffort')).toBe(true);
    expect(committed.effects.slice(3, 5).every(effect => effect.mode === 'barrier')).toBe(true);
    snapshot = snapshotOf(committed);

    const finished = apply(snapshot, makeEvent('finish.completed'));
    expect(finished.rowId).toBe('T15');
    expect(finished.task).toBeUndefined();
    expect(finished.runner.finished).toContain('t1');

    const late = apply(snapshotOf(finished), makeEvent('terminal.requested', { kind: 'failed' }));
    expect(late.rowId).toBe('FINISHED-TASK');
    expect(late.disposition).toBe('dropped');
  });

  it('omits optional fields instead of writing undefined', () => {
    const gate = apply(
      makeSnapshot({ task: { phase: 'running', offer: { message: { required: true } } } }),
      makeEvent('turn.ended'),
    );
    expect(gate.rowId).toBe('T1');
    expect(gate.task?.completion).toBeDefined();
    const accepted = apply(
      snapshotOf(gate),
      makeEvent('message.accepted', { completionToken: gate.task?.completion?.token }),
    );
    expect(accepted.rowId).toBe('M1');
    expect(Object.hasOwn(accepted.task ?? {}, 'completion')).toBe(false);
    expect(serialize(accepted.task)).not.toContain('undefined');
  });

  it('revokes tool authority before aborting or interrupting on cancel (§8.4)', () => {
    const cancelled = apply(makeSnapshot({ task: { phase: 'running' } }), makeEvent('cancel.received', {
      reason: 'wire cancel',
    }));
    expect(cancelled.rowId).toBe('X4');
    expect(kinds(cancelled.effects)[0]).toBe('revoke.host_contexts');
    expect(kinds(cancelled.effects)).toContain('abort.blob');
    expect(kinds(cancelled.effects).indexOf('revoke.host_contexts'))
      .toBeLessThan(kinds(cancelled.effects).indexOf('abort.blob'));
    expect(kinds(cancelled.effects).indexOf('abort.blob'))
      .toBeLessThan(kinds(cancelled.effects).indexOf('interrupt.session'));
  });

  it('drops stale generations, wrong task ids and duplicated events without side effects', () => {
    const snapshot = makeSnapshot({ task: { taskId: 't1', generation: 2, phase: 'running' } });
    const stale = apply(snapshot, makeEvent('cancel.received', { generation: 1 }));
    expect(stale.rowId).toBe('STALE-GENERATION');
    expect(stale.task).toBe(snapshot.task);
    expect(stale.runner).toBe(snapshot.runner);

    const wrong = apply(snapshot, makeEvent('cancel.received', { taskId: 'other' }));
    expect(wrong.rowId).toBe('WRONG-TASK');

    const duplicate = apply(
      makeSnapshot({ task: { phase: 'running', claim: { journaled: true, sent: true } } }),
      makeEvent('claim.sent'),
    );
    expect(duplicate.rowId).toBe('F-CLAIM');
    expect(duplicate.disposition).toBe('dropped');
  });

  it('returns deep-frozen, JSON-round-trippable state and never mutates its input', () => {
    const snapshot = makeSnapshot({
      task: {
        phase: 'terminalizing',
        approval: {
          pending: { approvalId: 'a1', requestId: 'r1', kind: 'task-terminal' },
          queue: Array.from({ length: MAX_PENDING_APPROVALS_PER_TASK }, (_, index) => ({
            requestId: 'r' + String(index + 2),
            kind: 'tool-authorization' as const,
          })),
        },
        terminal: terminalState({
          reason: 'a long but bounded terminal reason',
          retryable: true,
          failureClass: 'runtime',
        }),
      },
    });
    const before = serialize(snapshot);
    const result = apply(snapshot, makeEvent('cancel.received', { reason: 'stop' }));
    expect(serialize(snapshot)).toBe(before);
    expect(deepFrozen(result)).toBe(true);
    expect(deepFrozen(result.runner)).toBe(true);
    expect(result.task === undefined ? true : deepFrozen(result.task)).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(stateBytes(result.task)).toBeLessThanOrEqual(8 * 1024);
    expect(Object.isFrozen(transitionTable())).toBe(true);
    expect(transitionTable()).toBe(TRANSITIONS);
  });

  it('treats unfrozen inputs as read-only too', () => {
    const task = { ...makeTask({ phase: 'running' }) };
    const snapshot = { runner: makeSnapshot({}).runner, task };
    const result = apply(snapshot, makeEvent('cancel.received', { reason: 'stop' }));
    expect(task.phase).toBe('running');
    expect(result.task?.phase).toBe('terminalizing');
  });

  it('has no IO, clock, randomness, Promise or process dependency in state.ts', () => {
    const source = readFileSync(new URL('../daemon/task-runner/state.ts', import.meta.url), 'utf8');
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\bfrom\s+['"]/);
    expect(code).not.toMatch(/\brequire\s*\(/);
    expect(code).not.toMatch(/\b(?:setTimeout|setInterval|setImmediate)\b/);
    expect(code).not.toMatch(/\bDate\b/);
    expect(code).not.toMatch(/\bMath\.random\b/);
    expect(code).not.toMatch(/\b(?:crypto|randomUUID)\b/);
    expect(code).not.toMatch(/\bPromise\b/);
    expect(code).not.toMatch(/\bprocess\./);
    expect(code).not.toMatch(/\bfetch\s*\(/);
  });

  it('fuzzes arbitrary event sequences without a second terminal, an illegal phase or unserializable state', () => {
    let seed = 0x1099;
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const eventTypes = TRANSITIONS.flatMap(row => row.events);
    const phases = new Set<string>([
      'received', 'admitting', 'claiming', 'claimed', 'running',
      'awaiting_approval', 'terminalizing', 'retiring', 'finished', 'declined',
    ]);
    let snapshot = makeSnapshot({ task: { phase: 'running', claim: { journaled: true, sent: true } } });
    let terminalToken: string | undefined = snapshot.task?.terminal?.token;
    let terminalSends = 0;
    for (let step = 0; step < 600; step += 1) {
      const type = eventTypes[Math.floor(random() * eventTypes.length)];
      if (type === undefined) continue;
      const event = makeEvent(type, {
        reason: random() < 0.5 ? undefined : 'fuzz reason',
        retryable: random() < 0.5,
        approvalId: 'a1',
        requestId: 'r1',
        token: snapshot.task?.terminal?.token,
        ok: random() < 0.5,
        decision: random() < 0.5 ? 'approve' : 'reject',
        origin: 'wire',
        completionToken: snapshot.task?.completion?.token,
        kind: random() < 0.5 ? 'failed' : 'complete',
        source: random() < 0.5 ? 'wire' : 'shutdown',
        stage: 'home',
        generation: snapshot.task?.generation,
      });
      const result = reduce(snapshot, event);
      const next = snapshotOf(result);
      if (next.task !== undefined) {
        expect(phases.has(next.task.phase)).toBe(true);
        if (next.task.terminal !== undefined) {
          terminalToken ??= next.task.terminal.token;
          expect(next.task.terminal.token).toBe(terminalToken);
        }
        for (const effect of result.effects) {
          if (effect.effect.kind === 'send.terminal') terminalSends += 1;
        }
      }
      expect(() => serialize(next)).not.toThrow();
      expect(deepFrozen(result)).toBe(true);
      snapshot = next;
      if (snapshot.task === undefined) {
        snapshot = {
          runner: snapshot.runner,
          task: createTaskState({ taskId: 't1', phase: 'running' }),
        };
        terminalToken = undefined;
        terminalSends = 0;
      }
    }
    expect(terminalSends).toBeLessThanOrEqual(1);
  });
});
