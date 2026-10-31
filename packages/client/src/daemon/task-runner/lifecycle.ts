// `TaskRunner` members for shutdown, teardown, limits, cancel and steer
// (see ./support.ts for how a member module runs).
import { createEnvelope } from '@byok-sdk/protocol';
import { SteerUnsupportedError } from '../../types';
import { RuntimeDisposalFailure, isRuntimeDisposalFailure } from '../../runtime-failure';
import { DAEMON_TASK_FAILURE } from '../task-failure';
import { MAX_TIMER_DELAY_MS } from '../../util/timer-delay';
import type { ActiveTask } from './support';
import { raceSettleFirst } from './support';
import type { TaskRunner } from '../task-runner';
import { DEFAULT_SHUTDOWN_INTERRUPT_TIMEOUT_MS, MAX_DURATION_EXCEEDED_REASON_PREFIX, MAX_TRACKED_TASK_IDS } from './state';
import { hostFor } from './host';

export function stopAcceptingOffers(this: TaskRunner): void {
  this['stoppingOffers'] = true;
  // Contract §8.2(1): a daemon on its way down signs nothing more for any
  // task. The control handler's own `shutting_down` gate answers first, so
  // this is not the refusal a caller sees — it is the registry telling the
  // truth regardless of which path initiated the shutdown.
  this['revokeAllHostToolsetContexts']();
  this['startupOwnership'].stopRetry();
  for (const abort of this['inFlightBlobAborts'].values()) abort.abort();
}

export function closeActiveSession(this: TaskRunner, active: ActiveTask): Promise<void> {
  // Store the receipt before close runs. A synchronous throw is a rejected
  // receipt, just like an adapter's asynchronous disposal failure.
  const attempt = active.disposalAttempt ??= Promise.resolve().then(async () => { await active.session.close(); await active.scratch.release(); });
  // Interrupt can start close before finalization waits for it. Observe the
  // rejection here, but retain the receipt until finalization reports it.
  void attempt.catch(() => undefined);
  return attempt;
}

export async function awaitActiveSessionClose(this: TaskRunner, active: ActiveTask): Promise<boolean> {
  const attempt = this['closeActiveSession'](active);
  try {
    await attempt;
  } catch (caught) {
    if (active.disposalAttempt === attempt) active.disposalAttempt = undefined;
    const failure = isRuntimeDisposalFailure(caught)
      ? caught
      : new RuntimeDisposalFailure({
          stage: 'quiescence',
          reason: `${active.adapter.descriptor.id} session.close() returned an untyped disposal failure`,
        }, { cause: caught });
    // stderr is a service log: the stage and the reason's size, never its text (issue #395).
    console.error(
      `[byok/client] runtime disposal failed for task ${active.taskId}: runtime=${active.adapter.descriptor.id} stage=${failure.stage} reasonBytes=${Buffer.byteLength(failure.message, 'utf8')}`,
    );
    this['deps'].onRuntimeDisposalFailure?.({
      taskId: active.taskId,
      runtimeId: active.adapter.descriptor.id,
      stage: failure.stage,
      reason: failure.message,
    });
    return false;
  }
  return true;
}

export async function interruptBounded(this: TaskRunner, active: ActiveTask, drainEvents = true, capMs?: number): Promise<void> {
  const configuredMs = this['deps'].shutdownInterruptTimeoutMs ?? DEFAULT_SHUTDOWN_INTERRUPT_TIMEOUT_MS;
  const timeoutMs = capMs === undefined ? configuredMs : Math.min(configuredMs, capMs);
  const deadline = Date.now() + timeoutMs;
  await raceSettleFirst(() => active.session.interrupt(), timeoutMs);
  // Close drains native stdio even if an ACK arrived before final usage, or
  // the adapter never supplies turn_end. Retain this SAME receipt for finish
  // to await/retry; a deadline is never proof of disposal.
  this['closeActiveSession'](active);
  if (drainEvents) {
    // Drain events already delivered by interrupt before publishing usage.
    // A pending close/next() is not metering authority and cannot hold the
    // cancellation ACK hostage. One scheduler turn drains queued microtasks;
    // a close receipt (including a hung one) is still awaited by finish().
    if (Date.now() < deadline) {
      await Promise.race([active.eventPump ?? Promise.resolve(),
        new Promise<void>(resolve => setImmediate(resolve))]);
    }
  }
}

