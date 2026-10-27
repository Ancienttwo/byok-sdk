// `TaskRunner` members for approval requests and decisions
// (see ./support.ts for how a member module runs).
import { randomUUID } from 'node:crypto';
import { createEnvelope } from '@byok-sdk/protocol';
import { ApprovalNotFoundError, type ApprovalDecision, type ApprovalOrigin } from '../approvals';
import { DAEMON_TASK_FAILURE } from '../task-failure';
import type { ActiveTask } from './support';
import { errorMessage } from './support';
import type { TaskRunner } from '../task-runner';
import { DEFAULT_APPROVAL_TIMEOUT_MS, MAX_PENDING_APPROVALS_PER_TASK, NoPendingApprovalError } from '../task-runner';

export async function requestApproval(
  this: TaskRunner,
  taskId: string,
  summary: string,
  onOrigin?: (origin: ApprovalOrigin) => void,
): Promise<{ approved: boolean; reason?: string }> {
  const active = this['tasks'].get(taskId);
  if (!active) {
    return { approved: false, reason: 'task is not currently active on this device' };
  }

  if (active.pendingApprovalId !== undefined) {
    if (active.approvalQueue.length >= MAX_PENDING_APPROVALS_PER_TASK) {
      return {
        approved: false,
        reason: `too many approval requests already queued for task ${taskId} (max ${MAX_PENDING_APPROVALS_PER_TASK}) — rejected fail-closed`,
      };
    }
    return new Promise((resolve) => {
      active.approvalQueue.push({ summary, resolve, onOrigin });
    });
  }

  return this['dispatchApproval'](active, summary, onOrigin);
}

export function dispatchApproval(
  this: TaskRunner,
  active: ActiveTask,
  summary: string,
  onOrigin?: (origin: ApprovalOrigin) => void,
): Promise<{ approved: boolean; reason?: string }> {
  const { taskId } = active;
  const approvalId = randomUUID();
  active.pendingApprovalId = approvalId;
  // Finding F4: see `onApprovalDispatched`'s own doc comment — must fire
  // BEFORE `deps.send` below so the observer has already stashed this
  // approvalId by the time that same synchronous call triggers
  // `DaemonObserver.handleOutboundEnvelope`'s `task.await_approval` case.
  this['deps'].onApprovalDispatched?.(taskId, approvalId);
  // Mirrors the dormant needs_approval branch's own flush-before-pausing
  // discipline (~line 611 below): whatever progress already accumulated
  // this turn should reach the server before the task's state moves to
  // AwaitApproval, not sit buffered behind an indefinite pause.
  active.batcher.flush();
  // M5 (approval targeting): approvalId is always included — see
  // TaskAwaitApprovalPayloadSchema's own doc comment (@byok-sdk/protocol) for
  // why no capability gating is needed to send it safely.
  this['deps'].send(createEnvelope('task.await_approval', { summary, approvalId }, { taskId }));

  const timeoutMs = this['deps'].approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        this['deps'].approvalRegistry.resolve(approvalId, 'reject', `approval timed out after ${timeoutMs}ms with no decision`);
      } catch {
        // Already resolved by a real decision that raced the timer — the
        // registered onResolve callback below already fired; nothing left
        // to do here.
      }
    }, timeoutMs);
    timer.unref?.();

    this['deps'].approvalRegistry.register(
      { approvalId, taskId, summary, createdAt: new Date().toISOString() },
      (decision: ApprovalDecision, reason: string | undefined, origin: ApprovalOrigin) => {
        clearTimeout(timer);
        if (active.pendingApprovalId === approvalId) active.pendingApprovalId = undefined;
        // M4 (additive-minor): report a LOCAL resolution to the server
        // immediately — but never a 'wire' one (the server already knows;
        // see `ApprovalOrigin`'s own doc comment, `approvals.ts`). This is
        // the single convergence point for every local path: the CLI's
        // `approvals.resolve`, this same method's own timeout branch above,
        // `finish()`'s fail-closed cleanup, and the registry's own
        // bounded-eviction fallback all funnel through `onResolve` here.
        if (origin === 'local' || active.localApprovalDecision === approvalId) {
          this['sendApprovalResolved'](taskId, approvalId, decision);
        }
        // C1: fires BEFORE `resolve(...)` below — a caller chaining
        // `.then()` onto this method's returned promise (`pump()`'s
        // dormant `needs_approval` branch) must already be able to see
        // this origin by the time that continuation runs.
        onOrigin?.(origin);
        resolve({ approved: decision === 'approve', reason });
        this['dispatchNextQueuedApproval'](active);
      },
    );
  });
}

