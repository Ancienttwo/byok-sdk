/**
 * The pending-approval registry: the one place an approval is resolved.
 * `TaskRunner.requestApproval` registers each dispatched approval (from a
 * session's `approvalChannel` or the control socket's `approvals.request`);
 * wire and in-process decisions, the CLI's `approvals.resolve`, timeouts,
 * task finish and eviction all resolve it here, and here a control-socket
 * approval of a `tool-authorization` approval is refused (see
 * {@link ApprovalOrigin}).
 */

export type ApprovalDecision = 'approve' | 'reject';

/**
 * What an approval asks for. `task-terminal`: a runtime asks whether its task
 * may continue, and a rejection ends the task. `tool-authorization`: the
 * `auto` tool gate asks whether one high-risk tool call may run, and a
 * rejection denies that call while the turn continues.
 */
export type ApprovalKind = 'task-terminal' | 'tool-authorization';

/**
 * The channel a resolution arrived on. Two decisions depend on it:
 *
 * - Reporting. `'wire'` is a server-sent `task.approve`/`task.reject`
 *   (`TaskRunner.handleApprove`/`handleReject`): the server already knows it,
 *   so it is never echoed back. Every other origin is new to the server and is
 *   reported as `task.approval_resolved`.
 * - Authority. A `tool-authorization` approval is approved only by the Host:
 *   `'wire'` or `'in-process'` (`Daemon.approve`, called by a Host that embeds
 *   the daemon). `'control'` (the control socket's `approvals.resolve`, which
 *   `byok-agent approve` calls) can be used by any same-user process that can
 *   read `control.token`, including the agent being authorized, so it can only
 *   reject such an approval unless `DaemonConfig.localToolApproval` is
 *   `'allow'`.
 *
 * `'fail-closed'` is the device's own rejection: a `requestApproval` timeout
 * or withdrawal, task finish, registry eviction, or an approval that could not
 * be sealed for the Host.
 */
export type ApprovalOrigin = 'wire' | 'in-process' | 'control' | 'fail-closed';

/** Whether the control socket may approve a `tool-authorization` approval. Absent means it may only reject. */
export type LocalToolApprovalPolicy = 'allow';

/** What `approvals.list` returns per pending approval — deliberately small; a runtime-specific payload (e.g. the exact tool call awaiting approval) is Phase 3's concern, not this registry's. */
export interface PendingApproval {
  approvalId: string;
  taskId: string;
  kind: ApprovalKind;
  summary?: string;
  createdAt: string;
}

/** Stable control error code for a control-socket approval of a `tool-authorization` approval. */
export const APPROVAL_REQUIRES_HOST = 'approval_requires_host';

export class ApprovalNotFoundError extends Error {
  constructor(approvalId: string) {
    super(`no pending approval with id "${approvalId}"`);
    this.name = 'ApprovalNotFoundError';
  }
}

/**
 * The control socket tried to approve a `tool-authorization` approval while
 * `DaemonConfig.localToolApproval` is not `'allow'`. The approval stays
 * pending: the Host can still decide it, and the control socket can still
 * reject it.
 */
export class ApprovalRequiresHostError extends Error {
  readonly code = APPROVAL_REQUIRES_HOST;
  constructor(approvalId: string) {
    super(`approval "${approvalId}" is a tool authorization: only the Host can approve it (the control channel can reject it, or set DaemonConfig.localToolApproval to 'allow')`);
    this.name = 'ApprovalRequiresHostError';
  }
}

/** Cap on simultaneously pending approvals — generous for any plausible concurrent-approval workload, and existing purely as a defensive bound (mirrors `task-runner/state.ts`'s `MAX_TRACKED_TASK_IDS`/`observer.ts`'s `MAX_TRACKED_TASKS`), not a real-world limit this is expected to ever approach. */
export const MAX_PENDING_APPROVALS = 200;

type ResolveCallback = (decision: ApprovalDecision, reason: string | undefined, origin: ApprovalOrigin) => void;

interface RegisteredApproval {
  approval: PendingApproval;
  onResolve: ResolveCallback;
}

/**
 * `register()`/`resolve()` are the producer/consumer halves of one pending
 * approval: a future runtime adapter integration calls `register()` when it
 * pauses a task awaiting a decision and gets called back via `onResolve`
 * once `resolve()` is invoked (locally, or — Phase 2's actual wiring — via
 * the control socket's `approvals.resolve` RPC). `list()` is a pure read
 * for `approvals.list`.
 */
export class ApprovalRegistry {
  private readonly pending = new Map<string, RegisteredApproval>();
  private readonly localToolApproval: LocalToolApprovalPolicy | undefined;

  constructor(options: { localToolApproval?: LocalToolApprovalPolicy } = {}) {
    this.localToolApproval = options.localToolApproval;
  }

  /**
   * Registers a new pending approval, evicting the OLDEST entry first if
   * already at {@link MAX_PENDING_APPROVALS} — bounded, not unbounded
   * growth, for a long-lived daemon. The evicted entry's own `onResolve` is
   * called (as a reject, with a reason naming the eviction) rather than
   * simply dropped: whatever registered it (a future Phase 3 producer,
   * e.g. a paused runtime session awaiting a decision) is very likely
   * still waiting on that callback firing at all — silently stranding it
   * would leave that producer hanging forever instead of unblocking it
   * with a clear, if unwelcome, outcome.
   */
  register(approval: PendingApproval, onResolve: ResolveCallback): void {
    if (this.pending.size >= MAX_PENDING_APPROVALS) {
      const oldestId = this.pending.keys().next().value;
      if (oldestId !== undefined) {
        const evicted = this.pending.get(oldestId);
        this.pending.delete(oldestId);
        console.warn(
          `[byok/client] approval registry exceeded ${MAX_PENDING_APPROVALS} pending entries — evicted the oldest (${oldestId})`,
        );
        evicted?.onResolve(
          'reject',
          `evicted: approval registry exceeded ${MAX_PENDING_APPROVALS} pending entries`,
          'fail-closed',
        );
      }
    }
    this.pending.set(approval.approvalId, { approval, onResolve });
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map((entry) => entry.approval);
  }

  /**
   * Throws {@link ApprovalNotFoundError} for an unknown/already-resolved id —
   * never silently no-ops, since a caller (the control socket's
   * `approvals.resolve`) needs to distinguish "resolved" from "nothing to
   * resolve".
   *
   * Throws {@link ApprovalRequiresHostError}, leaving the approval pending,
   * when a `'control'` origin approves a `tool-authorization` approval and
   * `localToolApproval` is not `'allow'`. Every origin may reject.
   */
  resolve(approvalId: string, decision: ApprovalDecision, reason: string | undefined, origin: ApprovalOrigin): void {
    const entry = this.pending.get(approvalId);
    if (!entry) throw new ApprovalNotFoundError(approvalId);
    if (
      decision === 'approve' &&
      origin === 'control' &&
      entry.approval.kind === 'tool-authorization' &&
      this.localToolApproval !== 'allow'
    ) {
      throw new ApprovalRequiresHostError(approvalId);
    }
    this.pending.delete(approvalId);
    entry.onResolve(decision, reason, origin);
  }
}
