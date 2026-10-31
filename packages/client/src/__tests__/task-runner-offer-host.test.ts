// #1099 S3: the offer/admission reducer wiring at the host boundary.
//
// These tests exercise the mailbox and the offer/admission rows directly, so
// they can observe ordering (strict FIFO, barrier completion at the tail,
// atomic groups) without a daemon. The end-to-end equivalence oracles stay
// `handle-offer-characterization` and the `task-runner-*` suites.
import { describe, expect, it } from 'vitest';
import { hostFor, TaskRunnerHost } from '../daemon/task-runner/host';
import { createOfferFacts, type ReducerEvent, type ReducerEventType } from '../daemon/task-runner/state';
import type { TaskRunner } from '../daemon/task-runner';

function makeHost(): { runner: TaskRunner; host: TaskRunnerHost } {
  const runner = {} as TaskRunner;
  const host = hostFor(runner);
  return { runner, host };
}

function event(
  type: ReducerEventType,
  overrides: Omit<Partial<ReducerEvent>, 'type'> = {},
): ReducerEvent {
  return { type, taskId: 't1', atMs: 100, ...overrides };
}

function begin(host: TaskRunnerHost, taskId = 't1', sendDecline?: Parameters<TaskRunnerHost['beginOffer']>[1]) {
  return host.beginOffer(taskId, sendDecline ?? {});
}

function receive(host: TaskRunnerHost, taskId = 't1') {
  return host.dispatchSync(event('offer.received', { taskId, offer: createOfferFacts() }));
}

