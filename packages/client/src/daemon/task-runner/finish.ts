// `TaskRunner` members that fail and finish a task and settle its terminal
// (see ./support.ts for how a member module runs).
import { terminalIdentity } from '../terminal-identity';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import type { AgentHomeAccessMode } from '../../agent-home-readers';
import { DAEMON_TASK_FAILURE } from '../task-failure';
import type { ActiveTask, ClaimedAgentFailureContext } from './support';
import { executionTerminalOf, errorMessage } from './support';
import type { TaskRunner } from '../task-runner';

export async function fail(this: TaskRunner, taskId: string, reason: string, retryable: boolean, failure = DAEMON_TASK_FAILURE): Promise<void> {
  const active = this['tasks'].get(taskId);
  if (active !== undefined) {
    await this['settleSemanticTerminal'](active, async () => {
      await this['persistAgentTerminalEvidence'](active, 'failed', reason);
      return createEnvelope('task.fail', {
        reason,
        retryable,
        ...this['failurePayload'](failure),
        ...this['terminalInferenceUsagePayload'](active),
        ...this['preparedObservationPayload'](active),
        ...this['agentTerminalPayload'](active),
      }, { taskId });
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
    if (!active.finalizationStarted) continue;
    const binding = active.agentBinding;
    if (binding === undefined || binding.resolution.canonicalHome !== canonicalHome
      || binding.lease.homeAccess !== homeAccess) continue;
    const attempt = this['finalizationAttempts'].get(active.taskId);
    if (attempt !== undefined) attempts.push(attempt);
  }
  return attempts;
}

export async function finishOnce(this: TaskRunner, taskId: string): Promise<boolean> {
  const active = this['tasks'].get(taskId);
  if (!active) return true;
  // M5 batch-3 (workstream 2): see `armMaxDurationTimer`'s own doc
  // comment — `finish()` is the single choke point every terminal outcome
  // (normal completion, fail, cancel, or daemon shutdown) already funnels
  // through, so clearing here (unconditionally, before anything else)
  // guarantees no leaked timer and no stray fail after this task has
  // already ended a different way.
  if (!active.finalizationStarted) {
    active.finalizationStarted = true;
    active.beingTornDown = true;
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
    this['addFinishedTaskId'](taskId); // semantic terminal is authoritative even while disposal ownership is retained

  // M4 Phase 4 (gatekeeper LOW advisory): a task can finish (complete,
  // fail, or cancel) while ONE approval is still DISPATCHED
  // (`active.pendingApprovalId`) and/or MORE are QUEUED behind it
  // (`active.approvalQueue` — see `requestApproval`'s own doc comment for
  // the full concurrent-approval design). Left alone, a queued request
  // would eventually get dispatched (a fresh, pointless `task.await_approval`
  // + timeout window for a task that no longer exists) once whatever it
  // was queued behind finally resolves; the dispatched one's own timer
  // would keep running for up to `approvalTimeoutMs` regardless. Both are
  // resolved fail-closed HERE instead: the queue is drained and rejected
  // FIRST (each queued promise settles immediately, never dispatched at
  // all), so that resolving the dispatched one next — which triggers
  // `dispatchNextQueuedApproval` via its own `onResolve` callback — finds
  // an already-empty queue and dispatches nothing. Order matters: doing
  // it the other way around would let that callback pull the first
  // queued entry and dispatch it for real.
    const queued = active.approvalQueue.splice(0);
    for (const request of queued) {
      request.resolve({
        approved: false,
        reason: `task ${taskId} finished before this queued approval request could be dispatched`,
      });
    }
    if (active.pendingApprovalId !== undefined) {
      try {
        this['deps'].approvalRegistry.resolve(active.pendingApprovalId, 'reject', `task ${taskId} finished`);
      } catch {
        // Already resolved by a real decision/timeout that raced this.
      }
    }
  }

  if (!await this['awaitActiveSessionClose'](active)) return false;
  if (this['tasks'].get(taskId) !== active) return true;
  try {
    await this['deps'].awaitTerminalCommit?.(taskId);
  } catch {
    return false;
  }
  if (this['tasks'].get(taskId) !== active) return true;
  this['publishExecutionRecord'](active);
  const agentRef = active.agentRef;
  const handoff = active.agentHandoff;
  // Session.close() is the adapter quiescence receipt. Capture only after
  // it, while this exact Agent-home writer lease is still held, so direct
  // runtime file-tool writes cannot escape the deterministic snapshot.
  await this['quiesceAndSnapshotAgentMemory'](active);
  if (!active.agentTerminalPersisted) {
    const cause = active.terminalCause ?? 'failed';
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
        active.terminalReason,
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
        reason: active.terminalReason,
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

export function publishExecutionRecord(this: TaskRunner, active: ActiveTask): void {
  if (active.executionRecordPublished) return;
  active.executionRecordPublished = true;
  const terminal = executionTerminalOf(active.semanticTerminal?.envelope);
  if (terminal === undefined) return;
  try {
    this['deps'].onExecutionRecord?.(active.executionRecord.finish(terminal));
  } catch {
    // stderr is a service log: no adapter or listener error text (issue #395).
    console.error(`[byok/client] execution record for task ${active.taskId} was not published`);
  }
}

export function settleSemanticTerminal(this: TaskRunner, active: ActiveTask, prepare?: () => Promise<Envelope>): Promise<boolean> {
  if (this['tasks'].get(active.taskId) !== active) return Promise.resolve(true);
  if (active.semanticTerminal?.attempt) return active.semanticTerminal.attempt;
  if (active.finalizationStarted) return this['finish'](active.taskId);
  if (active.semanticTerminal === undefined) {
    if (prepare === undefined) return Promise.resolve(false);
    // First decision wins synchronously, before interrupt or durability I/O.
    // Keep its closure after failure; competing cancel/fail/shutdown reasons
    // may retry it, but can never select a replacement semantic terminal.
    this['revokeHostToolsetContexts'](active.taskId);
    active.beingTornDown = true;
    active.semanticTerminal = { prepare };
    active.messageDraft?.stop();
  }
  const terminal = active.semanticTerminal;
  const attempt = Promise.resolve().then(async () => {
    terminal.envelope ??= await terminal.prepare();
    if (this['tasks'].get(active.taskId) !== active) return true;
    // Retain the exact envelope even if the synchronous sender throws. The
    // existing terminal journal remains the sole durable wire authority.
    this['deps'].send(terminal.envelope);
    return this['finish'](active.taskId);
  }).finally(() => {
    if (terminal.attempt === attempt) terminal.attempt = undefined;
  });
  terminal.attempt = attempt;
  return attempt;
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
