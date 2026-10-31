// `TaskRunner` members that fail and finish a task and settle its terminal
// (see ./support.ts for how a member module runs).
//
// #1099 S6: the reducer owns the terminal decision (first-terminal-wins),
// its phase progression and the order of the cleanup barriers. This module is
// the IO adapter: it keeps the exact envelope bytes, evidence writes, close /
// commit receipts and lease cleanup where they were, and every terminal entry
// point registers its plan here before the selecting event is reduced.
import { terminalIdentity } from '../terminal-identity';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import type { AgentHomeAccessMode } from '../../agent-home-readers';
import { DAEMON_TASK_FAILURE } from '../task-failure';
import type { ActiveTask, ClaimedAgentFailureContext } from './support';
import { executionTerminalOf, errorMessage } from './support';
import type { TaskRunner } from '../task-runner';
import { hostFor, type TaskRunnerHost } from './host';
import type { TerminalCause, TerminalKind } from './state';

/** The IO half of one terminal decision; the reducer owns the other half. */
export interface TerminalPlan {
  readonly kind: TerminalKind;
  readonly cause: TerminalCause;
  readonly reason?: string;
  readonly retryable?: boolean;
  /** Interrupt (if the path owns one), evidence and exact envelope construction. */
  readonly prepare: () => Promise<Envelope>;
}

/**
 * Terminal effects are installed once per runner. Registering them lazily keeps
 * a runner that never reaches a terminal on the exact same path it had before
 * S6 (and keeps the entry closure unchanged until a terminal is selected).
 */
const terminalHosts = new WeakSet<TaskRunner>();

