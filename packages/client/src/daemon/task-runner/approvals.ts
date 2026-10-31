// `TaskRunner` members for approval requests and decisions
// (see ./support.ts for how a member module runs).
//
// #1099 S5: the reducer owns the pending/queue authority
// (`TaskStateV1.approval`); this module is the IO adapter that keeps the
// registry, timers, wire bytes and promise resolvers exactly where they were.
// Every request and every resolution is a host event, so the same strict FIFO
// mailbox that orders claim/start/cancel also orders approvals (#1218).
import { randomUUID } from 'node:crypto';
import { createEnvelope } from '@byok-sdk/protocol';
import type { ApprovalDecision, ApprovalKind, ApprovalOrigin } from '../approvals';
import { DAEMON_TASK_FAILURE } from '../task-failure';
import type { ActiveTask } from './support';
import type { TaskRunner } from '../task-runner';
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_PENDING_APPROVALS_PER_TASK,
  type ApprovalOrigin as ReducerApprovalOrigin,
} from './state';
import { hostFor, type HostApprovalRequest, type TaskRunnerHost } from './host';
import { taskTearingDown } from './support';
import { beginTerminal, drainApprovals } from './finish';

const WITHDRAWN = 'approval request was withdrawn by its requester';
const NOT_ACTIVE = 'task is not currently active on this device';

/**
 * The approval effects are installed once per runner. Registering them lazily
 * keeps the eager path (and therefore the entry closure) unchanged until the
 * first approval is requested.
 */
const approvalHosts = new WeakSet<TaskRunner>();