export async function teardownActiveTask(
  this: TaskRunner, active: ActiveTask, reason: string, retryable: boolean, drainEvents = true, interruptTimeoutMs?: number,
): Promise<boolean> {
  return this['settleSemanticTerminal'](active, async () => {
    active.blobAbort.abort();
    await this['interruptBounded'](active, drainEvents, interruptTimeoutMs);
    await this['persistAgentTerminalEvidence'](active, 'failed', reason);
    return createEnvelope('task.fail', {
      reason,
      retryable,
      ...this['failurePayload'](DAEMON_TASK_FAILURE),
      ...this['terminalInferenceUsagePayload'](active),
      ...this['preparedObservationPayload'](active),
      ...this['agentTerminalPayload'](active),
    }, { taskId: active.taskId });
  });
}

export async function shutdownTask(this: TaskRunner, active: ActiveTask, reason: string, interruptTimeoutMs?: number): Promise<void> {
  const disposed = await this['teardownActiveTask'](active, `daemon shutting down: ${reason}`, true, true, interruptTimeoutMs);
  if (!disposed) {
    throw new RuntimeDisposalFailure({
      stage: 'quiescence',
      reason: `${active.adapter.descriptor.id} runtime ownership remains active after shutdown disposal failed`,
    });
  }
}

export function armMaxDurationTimer(this: TaskRunner, active: ActiveTask, maxDurationMs: number): void {
  // `maxDurationMs` is server-supplied and unbounded above; a limit beyond
  // one timer's range (~24.8 days) is armed in capped steps so it still
  // fires at the real limit instead of immediately. Each step replaces
  // `active.maxDurationTimer`, so `finish()` always clears the live one.
  const limitAt = Date.now() + maxDurationMs;
  const arm = (remainingMs: number): void => {
    const capped = remainingMs > MAX_TIMER_DELAY_MS;
    const timer = setTimeout(() => {
      if (capped) {
        if (!active.finalizationStarted) arm(Math.max(0, limitAt - Date.now()));
        return;
      }
      void this['failActiveTaskForResourceLimit'](
        active.taskId,
        `${MAX_DURATION_EXCEEDED_REASON_PREFIX}: task exceeded its configured wall-clock limit of ${maxDurationMs}ms`,
      );
    }, capped ? MAX_TIMER_DELAY_MS : remainingMs);
    timer.unref?.();
    active.maxDurationTimer = timer;
  };
  arm(maxDurationMs);
}