export function terminalEffectsHost(this: TaskRunner): TaskRunnerHost {
  const host = hostFor(this);
  if (terminalHosts.has(this)) return host;
  terminalHosts.add(this);

  const activeOf = (taskId: string | undefined): ActiveTask | undefined =>
    taskId === undefined ? undefined : this['tasks'].get(taskId);

  host.registerHandler('revoke.allHostContexts', () => {
    this['revokeAllHostToolsetContexts']();
  });
  host.registerHandler('revoke.host_contexts', (_envelope, context) => {
    if (context.taskId !== undefined) this['revokeHostToolsetContexts'](context.taskId);
  });
  host.registerHandler('startup.stopRetry', () => {
    this['startupOwnership'].stopRetry();
  });
  host.registerHandler('abort.inflightBlobs', () => {
    for (const abort of this['inFlightBlobAborts'].values()) abort.abort();
  });
  host.registerHandler('revoke.message_context', (_envelope, context) => {
    if (context.taskId !== undefined) this['revokeAgentMessageContext'](context.taskId);
  });
  host.registerHandler('stop.batcher', (_envelope, context) => {
    activeOf(context.taskId)?.batcher.stop();
  });
  host.registerHandler('stop.draft', (_envelope, context) => {
    activeOf(context.taskId)?.messageDraft?.stop();
  });

  host.registerHandler('persist.evidence', (envelope, context) => {
    const intent = context.taskId === undefined ? undefined : host.terminalIntent(context.taskId);
    // A row like C8 selects its terminal before any plan exists and runs
    // `failClaimedAgent` itself. Returning undefined synchronously (not a
    // Promise) keeps that dispatch atomic.
    if (intent === undefined) return undefined;
    // The legacy prepare closure is the whole legacy barrier: interrupt,
    // evidence and envelope bytes, in that order, exactly as before.
    const prepared = intent.envelope !== undefined ? Promise.resolve(intent.envelope) : intent.plan.prepare();
    return prepared.then(
      (ready) => {
        intent.envelope = ready;
        return {
          completion: {
            type: 'terminal.evidence' as const,
            ...(envelope.effect.token === undefined ? {} : { token: envelope.effect.token }),
            ok: true,
          },
        };
      },
      (error: unknown) => {
        if (context.taskId !== undefined) host.rejectTerminal(context.taskId, error);
        throw error;
      },
    );
  });

  host.registerHandler('prepare.envelope', (envelope, context) => {
    const intent = context.taskId === undefined ? undefined : host.terminalIntent(context.taskId);
    if (intent?.envelope === undefined) {
      if (context.taskId !== undefined) {
        host.rejectTerminal(context.taskId, new Error('terminal envelope was not prepared'));
      }
      return undefined;
    }
    return {
      completion: {
        type: 'terminal.envelope_ready' as const,
        ...(envelope.effect.token === undefined ? {} : { token: envelope.effect.token }),
      },
    };
  });

  host.registerHandler('send.terminal', (envelope, context) => {
    const taskId = context.taskId;
    const intent = taskId === undefined ? undefined : host.terminalIntent(taskId);
    if (taskId === undefined || intent?.envelope === undefined) {
      throw new Error('terminal send has no prepared envelope');
    }
    // Send the retained exact bytes. The approval queue was drained before
    // this effect ran (after terminal selection, before send), so no fresh
    // await_approval can follow the terminal. A synchronous sender failure
    // retains the bytes; retry re-sends the same envelope.
    try {
      this['deps'].send(intent.envelope);
    } catch (error) {
      host.rejectTerminal(taskId, error);
      throw error;
    }
  });

  host.registerHandler('mark.finished', (_envelope, context) => {
    if (context.taskId !== undefined) this['markFinishedTaskId'](context.taskId);
  });

  host.registerHandler('await.close', async (envelope, context) => {
    const active = activeOf(context.taskId);
    if (active === undefined) return undefined;
    const ok = await this['awaitActiveSessionClose'](active);
    return {
      completion: {
        type: 'terminal.close' as const,
        ...(envelope.effect.token === undefined ? {} : { token: envelope.effect.token }),
        ok,
      },
    };
  });

  host.registerHandler('await.terminal_commit', async (envelope, context) => {
    if (context.taskId === undefined) return undefined;
    let ok = true;
    try {
      await this['deps'].awaitTerminalCommit?.(context.taskId);
    } catch {
      ok = false;
    }
    return {
      completion: {
        type: 'terminal.commit' as const,
        ...(envelope.effect.token === undefined ? {} : { token: envelope.effect.token }),
        ok,
      },
    };
  });

  host.registerHandler('retry.close', async (envelope, context) => {
    const active = activeOf(context.taskId);
    if (active === undefined) return undefined;
    const ok = await this['awaitActiveSessionClose'](active);
    return {
      completion: {
        type: 'terminal.close' as const,
        ...(envelope.effect.token === undefined ? {} : { token: envelope.effect.token }),
        ok,
      },
    };
  });

  host.registerHandler('retry.commit', async (envelope, context) => {
    if (context.taskId === undefined) return undefined;
    let ok = true;
    try {
      await this['deps'].awaitTerminalCommit?.(context.taskId);
    } catch {
      ok = false;
    }
    return {
      completion: {
        type: 'terminal.commit' as const,
        ...(envelope.effect.token === undefined ? {} : { token: envelope.effect.token }),
        ok,
      },
    };
  });

  host.registerHandler('finish', async (_envelope, context) => {
    const taskId = context.taskId;
    if (taskId === undefined) return undefined;
    const intent = host.terminalIntent(taskId);
    // `finishOnce` stays the single cleanup entry (the cancel-durability oracle
    // observes it); the envelope is the retained exact terminal bytes.
    const ok = await this['finishOnce'](taskId, intent?.envelope);
    if (intent !== undefined) intent.finishOk = ok;
    return { completion: { type: 'finish.completed' as const } };
  });

  return host;
}

/**
 * Registers the first terminal plan for `active`. Must run BEFORE the caller
 * dispatches the event that selects the terminal, so the selecting row's
 * terminal effects can find the plan. Returns the shared receipt.
 */
export function beginTerminal(this: TaskRunner, active: ActiveTask, plan: TerminalPlan): Promise<boolean> {
  if (this['tasks'].get(active.taskId) !== active) return Promise.resolve(true);
  const host = terminalEffectsHost.call(this);
  // The gate payload belongs to the message lane only; a terminal decision
  // makes it unreachable.
  host.clearMessageCompletion(active.taskId);
  const receipt = host.beginTerminalIntent(active.taskId, plan).receipt;
  trackFinalization.call(this, active.taskId, receipt);
  return receipt;
}

/** Home admission waits on this receipt; it ends when cleanup or a failed barrier does. */
function trackFinalization(this: TaskRunner, taskId: string, receipt: Promise<boolean>): void {
  this['finalizationAttempts'].set(taskId, receipt);
  const clear = (): void => {
    if (this['finalizationAttempts'].get(taskId) === receipt) this['finalizationAttempts'].delete(taskId);
  };
  void receipt.then(clear, clear);
}