function approvalHost(this: TaskRunner): TaskRunnerHost {
  const host = hostFor(this);
  if (approvalHosts.has(this)) return host;
  approvalHosts.add(this);

  host.registerHandler('flush.batcher', (_envelope, context) => {
    if (context.taskId === undefined) return;
    // Progress accumulated this turn reaches the server BEFORE the task moves
    // to AwaitApproval, exactly as the legacy dispatch did.
    this['tasks'].get(context.taskId)?.batcher.flush();
  });

  host.registerHandler('send.approval_request', (_envelope, context) => {
    const taskId = context.taskId;
    const pending = context.snapshot.task?.approval.pending;
    if (taskId === undefined || pending === undefined) return;
    const request = host.approvalRequest(pending.requestId);
    // Finding F4: `onApprovalDispatched` must fire BEFORE `deps.send` so the
    // observer has already stashed this approvalId when that same synchronous
    // send triggers its own `task.await_approval` handling.
    this['deps'].onApprovalDispatched?.(taskId, pending.approvalId);
    try {
      // M5 (approval targeting): approvalId is always included — see
      // TaskAwaitApprovalPayloadSchema's own doc comment (@byok-sdk/protocol).
      this['deps'].send(createEnvelope('task.await_approval', {
        summary: request?.summary ?? '',
        approvalId: pending.approvalId,
      }, { taskId }));
    } catch (error) {
      // Sealed/oversized approval frames can fail locally. Deny this request
      // fail-closed and let the existing A10 withdrawal clear the reducer
      // pending; A1's remaining effects never run, so no registry entry or
      // timeout survives and the turn goes on.
      host.settleApprovalRequest(pending.requestId, {
        approved: false,
        reason: 'approval request could not be sent',
      });
      void host.dispatch({
        type: 'approval.withdrawn',
        taskId,
        atMs: Date.now(),
        requestId: pending.requestId,
        reason: 'approval request could not be sent',
      }).catch(() => undefined);
      throw error;
    }
  });

  host.registerHandler('register.approval', (_envelope, context) => {
    const taskId = context.taskId;
    const pending = context.snapshot.task?.approval.pending;
    if (taskId === undefined || pending === undefined) return;
    const request = host.approvalRequest(pending.requestId);
    host.setApprovalDispatched(pending.requestId, pending.approvalId);
    this['deps'].approvalRegistry.register(
      {
        approvalId: pending.approvalId,
        taskId,
        kind: pending.kind,
        ...(request === undefined ? {} : { summary: request.summary }),
        createdAt: new Date().toISOString(),
      },
      (decision: ApprovalDecision, reason: string | undefined, origin: ApprovalOrigin) => {
        // Every resolution of this approval lands here: a wire decision, an
        // in-process `Daemon.approve`/`reject`, a control-socket
        // `approvals.resolve`, the timeout, withdrawal, `finish()`'s cleanup
        // and registry eviction. The A5-A7 rows own the state transition.
        const decided = {
          type: 'approval.decided' as const,
          taskId,
          atMs: Date.now(),
          approvalId: pending.approvalId,
          decision,
          ...(reason === undefined ? {} : { reason }),
          origin: reducerOrigin(origin),
        };
        // #1099 S6: an A7 task-terminal reject continues into the reducer's
        // terminal effects (interrupt/evidence/envelope are barriers), so that
        // decision enters through the mailbox: `dispatchSync` would refuse its
        // own barrier. Every other decision stays synchronous on an idle
        // mailbox, exactly as S5 shipped, so a throwing dispatch callback still
        // reaches the registry caller.
        if (decision === 'reject' && pending.kind === 'task-terminal') {
          void host.dispatch(decided).catch(() => undefined);
          return;
        }
        if (!host.isDraining(taskId)) {
          host.dispatchSync(decided);
          return;
        }
        void host.dispatch(decided).catch(() => undefined);
      },
    );
  });

  host.registerHandler('arm.approval_timeout', (_envelope, context) => {
    const pending = context.snapshot.task?.approval.pending;
    if (pending === undefined) return;
    const timeoutMs = this['deps'].approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    const timer = setTimeout(() => {
      const reason = `approval timed out after ${timeoutMs}ms with no decision`;
      // A7 (task-terminal reject) needs its terminal plan before the decision
      // resolves; a denied tool authorization (A6) never ends the turn.
      const active = context.taskId === undefined ? undefined : this['tasks'].get(context.taskId);
      if (active !== undefined && pending.kind === 'task-terminal') {
        beginTerminal.call(this, active, {
          kind: 'failed',
          cause: 'rejected',
          reason,
          retryable: false,
          prepare: async () => {
            await this['persistAgentTerminalEvidence'](active, 'failed', reason);
            return createEnvelope('task.fail', {
              reason,
              retryable: false,
              ...this['failurePayload'](DAEMON_TASK_FAILURE),
              ...this['terminalInferenceUsagePayload'](active),
              ...this['preparedObservationPayload'](active),
              ...this['agentTerminalPayload'](active),
            }, { taskId: active.taskId });
          },
        });
      }
      try {
        this['deps'].approvalRegistry.resolve(pending.approvalId, 'reject', reason, 'fail-closed');
      } catch {
        // Already resolved by a real decision that raced the timer.
      }
    }, timeoutMs);
    timer.unref?.();
    host.setApprovalTimer(pending.approvalId, timer);
  });

  host.registerHandler('clear.timeout', envelope => {
    host.clearApprovalTimer(envelope.effect.approvalId);
  });

  host.registerHandler('send.approval_resolved', envelope => {
    const { taskId, approvalId, decision } = envelope.effect;
    if (taskId === undefined || approvalId === undefined) return;
    this['sendApprovalResolved'](taskId, approvalId, decision ?? 'reject');
  });

  host.registerHandler('resolve.approval_promise', envelope => {
    const effect = envelope.effect;
    const request = effect.approvalId !== undefined
      ? host.approvalRequestByApprovalId(effect.approvalId)
      : effect.requestId === undefined ? undefined : host.approvalRequest(effect.requestId);
    if (request === undefined) return;
    host.settleApprovalRequest(request.requestId, {
      approved: effect.approved === true,
      ...(effect.reason === undefined ? {} : { reason: effect.reason }),
    });
  });

  host.registerHandler('resolve.approval', envelope => {
    const effect = envelope.effect;
    if (effect.approvalId === undefined) return;
    try {
      // A dispatched withdrawal is the device's own fail-closed decision.
      this['deps'].approvalRegistry.resolve(effect.approvalId, effect.decision ?? 'reject', effect.reason, 'fail-closed');
    } catch {
      // Already resolved (finish drain raced a real decision).
    }
  });

  host.registerHandler('dispatch.next_approval', () => ({
    // The reducer stays pure: the executor mints the approvalId the FIFO head
    // is dispatched with, exactly like a direct A1 dispatch.
    completion: { type: 'approval.dispatch_next', approvalId: randomUUID() },
  }));

  return host;
}