export function clearPendingApproval(this: TaskRunner, pendingId: string | undefined, decision: ApprovalDecision, reason: string | undefined): void {
  if (pendingId === undefined) return;
  try {
    this['deps'].approvalRegistry.resolve(pendingId, decision, reason, 'wire');
  } catch (err) {
    // C3 (cross-model review, P2): narrowed to ONLY the benign
    // already-resolved race this catch was ever meant to cover — a bare
    // `catch {}` here used to swallow EVERYTHING, but
    // `ApprovalRegistry.resolve` deletes the entry BEFORE invoking its
    // registered `onResolve` callback (`dispatchApproval` above), so a
    // genuine bug in that callback (`sendApprovalResolved` throwing,
    // `dispatchNextQueuedApproval` failing to dispatch the next queued
    // approval, this same file's own `onOrigin` hook throwing) vanished
    // here too, silently, with nothing ever finding out.
    if (err instanceof ApprovalNotFoundError) {
      // Already resolved via ctx.approvalChannel.resolve (the channel-based
      // adapter path) — benign, same first-resolution-wins guarantee
      // `ApprovalRegistry` already documents on its own `resolve()` method.
      return;
    }
    // Anything else is a genuine failure, not a benign race — propagate
    // it to the caller's existing error handling. Neither `handleApprove`
    // nor `handleReject` wraps this call in a try/catch of their own, so
    // this bubbles all the way up through `handleEnvelope` to
    // `ConnectionManager.process()`'s own existing catch, which logs it
    // and leaves the cursor unadvanced so a reconnect redelivers this
    // exact `task.approve`/`task.reject` for a retry — the same handling
    // every other envelope-handler failure already gets.
    throw err;
  }
}

export async function handleApprove(this: TaskRunner, taskId: string, approvalId: string, decidedBy: ApprovalOrigin): Promise<void> {
  const active = this['tasks'].get(taskId);
  if (!active) return;
  // M5 (approval targeting, docs/protocol.md): checked FIRST, before ever
  // touching active.session. Closes the race NoPendingApprovalError alone
  // could not: approval A resolves, approval B is dispatched next for the
  // SAME task (active.pendingApprovalId now B), and a LATE task.approve
  // meant for A arrives after. Pre-M5, `ctx.approvalChannel.resolve`
  // always resolved "whichever approval is currently pending" (B),
  // silently applying A's decision to B. A mismatch here is an
  // audit-only no-op via the same onStaleApprovalDecision hook
  // NoPendingApprovalError already uses. Wire v4 requires the id, so every
  // decision names the approval it resolves.
  if (approvalId !== active.pendingApprovalId) {
    this['deps'].onStaleApprovalDecision?.(
      taskId,
      'approve',
      `approvalId ${approvalId} does not match the currently pending approval` +
        (active.pendingApprovalId ? ` (${active.pendingApprovalId})` : ' (none pending)'),
    );
    return;
  }
  // CRITICAL: captured BEFORE the await below — see `clearPendingApproval`'s
  // own doc comment for exactly why reading `active.pendingApprovalId`
  // only AFTER `resolveApproval()` settles is wrong: for a channel-based
  // session, that same await's own synchronous side effects (racing
  // through `approvalRegistry.resolve` -> `dispatchNextQueuedApproval`)
  // can already have reassigned it to a different, queued approval by the
  // time control returns here.
  const resolvedId = approvalId;
  if (decidedBy === 'local') active.localApprovalDecision = resolvedId;
  try {
    try {
      await active.session.resolveApproval(true);
    } catch (err) {
      if (err instanceof NoPendingApprovalError) {
        this['deps'].onStaleApprovalDecision?.(taskId, 'approve');
        return;
      }
      await this['fail'](taskId, `failed to resume session after approval: ${errorMessage(err)}`, false);
      return;
    }
    // Acceptance finding 1: see `clearPendingApproval`'s own doc comment.
    this['clearPendingApproval'](resolvedId, 'approve', undefined);
  } finally {
    if (active.localApprovalDecision === resolvedId) active.localApprovalDecision = undefined;
  }
}