/**
 * The legacy name every terminal caller already used. With a plan it registers
 * that plan and dispatches `terminal.requested` (the first one wins inside the
 * reducer). Without a plan it returns the in-flight receipt, or retries the
 * failed close/commit barrier with the same token.
 */
export function settleSemanticTerminal(
  this: TaskRunner, active: ActiveTask, plan?: TerminalPlan,
): Promise<boolean> {
  if (this['tasks'].get(active.taskId) !== active) return Promise.resolve(true);
  const host = terminalEffectsHost.call(this);
  const current = host.current(active.taskId);
  if (current === undefined) return this['finish'](active.taskId);
  if (plan === undefined) {
    const receipt = host.terminalReceipt(active.taskId);
    if (receipt !== undefined) return receipt;
    if (current.phase === 'retiring'
      && (current.teardown.close === 'failed' || current.teardown.commit === 'failed')) {
      return retryTerminalFinalization.call(this, active.taskId);
    }
    if (current.phase === 'terminalizing' || current.phase === 'retiring') return Promise.resolve(true);
    return this['finish'](active.taskId);
  }
  const needsRetry = current.terminal !== undefined && host.terminalSettled(active.taskId) === true;
  const { receipt, winner } = host.beginTerminalIntent(active.taskId, plan);
  trackFinalization.call(this, active.taskId, receipt);
  if (needsRetry) return retryTerminalFinalization.call(this, active.taskId, true);
  if (winner) {
    if (current.terminal === undefined
      && (current.phase === 'running' || current.phase === 'awaiting_approval')) {
      void host.dispatch({
        type: 'terminal.requested',
        taskId: active.taskId,
        atMs: Date.now(),
        kind: plan.kind,
        ...(plan.reason === undefined ? {} : { reason: plan.reason }),
        ...(plan.retryable === undefined ? {} : { retryable: plan.retryable }),
      }).catch(error => host.rejectTerminal(active.taskId, error));
      // Drain after selection, before the terminal bytes: a finishing task never
      // dispatches a queued approval and every caller is settled fail-closed.
      void drainApprovals.call(this, active.taskId);
    } else if (current.terminal === undefined) {
      // No terminal row accepts this phase (a caller raced a finished task).
      // Never strand the awaiting caller.
      host.settleTerminal(active.taskId, false);
    }
  }
  return receipt;
}

/** Re-drives only the failed close/commit barrier; the token and bytes stay. */
export function retryTerminalFinalization(this: TaskRunner, taskId: string, force = false): Promise<boolean> {
  const host = terminalEffectsHost.call(this);
  const current = host.current(taskId);
  if (current === undefined) return Promise.resolve(true);
  if (current.terminal === undefined) return Promise.resolve(false);
  const failedBarrier = current.teardown.close === 'failed' || current.teardown.commit === 'failed';
  const terminalizing = current.phase === 'terminalizing';
  if (!failedBarrier && !terminalizing) {
    return host.terminalReceipt(taskId) ?? Promise.resolve(true);
  }
  // An in-flight attempt is shared, never duplicated. A caller that already
  // observed a settled attempt passes `force` because registering its plan
  // reset the receipt to in-flight.
  if (!force && host.terminalSettled(taskId) !== true) {
    return host.terminalReceipt(taskId) ?? Promise.resolve(true);
  }
  const receipt = host.retryTerminal(taskId);
  if (receipt !== undefined) {
    this['finalizationAttempts'].set(taskId, receipt);
    void receipt.then(
      () => { if (this['finalizationAttempts'].get(taskId) === receipt) this['finalizationAttempts'].delete(taskId); },
      () => { if (this['finalizationAttempts'].get(taskId) === receipt) this['finalizationAttempts'].delete(taskId); },
    );
  }
  const retry = host.dispatch({ type: 'retry.finalization', taskId, atMs: Date.now() });
  // A rejecting retry barrier (revoke/evidence/send) rejects to its caller; a
  // failed close/commit settles the receipt false without throwing.
  return Promise.all([retry, receipt ?? Promise.resolve(true)]).then(([, ok]) => ok);
}

/**
 * Drains the approval queue FIRST (all queued promises rejected, never
 * dispatched) and then the dispatched one, so a finishing task never sends a
 * fresh `task.await_approval`. Runs after the terminal send, exactly where the
 * legacy `finish()` drain ran.
 */
