/**
 * M4 Phase 2: minimal pending-approval registry backing the control
 * socket's `approvals.list`/`approvals.resolve` methods.
 *
 * Nothing PRODUCES an approval yet in Phase 2 — every one of the three
 * bundled runtime adapters (pi/claude/codex) still has no interactive
 * `needs_approval` path (see `create-daemon.ts`'s `toRuntimeInfoCapabilities`
 * doc comment) — so `list()` always returns `[]` and `resolve()` always
 * throws {@link ApprovalNotFoundError} against a real daemon today. This
 * class exists now so Phase 3 (the claude permission-prompt path) only has
 * to call `register()` from wherever it detects a prompt; the control-socket
 * plumbing (`control-server.ts`'s method registry, the CLI's `approve`/
 * `reject` commands) is already wired end-to-end against this same registry.
 */

export type ApprovalDecision = 'approve' | 'reject';

/**
 * M4 (additive-minor, `task.approval_resolved`): distinguishes a resolution
 * that arrived over the wire (a server-sent `task.approve`/`task.reject`,
 * relayed here via `TaskContext.approvalChannel.resolve` — `task-runner.ts`'s
 * `handleOffer`) from one this device decided on its own (the local
 * `approvals.resolve` control-socket RPC, a fail-closed `requestApproval`
 * timeout, or a fail-closed finish/eviction rejection). `TaskRunner` uses
 * this to decide whether to report `task.approval_resolved` back to the
 * server: a wire-triggered resolution is something the server already knows
 * about (it sent the decision itself) and must never be echoed back;
 * everything else is new information only the device has, and — capability
 * permitting — gets reported. `'local'` is the default (see `resolve()`
 * below) precisely because it's the common case: every call site in this
 * module and `task-runner.ts` except the one wire-relay closure is local by
 * construction.
 */
export type ApprovalOrigin = 'wire' | 'local';

/** What `approvals.list` returns per pending approval — deliberately small; a runtime-specific payload (e.g. the exact tool call awaiting approval) is Phase 3's concern, not this registry's. */
export interface PendingApproval {
  approvalId: string;
  taskId: string;
  summary?: string;
  createdAt: string;
}

export class ApprovalNotFoundError extends Error {
  constructor(approvalId: string) {
    super(`no pending approval with id "${approvalId}"`);
    this.name = 'ApprovalNotFoundError';
  }
}

/** Cap on simultaneously pending approvals — generous for any plausible concurrent-approval workload, and existing purely as a defensive bound (mirrors `task-runner.ts`'s `MAX_TRACKED_TASK_IDS`/`observer.ts`'s `MAX_TRACKED_TASKS`), not a real-world limit this is expected to ever approach. */
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
        // 'local': an eviction is this registry's own bookkeeping, never a
        // relayed server decision — see `ApprovalOrigin`'s own doc comment.
        evicted?.onResolve(
          'reject',
          `evicted: approval registry exceeded ${MAX_PENDING_APPROVALS} pending entries`,
          'local',
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
   * `origin` defaults to `'local'` (see {@link ApprovalOrigin}'s own doc
   * comment for why that's the correct default, not just a convenient one):
   * every existing caller of this method — the control socket's
   * `approvals.resolve` RPC (`create-daemon.ts`), `TaskRunner`'s
   * `requestApproval` timeout and `finish()` fail-closed cleanup
   * (`task-runner.ts`) — resolves a decision this device made on its own.
   * The one exception, a server-sent wire `task.approve`/`task.reject`
   * relayed through `TaskContext.approvalChannel.resolve`
   * (`task-runner.ts`'s `handleOffer`), passes `'wire'` explicitly.
   */
  resolve(approvalId: string, decision: ApprovalDecision, reason?: string, origin: ApprovalOrigin = 'local'): void {
    const entry = this.pending.get(approvalId);
    if (!entry) throw new ApprovalNotFoundError(approvalId);
    this.pending.delete(approvalId);
    entry.onResolve(decision, reason, origin);
  }
}