export async function handleReject(this: TaskRunner, taskId: string, reason: string | undefined, approvalId: string, decidedBy: ApprovalOrigin): Promise<void> {
  const active = this['tasks'].get(taskId);
  if (!active) return;
  if (active.semanticTerminal !== undefined || active.finalizationStarted) {
    await this['settleSemanticTerminal'](active);
    return;
  }
  // M5 (approval targeting): same validate-first mismatch check as
  // handleApprove above — see that method's own comment for the full
  // race this closes. Returned early here means NONE of the
  // interrupt+task.fail+finish sequence below runs for a stale decision:
  // the currently-pending (different) approval stays untouched and the
  // task is not torn down.
  if (approvalId !== active.pendingApprovalId) {
    this['deps'].onStaleApprovalDecision?.(
      taskId,
      'reject',
      `approvalId ${approvalId} does not match the currently pending approval` +
        (active.pendingApprovalId ? ` (${active.pendingApprovalId})` : ' (none pending)'),
    );
    return;
  }
  // CRITICAL: captured BEFORE the await below — see handleApprove above
  // and `clearPendingApproval`'s own doc comment for the full race this
  // closes (identical here: a channel-based session's own resolution,
  // still inside this await, can already have reassigned
  // `active.pendingApprovalId` to a different, queued approval).
  const resolvedId = approvalId;
  if (decidedBy === 'local') active.localApprovalDecision = resolvedId;
  try {
    try {
      await active.session.resolveApproval(false, reason);
    } catch (err) {
      if (err instanceof NoPendingApprovalError) {
        this['deps'].onStaleApprovalDecision?.(taskId, 'reject', reason);
        return;
      }
      // best-effort — still report the rejection outcome below
    }
    // Acceptance finding 1: see `clearPendingApproval`'s own doc comment.
    // Must run BEFORE `finish()` below — its own fail-closed cleanup
    // defaults to origin 'local' (see `ApprovalRegistry.resolve`'s default
    // parameter), which would incorrectly echo `task.approval_resolved`
    // back to a server that already knows this decision (it sent this
    // task.reject itself) if this hadn't already cleared it as 'wire' here.
    this['clearPendingApproval'](resolvedId, 'reject', reason);
  } finally {
    if (active.localApprovalDecision === resolvedId) active.localApprovalDecision = undefined;
  }
  await this['settleSemanticTerminal'](active, async () => {
    await this['interruptBounded'](active);
    // As with cancel, the server has already closed its progress stream.
    await this['persistAgentTerminalEvidence'](active, 'failed', reason ?? 'rejected');
    return createEnvelope('task.fail', {
      reason: reason ?? 'rejected', retryable: false,
      ...this['failurePayload'](DAEMON_TASK_FAILURE),
      ...this['terminalInferenceUsagePayload'](active),
      ...this['preparedObservationPayload'](active),
      ...this['agentTerminalPayload'](active),
    }, { taskId });
  });
}