export function drainApprovals(this: TaskRunner, taskId: string): Promise<void> {
  const host = hostFor(this);
  const drain = async (): Promise<void> => {
    for (;;) {
      const queued = host.current(taskId)?.approval.queue[0];
      if (queued === undefined) break;
      await host.dispatch({
        type: 'approval.withdrawn',
        taskId,
        atMs: Date.now(),
        requestId: queued.requestId,
        reason: `task ${taskId} finished before this queued approval request could be dispatched`,
      }).catch(() => undefined);
    }
    const pending = host.current(taskId)?.approval.pending;
    if (pending === undefined) return;
    await host.dispatch({
      type: 'approval.withdrawn',
      taskId,
      atMs: Date.now(),
      requestId: pending.requestId,
      reason: `task ${taskId} finished`,
    }).catch(() => undefined);
  };
  return drain();
}

export async function fail(this: TaskRunner, taskId: string, reason: string, retryable: boolean, failure = DAEMON_TASK_FAILURE): Promise<void> {
  const active = this['tasks'].get(taskId);
  if (active !== undefined) {
    await this['settleSemanticTerminal'](active, {
      kind: 'failed',
      cause: 'failed',
      reason,
      retryable,
      prepare: async () => {
        await this['persistAgentTerminalEvidence'](active, 'failed', reason);
        return createEnvelope('task.fail', {
          reason,
          retryable,
          ...this['failurePayload'](failure),
          ...this['terminalInferenceUsagePayload'](active),
          ...this['preparedObservationPayload'](active),
          ...this['agentTerminalPayload'](active),
        }, { taskId });
      },
    });
    return;
  }
  this['deps'].send(createEnvelope('task.fail', {
    reason, retryable, ...this['failurePayload'](failure), ...terminalIdentity(this['claimedHarnesses'].get(taskId)),
  }, { taskId }));
  await this['finish'](taskId);
}

export async function failClaimedAgent(
  this: TaskRunner,
  taskId: string,
  reason: string,
  retryable: boolean,
  context: ClaimedAgentFailureContext,
  failure = DAEMON_TASK_FAILURE,
): Promise<boolean> {
  await this['pendingMessageTasks'].get(taskId)?.outbox.revoke(taskId);
  const agentRef = context.binding.resolution.agentRef;
  const result = await this['retryAgentTerminalEvidence'](() =>
    this['deps'].agentHome!.mutateExecution(context.binding, () =>
      this['deps'].agentSessionHandoffs!.recordTaskTerminal({
        agentRef,
        taskId,
        runtimeId: context.runtimeId,
        home: context.binding.resolution.canonicalHome,
        cwd: context.binding.lease.cwd,
        ...(context.binding.lease.homeAccess === 'memory-reader' ? { homeAccess: 'memory-reader' as const } : {}),
        leaseId: context.binding.lease.leaseId,
        ...(context.sessionRef === undefined ? {} : { sessionRef: context.sessionRef }),
        terminalReason: reason,
      })),
  );
  if (!result.ok) {
    this['reportAgentTerminalEvidenceFailure']({
      taskId,
      agentRef,
      runtimeId: context.runtimeId,
      cwd: context.binding.lease.cwd,
      cause: 'failed',
      reason,
      error: result.error,
    });
  }
  // C7/C8 already selected this failed terminal in the reducer before this
  // adapter ran. The exact wire envelope stays here; it is never re-selected.
  this['deps'].send(createEnvelope(
    'task.fail',
    { reason, retryable, ...this['failurePayload'](failure), ...terminalIdentity(context.runtimeId, agentRef) },
    { taskId },
  ));
  return result.ok;
}

export function homeFinalizations(this: TaskRunner, canonicalHome: string, homeAccess: AgentHomeAccessMode): Promise<boolean>[] {
  const attempts: Promise<boolean>[] = [];
  for (const active of this['tasks'].values()) {
    // S6: terminalizing is the old semantic-terminal decision, retiring the
    // old finalizationStarted window. Both already own the home lease and
    // must be waited on rather than reported busy (#476).
    const phase = hostFor(this).current(active.taskId)?.phase;
      if (phase !== 'terminalizing' && phase !== 'retiring') continue;
    const binding = active.agentBinding;
    if (binding === undefined || binding.resolution.canonicalHome !== canonicalHome
      || binding.lease.homeAccess !== homeAccess) continue;
    const attempt = this['finalizationAttempts'].get(active.taskId);
    if (attempt !== undefined) attempts.push(attempt);
  }
  return attempts;
}