function reducerOrigin(origin: ApprovalOrigin): ReducerApprovalOrigin {
  return origin === 'control' ? 'control-socket' : origin;
}

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
  if (!active || taskTearingDown(this, taskId)) {
    return { approved: false, reason: NOT_ACTIVE };
  }
  const host = approvalHost.call(this);
  // A request can only be dispatched or queued for a task whose reducer phase
  // still accepts approvals. Anything else (cancel, terminal, a start that
  // never activated) fails closed exactly like the legacy unknown-task path.
  const current = host.current(taskId);
  if (current === undefined || (current.phase !== 'running' && current.phase !== 'awaiting_approval')) {
    return { approved: false, reason: NOT_ACTIVE };
  }
  if (current.approval.pending !== undefined
    && current.approval.queue.length >= MAX_PENDING_APPROVALS_PER_TASK) {
    return {
      approved: false,
      reason: `too many approval requests already queued for task ${taskId} (max ${MAX_PENDING_APPROVALS_PER_TASK}) — rejected fail-closed`,
    };
  }

  // Only an idle task dispatches directly (A1); a non-empty queue never lets
  // this request jump the FIFO head (A2 waits for A4). The reducer mints the
  // approvalId again for a queued request when it finally dispatches.
  const approvalId = current.approval.pending === undefined && current.approval.queue.length === 0
    ? randomUUID()
    : undefined;
  const requestId = host.nextApprovalRequestId();

  return new Promise((resolve) => {
    const onAbort = (): void => {
      void host.dispatch({
        type: 'approval.withdrawn',
        taskId,
        atMs: Date.now(),
        requestId,
      }).catch(() => undefined);
    };
    const request: HostApprovalRequest = {
      taskId,
      requestId,
      summary,
      kind,
      resolve,
      ...(signal === undefined
        ? {}
        : { detach: () => signal.removeEventListener('abort', onAbort) }),
    };
    host.beginApprovalRequest(request);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted === true) {
      // Aborted after the caller's first check but before the request event.
      host.settleApprovalRequest(requestId, { approved: false, reason: WITHDRAWN });
      return;
    }
    const requested = host.dispatch({
      type: 'approval.requested',
      taskId,
      atMs: Date.now(),
      requestId,
      kind,
      ...(approvalId === undefined ? {} : { approvalId }),
    });
    // The rows own the happy path. This backstop only makes the "never strand
    // a caller" guarantee total if a future phase makes the row inapplicable.
    const failClosed = (): void => {
      host.settleApprovalRequest(requestId, { approved: false, reason: 'approval request rejected fail-closed' });
    };
    void requested.then((result) => {
      if (result.disposition !== 'applied') failClosed();
    }).catch(failClosed);
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
  if (!pendingMatches.call(this, taskId, approvalId, 'approve')) return;
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
  if (!active) {
    // A decision that names a task already finished is audit-only; report it
    // rather than silently dropping it (the task may have terminalized while
    // this wire frame was in flight).
    const finishedHost = hostFor(this);
    if (finishedHost.archivedTask(taskId) !== undefined
      || finishedHost.runnerSnapshot().finished.includes(taskId)) {
      void finishedHost.dispatch({ type: 'approval.stale', taskId, atMs: Date.now(), approvalId }).catch(() => undefined);
      this['deps'].onStaleApprovalDecision?.(
        taskId,
        'reject',
        `approvalId ${approvalId} arrived after task ${taskId} finished`,
      );
    }
    return;
  }
  const host = hostFor(this);
  const current = host.current(taskId);
  if (current?.terminal !== undefined || current?.phase === 'terminalizing' || current?.phase === 'retiring') {
    // The task already selected its terminal; this reject is audit-only and
    // never interrupts or fails it a second time.
    void host.dispatch({ type: 'approval.stale', taskId, atMs: Date.now(), approvalId }).catch(() => undefined);
    this['deps'].onStaleApprovalDecision?.(
      taskId,
      'reject',
      `approvalId ${approvalId} arrived after the task's terminal was selected`,
    );
    await this['settleSemanticTerminal'](active);
    return;
  }
  if (!pendingMatches.call(this, taskId, approvalId, 'reject')) return;
  // Snapshot before resolve: its callback dispatches the A7 terminal.
  const terminatesTask = current?.approval.pending?.kind === 'task-terminal';
  // A7's terminal effects need the plan before the decision resolves.
  const receipt = terminatesTask
    ? beginTerminal.call(this, active, {
        kind: 'failed',
        cause: 'rejected',
        reason: reason ?? 'rejected',
        retryable: false,
        prepare: async () => {
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
        },
      })
    : undefined;
  // Before the terminal: `finish()` rejects whatever is still pending as a
  // local decision, which would echo this decision back to the server.
  this['deps'].approvalRegistry.resolve(approvalId, 'reject', reason, decidedBy);
  if (receipt === undefined) return;
  // Settle the queued requests behind the one just decided before the
  // terminal bytes are sent.
  void drainApprovals.call(this, taskId);
  await receipt;
}

/**
 * The pending id is set when an approval is dispatched and cleared in the
 * same reducer turn that resolves it, so a match means the registry still
 * holds it. A late, repeated or mistargeted decision is audit-only: it is
 * recorded as `approval.stale` and never revives or re-sends.
 */
function pendingMatches(this: TaskRunner, taskId: string, approvalId: string, decision: ApprovalDecision): boolean {
  const host = hostFor(this);
  const pending = host.current(taskId)?.approval.pending;
  if (approvalId === pending?.approvalId) return true;
  if (host.current(taskId) !== undefined) {
    void host.dispatch({
      type: 'approval.stale',
      taskId,
      atMs: Date.now(),
      approvalId,
    }).catch(() => undefined);
  }
  this['deps'].onStaleApprovalDecision?.(
    taskId,
    decision,
    `approvalId ${approvalId} does not match the currently pending approval` +
      (pending ? ` (${pending.approvalId})` : ' (none pending)'),
  );
  return false;
}
