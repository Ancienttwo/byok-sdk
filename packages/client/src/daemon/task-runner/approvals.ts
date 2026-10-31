// `TaskRunner` members for approval requests and decisions
// (see ./support.ts for how a member module runs).
import { randomUUID } from 'node:crypto';
import { createEnvelope } from '@byok-sdk/protocol';
import type { ApprovalDecision, ApprovalKind, ApprovalOrigin } from '../approvals';
import { DAEMON_TASK_FAILURE } from '../task-failure';
import type { ActiveTask } from './support';
import type { TaskRunner } from '../task-runner';
import { DEFAULT_APPROVAL_TIMEOUT_MS, MAX_PENDING_APPROVALS_PER_TASK } from './state';

export async function requestApproval(
  this: TaskRunner,
  taskId: string,
  summary: string,
  signal: AbortSignal | undefined,
  kind: ApprovalKind,
): Promise<{ approved: boolean; reason?: string }> {
  if (signal?.aborted) return { approved: false, reason: WITHDRAWN };
  const active = this['tasks'].get(taskId);
  // Teardown may retain ownership solely to retry disposal or terminal commit.
  if (!active || active.beingTornDown) {
    return { approved: false, reason: 'task is not currently active on this device' };
  }

  if (active.pendingApproval !== undefined) {
    if (active.approvalQueue.length >= MAX_PENDING_APPROVALS_PER_TASK) {
      return {
        approved: false,
        reason: `too many approval requests already queued for task ${taskId} (max ${MAX_PENDING_APPROVALS_PER_TASK}) — rejected fail-closed`,
      };
    }
    return new Promise((resolve) => {
      const request = { summary, kind, resolve, ...(signal === undefined ? {} : { signal }) };
      active.approvalQueue.push(request);
      // A withdrawn request leaves the queue, so it is never dispatched and a
      // later decision has nothing to revive.
      signal?.addEventListener('abort', () => {
        const index = active.approvalQueue.indexOf(request);
        if (index === -1) return;
        active.approvalQueue.splice(index, 1);
        resolve({ approved: false, reason: WITHDRAWN });
      }, { once: true });
    });
  }

  return this['dispatchApproval'](active, summary, signal, kind);
}

const WITHDRAWN = 'approval request was withdrawn by its requester';

export function dispatchApproval(
  this: TaskRunner,
  active: ActiveTask,
  summary: string,
  signal: AbortSignal | undefined,
  kind: ApprovalKind,
): Promise<{ approved: boolean; reason?: string }> {
  const { taskId } = active;
  if (signal?.aborted) return Promise.resolve({ approved: false, reason: WITHDRAWN });
  const approvalId = randomUUID();
  active.pendingApproval = { approvalId, kind };
  // Finding F4: see `onApprovalDispatched`'s own doc comment — must fire
  // BEFORE `deps.send` below so the observer has already stashed this
  // approvalId by the time that same synchronous call triggers
  // `DaemonObserver.handleOutboundEnvelope`'s `task.await_approval` case.
  this['deps'].onApprovalDispatched?.(taskId, approvalId);
  // Progress already accumulated this turn reaches the server before the
  // task's state moves to AwaitApproval, not after an indefinite pause.
  active.batcher.flush();
  // M5 (approval targeting): approvalId is always included — see
  // TaskAwaitApprovalPayloadSchema's own doc comment (@byok-sdk/protocol) for
  // why no capability gating is needed to send it safely.
  this['deps'].send(createEnvelope('task.await_approval', { summary, approvalId }, { taskId }));

  const timeoutMs = this['deps'].approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        this['deps'].approvalRegistry.resolve(approvalId, 'reject', `approval timed out after ${timeoutMs}ms with no decision`, 'fail-closed');
      } catch {
        // Already resolved by a real decision that raced the timer — the
        // registered onResolve callback below already fired; nothing left
        // to do here.
      }
    }, timeoutMs);
    timer.unref?.();
    // Withdrawal resolves the entry like the timeout does, so a decision
    // arriving afterwards is stale and cannot revive it.
    const withdraw = () => {
      try {
        this['deps'].approvalRegistry.resolve(approvalId, 'reject', WITHDRAWN, 'fail-closed');
      } catch {
        // Already resolved.
      }
    };

    this['deps'].approvalRegistry.register(
      { approvalId, taskId, kind, summary, createdAt: new Date().toISOString() },
      (decision: ApprovalDecision, reason: string | undefined, origin: ApprovalOrigin) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', withdraw);
        if (active.pendingApproval?.approvalId === approvalId) active.pendingApproval = undefined;
        // Every resolution of this approval lands here: a wire decision, an
        // in-process `Daemon.approve`/`reject`, a control-socket
        // `approvals.resolve`, the timeout above, `finish()`'s fail-closed
        // cleanup and registry eviction. All but a wire one are new to the
        // server (see `ApprovalOrigin`).
        if (origin !== 'wire') this['sendApprovalResolved'](taskId, approvalId, decision);
        resolve({ approved: decision === 'approve', reason });
        this['dispatchNextQueuedApproval'](active);
      },
    );
    signal?.addEventListener('abort', withdraw, { once: true });
  });
}

/**
 * A wire `task.approve` or an in-process `Daemon.approve`: resolves the pending
 * approval it names in the registry, which hands `{ approved: true }` to the
 * session that requested it. A decision for any other id is stale and
 * changes nothing.
 */
export async function handleApprove(this: TaskRunner, taskId: string, approvalId: string, decidedBy: ApprovalOrigin): Promise<void> {
  const active = this['tasks'].get(taskId);
  if (!active) return;
  if (!pendingMatches.call(this, active, approvalId, 'approve')) return;
  this['deps'].approvalRegistry.resolve(approvalId, 'approve', undefined, decidedBy);
}

/**
 * A wire `task.reject` or an in-process `Daemon.reject`: resolves the pending
 * approval it names. Only a task-terminal approval stops the session and
 * reports `task.fail`; tool authorization returns a tool denial and the turn
 * continues. A decision for any other id is stale and changes nothing.
 */
export async function handleReject(this: TaskRunner, taskId: string, reason: string | undefined, approvalId: string, decidedBy: ApprovalOrigin): Promise<void> {
  const active = this['tasks'].get(taskId);
  if (!active) return;
  if (active.semanticTerminal !== undefined || active.finalizationStarted) {
    await this['settleSemanticTerminal'](active);
    return;
  }
  if (!pendingMatches.call(this, active, approvalId, 'reject')) return;
  // Snapshot before resolve: its callback can dispatch a queued approval.
  const terminatesTask = active.pendingApproval!.kind === 'task-terminal';
  // Before the terminal: `finish()` rejects whatever is still pending as a
  // local decision, which would echo this decision back to the server.
  this['deps'].approvalRegistry.resolve(approvalId, 'reject', reason, decidedBy);
  if (!terminatesTask) return;
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

/**
 * The pending id is set when an approval is dispatched and cleared in the
 * same synchronous callback that resolves it, so a match means the registry
 * still holds it. A late, repeated or mistargeted decision is audit-only.
 */
function pendingMatches(this: TaskRunner, active: ActiveTask, approvalId: string, decision: ApprovalDecision): boolean {
  if (approvalId === active.pendingApproval?.approvalId) return true;
  this['deps'].onStaleApprovalDecision?.(
    active.taskId,
    decision,
    `approvalId ${approvalId} does not match the currently pending approval` +
      (active.pendingApproval ? ` (${active.pendingApproval.approvalId})` : ' (none pending)'),
  );
  return false;
}