/**
 * Legacy cleanup receipt for a task that has no reducer state (the direct
 * `fail()` branch for an already-removed task), and the idempotent entry used
 * by callers that still ask for `finish()`.
 */
export async function finishOnce(this: TaskRunner, taskId: string, envelope?: Envelope): Promise<boolean> {
  const active = this['tasks'].get(taskId);
  if (!active) return true;
  return finishTaskCleanup.call(this, taskId, envelope);
}

/** The T12 `finish` effect: close/commit already succeeded, release ownership. */
async function finishTaskCleanup(this: TaskRunner, taskId: string, envelope: Envelope | undefined): Promise<boolean> {
  const active = this['tasks'].get(taskId);
  if (active === undefined) return true;
  if (active.maxDurationTimer) {
    clearTimeout(active.maxDurationTimer);
    active.maxDurationTimer = undefined;
  }
  if (active.messageRetryTimer) {
    clearTimeout(active.messageRetryTimer);
    active.messageRetryTimer = undefined;
  }
  active.batcher.stop();
  active.messageDraft?.stop();
  this['publishExecutionRecord'](active, envelope);
  const agentRef = active.agentRef;
  const handoff = active.agentHandoff;
  // Session.close() is the adapter quiescence receipt. Capture only after it,
  // while this exact Agent-home writer lease is still held, so direct runtime
  // file-tool writes cannot escape the deterministic snapshot.
  await this['quiesceAndSnapshotAgentMemory'](active);
  if (!active.agentTerminalPersisted) {
    const terminal = hostFor(this).current(taskId)?.terminal;
    const cause = terminal === undefined ? 'failed'
      : terminal.kind === 'complete' ? 'complete' : terminal.kind === 'cancelled' ? 'cancelled' : 'failed';
    const result = await this['retryAgentTerminalEvidence'](() =>
      this['deps'].agentSessionHandoffs!.recordTerminal(
        {
          agentRef,
          sessionRef: handoff.sessionRef,
          runtimeId: handoff.runtimeId,
          home: handoff.home,
          cwd: handoff.cwd,
          ...(handoff.homeAccess === undefined ? {} : { homeAccess: handoff.homeAccess }),
        },
        cause,
        terminal?.reason,
      ),
    );
    if (result.ok) {
      active.agentTerminalPersisted = true;
    } else if (!active.agentTerminalEvidenceFailureReported) {
      active.agentTerminalEvidenceFailureReported = true;
      this['reportAgentTerminalEvidenceFailure']({
        taskId,
        agentRef,
        runtimeId: handoff.runtimeId,
        cwd: handoff.cwd,
        cause,
        reason: terminal?.reason,
        error: result.error,
      });
    }
  }
  let leaseReleased = true;
  try {
    await active.agentBinding.lease.release();
  } catch (error) {
    console.error(`[byok/client] Agent home lease could not be released for ${taskId}: ${errorMessage(error)}`);
    leaseReleased = false;
  }
  await this['releasePreparationPin'](taskId);
  this['tasks'].delete(taskId);
  this['revokeAgentMessageContext'](taskId);
  this['revokeAgentResultContext'](taskId);
  this['revokeAgentMemoryContext'](taskId);
  this['deleteHostToolsetContexts'](taskId);
  return leaseReleased;
}

export function publishExecutionRecord(this: TaskRunner, active: ActiveTask, envelope?: Envelope): void {
  if (active.executionRecordPublished) return;
  active.executionRecordPublished = true;
  const terminal = executionTerminalOf(envelope);
  if (terminal === undefined) return;
  try {
    this['deps'].onExecutionRecord?.(active.executionRecord.finish(terminal));
  } catch {
    // stderr is a service log: no adapter or listener error text (issue #395).
    console.error(`[byok/client] execution record for task ${active.taskId} was not published`);
  }
}

export async function releasePreparationPin(this: TaskRunner, taskId: string): Promise<void> {
  const recordId = this['preparationPinsByTask'].get(taskId);
  if (recordId === undefined) return;
  this['preparationPinsByTask'].delete(taskId);
  try {
    await this['deps'].inputPreparationLane?.store.unpin(recordId, taskId);
  } catch (error) {
    console.error(
      `[byok/client] preparation pin for task ${taskId} could not be released: ${errorMessage(error)}`,
    );
  }
}