export async function handleCancel(this: TaskRunner, taskId: string, reason: string | undefined): Promise<void> {
  // Contract §8.2(1) / AC11: the FIRST statement of this handler, before the
  // active-task lookup and before any `await`. A cancel and a
  // `task_assertion.issue` can arrive as two frames the daemon dispatches on
  // the same tick; revoking anywhere below an await would leave a window in
  // which a task this device has already agreed to cancel can still mint new
  // tool authority. Unconditional, so it covers the not-yet-registered offer
  // window too — a taskId with no nonces is simply a no-op here.
  this['revokeHostToolsetContexts'](taskId);
  const active = this['tasks'].get(taskId);
  const host = hostFor(this);
  if (!active) {
    // #1099 S4: a task already in the reducer, but not registered active, is
    // in the offer/start window. Where the reducer can decide now, it owns
    // the transition. The bounded legacy marker remains the offer-window
    // checkpoint record (unknown/pre-offer and the claimed-to-started
    // handoff) and is consumed at checkpoint 2; it is not the cx authority.
    const current = host.current(taskId);
    // A pre-claim task is declined by the stage that observes the aborted
    // admission signal (design §8.4): the bounded marker below keeps the
    // exact legacy reason and the admission timing payload that only the
    // waiting stage can record. O5 owns the decline.
    if (current !== undefined && current.phase === 'claiming' && !current.claim.journaled && !current.claim.sent) {
      // X2a (#1218): the journal is in flight, so the claim is not committed.
      // No admission phase is pending here, so declining now keeps the same
      // reason/retryable pair the deferred O5 path used.
      this['inFlightBlobAborts'].get(taskId)?.abort();
      host.dispatchSync({ type: 'cancel.received', taskId, atMs: Date.now(), source: 'wire' });
      return;
    }
    if (current !== undefined && current.phase === 'claimed') {
      // X3 (startup ownership exists) or X3b (start is still in flight):
      // checkpoint 2 reads cx.requested and makes runtime.started take C6,
      // never task.started. The bounded marker stays the offer-window
      // checkpoint record the start path consumes.
      this['inFlightBlobAborts'].get(taskId)?.abort();
      host.dispatchSync({
        type: 'cancel.received', taskId, atMs: Date.now(), source: 'wire',
        ...(reason === undefined ? {} : { reason }),
      });
      this['setPendingCancelled'](taskId, reason);
      return;
    }
    if (current !== undefined && (current.phase === 'terminalizing' || current.phase === 'retiring')) {
      // X5: share the selected terminal; its IO is S6 scope.
      host.dispatchSync({
        type: 'cancel.received', taskId, atMs: Date.now(), source: 'wire',
        ...(reason === undefined ? {} : { reason }),
      });
    }
    if (this['startupOwnership'].has(taskId) && !this['inFlightOffers'].has(taskId)) {
      await this['startupOwnership'].dispose(taskId);
      return;
    }
    // Finding F4: not registered yet — record it in case handleOffer is
    // still in flight for this exact taskId (claimed but not yet started;
    // see the class-level doc on `pendingCancelled` and the two
    // checkpoints in handleOffer). A genuinely stale/unknown/already-
    // finished taskId just leaves a harmless, never-consulted entry —
    // identical in effect to the old silent-drop behavior for that case
    // (M3-B: except now bounded — see `setPendingCancelled`). S4 retains
    // this store because the bounded-collections oracle pins it; the
    // reducer marker (X1/X3b) is not co-written here.
    this['setPendingCancelled'](taskId, reason);
    this['inFlightBlobAborts'].get(taskId)?.abort();
    return;
  }
  await this['settleSemanticTerminal'](active, async () => {
    active.blobAbort.abort();
    await this['interruptBounded'](active);
    // Deliberately NOT active.batcher.flush()-ed here (M1-4 e2e finding):
    // §4's "server state is authoritative on its own action" rule means the
    // server already moved this task to `Cancelled` — and already closed
    // this task's ServerTaskEvent queue (hub.ts's onStateChange, called
    // synchronously from cancelTask() before task.cancel is even sent) —
    // before this notification reaches the daemon at all. Any progress
    // still buffered in the batcher at this point can therefore never reach
    // an embedder no matter what: sending it only draws a
    // dropped/illegal-transition warning on the server for a `task.progress`
    // arriving against an already-terminal task (hub.ts's onProgress has no
    // §9 stale-terminal-message idempotency for task.progress the way it
    // does for task.complete/fail/cancelled). `finish()` below already stops
    // the batcher; nothing else needs to happen with its buffer contents.
    // M1 gap #6: the canonical, explicit cancellation message — no longer
    // `task.fail({reason:'cancelled'})`.
    await this['persistAgentTerminalEvidence'](active, 'cancelled', reason);
    return createEnvelope('task.cancelled', {
      reason, ...this['terminalInferenceUsagePayload'](active), ...this['agentTerminalPayload'](active),
    }, { taskId });
  });
}

export function evictPendingCancelled(this: TaskRunner): void {
  for (const key of this['pendingCancelled'].keys()) {
    if (!this['inFlightOffers'].has(key)) {
      this['pendingCancelled'].delete(key);
      return;
    }
  }
  console.warn(
    `[byok/client] pendingCancelled exceeded ${MAX_TRACKED_TASK_IDS} entries with every tracked taskId currently in-flight — leaving it temporarily over cap rather than evict a marker a running handleOffer() still needs`,
  );
}

export async function handleSteer(this: TaskRunner, taskId: string, text: string): Promise<void> {
  const active = this['tasks'].get(taskId);
  if (!active) return;
  try {
    await active.session.steer(text);
  } catch (err) {
    if (err instanceof SteerUnsupportedError) {
      console.error(
        `[byok/client] inbound task.steer for task ${taskId} rejected: runtime "${err.runtimeId}" has no steering channel (${err.message}) — acked without retry; this envelope should have been gated server-side`,
      );
      return;
    }
    throw err;
  }
}