describe('TaskRunnerHost: offer/admission reducer wiring', () => {
  it('O1 creates the task and a duplicate delivery drops without effects', () => {
    const { host } = makeHost();
    const context = begin(host);
    expect(receive(host).disposition).toBe('applied');
    expect(host.current('t1')?.phase).toBe('received');
    expect(host.current('t1')?.generation).toBe(context.generation);

    const duplicate = receive(host);
    expect(duplicate.disposition).toBe('dropped');
    expect(duplicate.effects.some(effect => effect.effect.kind === 'send.decline')).toBe(false);
    expect(host.current('t1')?.phase).toBe('received');
  });

  it('endOffer archives the state so an ordinary-decline redelivery is processed again', () => {
    const { host } = makeHost();
    begin(host);
    receive(host);
    host.endOffer('t1');
    expect(host.current('t1')).toBeUndefined();
    expect(host.archivedTask('t1')?.phase).toBe('received');

    // The legacy redelivery guard passed: the host must not turn that into a dedup drop.
    const next = begin(host);
    expect(receive(host).disposition).toBe('applied');
    expect(host.current('t1')?.generation).toBe(next.generation);
    expect(host.current('t1')?.generation).toBeGreaterThan(1);
  });

  it('records admission stages and the reducer-owned device slot', () => {
    const { host } = makeHost();
    begin(host);
    receive(host);

    expect(host.dispatchSync(event('admission.begin')).task?.phase).toBe('admitting');
    expect(host.dispatchSync(event('admission.stage', { stage: 'home' })).task?.admission.stage).toBe('home');
    const limits = host.dispatchSync(event('admission.stage', { stage: 'limits' }));
    expect(limits.task?.admission.stage).toBe('limits');
    expect(limits.task?.admission.deviceSlot).toBe(true);
  });

  it('O5 sends exactly one decline through the adapter and keeps reason/retryable/code', () => {
    const sent: Array<{ reason?: string; retryable?: boolean; code?: unknown; agentRef?: unknown }> = [];
    const { host } = makeHost();
    begin(host, 't1', {
      sendDecline: (effect, context) => {
        sent.push({
          reason: effect.effect.reason,
          retryable: effect.effect.retryable,
          code: effect.effect.detail?.code,
          agentRef: context.agentRef,
        });
      },
    });
    host.setAgentRef('t1', 'agent-1');
    receive(host);
    host.dispatchSync(event('admission.begin'));

    const declined = host.dispatchSync(event('admission.declined', {
      stage: 'home',
      reason: 'agent home busy: 1 active attempt(s)',
      retryable: true,
      code: 'agent_home_writer_busy',
    }));
    expect(sent).toEqual([{
      reason: 'agent home busy: 1 active attempt(s)',
      retryable: true,
      code: 'agent_home_writer_busy',
      agentRef: 'agent-1',
    }]);
    expect(declined.task?.phase).toBe('declined');
    expect(declined.task?.admission.decline).toEqual({
      stage: 'home',
      reason: 'agent home busy: 1 active attempt(s)',
      retryable: true,
      code: 'agent_home_writer_busy',
    });
    // Cleanup effects stay with the staged offer pipeline, not the host.
    expect(sent).toHaveLength(1);
  });

  it('X1 + O3 decline a cancel that arrived before the offer at checkpoint 1', () => {
    const sent: Array<{ reason?: string; retryable?: boolean }> = [];
    const { host } = makeHost();
    const context = begin(host, 't1', { sendDecline: effect => { sent.push({ reason: effect.effect.reason, retryable: effect.effect.retryable }); } });
    void context;
    host.dispatchSync(event('cancel.received', { reason: 'stop' }));
    expect(host.runnerSnapshot().pendingCancelled).toEqual([{ taskId: 't1', atMs: 100, reason: 'stop' }]);
    receive(host);

    const declined = host.dispatchSync(event('admission.begin'));
    expect(declined.task?.phase).toBe('declined');
    expect(declined.task?.terminal?.reason).toBe('cancelled before claim: stop');
    expect(sent).toEqual([{ reason: 'cancelled before claim: stop', retryable: false }]);
    expect(host.runnerSnapshot().pendingCancelled).toEqual([]);
  });

  it('X2 declines during admission and C1 can no longer claim afterwards', () => {
    const sent: string[] = [];
    const { host } = makeHost();
    begin(host, 't1', { sendDecline: effect => { sent.push(effect.effect.reason ?? ''); } });
    receive(host);
    host.dispatchSync(event('admission.begin'));
    const cancelled = host.dispatchSync(event('cancel.received', { reason: 'wire cancel' }));
    expect(cancelled.task?.phase).toBe('declined');
    expect(cancelled.task?.terminal?.reason).toBe('cancelled before claim: wire cancel');
    expect(sent).toEqual(['cancelled before claim: wire cancel']);

    const claimable = host.dispatchSync(event('admission.claimable'));
    expect(claimable.disposition).toBe('dropped');
    expect(claimable.effects.some(effect => effect.effect.kind === 'journal.admission')).toBe(false);
  });

  it('X2a declines a cancel that reduced before claim.journaled; the late journal drops', () => {
    const sent: string[] = [];
    const { host } = makeHost();
    begin(host, 't1', { sendDecline: effect => { sent.push(effect.effect.reason ?? ''); } });
    receive(host);
    host.dispatchSync(event('admission.begin'));
    host.dispatchSync(event('admission.stage', { stage: 'home' }));
    host.dispatchSync(event('admission.claimable'));
    expect(host.current('t1')?.phase).toBe('claiming');

    const cancelled = host.dispatchSync(event('cancel.received', { reason: 'race' }));
    expect(cancelled.task?.phase).toBe('declined');
    expect(sent).toEqual(['cancelled before claim: race']);

    const lateJournal = host.dispatchSync(event('claim.journaled'));
    expect(lateJournal.disposition).toBe('dropped');
    expect(lateJournal.effects.some(effect => effect.effect.kind === 'send.claim')).toBe(false);
  });

  it('keeps same-task events FIFO while a barrier is in flight and appends its completion at the tail', async () => {
    const { host } = makeHost();
    begin(host);
    receive(host);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const order: string[] = [];
    host.registerHandler('reserve.home', async () => {
      order.push('barrier:start');
      await barrier;
      order.push('barrier:end');
      return { completion: { type: 'admission.stage', stage: 'preparation' } };
    });

    const beginAdmission = host.dispatch(event('admission.begin'));
    const queuedStage = host.dispatch(event('admission.stage', { stage: 'limits' }));
    // The barrier effect is in flight; the queued event has not been reduced.
    expect(host.current('t1')?.phase).toBe('admitting');
    expect(host.current('t1')?.admission.stage).toBe('checkpoint1');
    expect(order).toEqual(['barrier:start']);

    release();
    await Promise.all([beginAdmission, queuedStage]);
    expect(order).toEqual(['barrier:start', 'barrier:end']);
    // The queued event reduced first; the barrier completion was at the tail.
    expect(host.current('t1')?.admission.stage).toBe('preparation');
    host.endOffer('t1');
  });

  it('refuses a synchronous dispatch while a barrier owns the mailbox', async () => {
    const { host } = makeHost();
    begin(host);
    receive(host);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    host.registerHandler('reserve.home', async () => { await barrier; });
    const pending = host.dispatch(event('admission.begin'));
    expect(() => host.dispatchSync(event('admission.stage', { stage: 'limits' }))).toThrow(/in-flight barrier/);
    release();
    await pending;
    host.endOffer('t1');
  });

  it('reduces an atomic completion inside the group and queues a nested dispatch behind it', () => {
    const { host } = makeHost();
    begin(host);
    receive(host);
    host.dispatchSync(event('admission.begin'));
    host.dispatchSync(event('admission.stage', { stage: 'home' }));
    host.dispatchSync(event('admission.claimable'));

    const phases: Array<string | undefined> = [];
    host.registerHandler('send.claim', () => {
      // The atomic group is not interruptible: the completion (claim.sent)
      // and the nested cancel both wait until this handler returns.
      phases.push(host.current('t1')?.phase);
      void host.dispatch(event('cancel.received', { reason: 'nested' }));
      phases.push(host.current('t1')?.phase);
    });

    host.dispatchSync(event('claim.journaled'));
    expect(phases).toEqual(['claiming', 'claiming']);
    // The completion reduced first, then the queued nested cancel (X3b).
    expect(host.current('t1')?.claim.sent).toBe(true);
    expect(host.current('t1')?.phase).toBe('claimed');
    expect(host.current('t1')?.cancel.requested).toBe(true);
    // X3b records only cx (design §7.6); the bounded pre-offer marker is the
    // legacy adapter's offer-window record, not a second reducer write.
    expect(host.runnerSnapshot().pendingCancelled).toEqual([]);
    host.endOffer('t1');
  });

  it('drops a stale generation instead of applying it to a redelivered task', () => {
    const { host } = makeHost();
    begin(host);
    receive(host);
    const stale = host.dispatchSync(event('admission.begin', { generation: 999 }));
    expect(stale.disposition).toBe('dropped');
    expect(host.current('t1')?.phase).toBe('received');
  });
});
