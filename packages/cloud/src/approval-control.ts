/**
 * Host-side approval resolution: the one rule that decides WHICH approval a
 * `cloud.approveTask`/`rejectTask` call is allowed to resolve.
 *
 * `@byok-sdk/server` keeps this as a single mutable slot on its task record
 * (`TaskSnapshot.pendingApprovalId`, `packages/server/src/hub.ts`) that
 * `task.await_approval` overwrites and `task.approval_resolved` clears. Cloud
 * holds no session state and no second store: the SAME two observations are
 * already durable in the `ApprovalTimelineStore` tail
 * (`approval-timeline.ts`), appended by the inbound gate, so the slot is
 * DERIVED from that tail on each call rather than mirrored into a record that
 * could then disagree with it.
 *
 * The derivation is a fold over the tail's entries in revision order, holding
 * exactly one slot — deliberately the server's shape, not a set of concurrently
 * pending approvals:
 *
 *   - `approval_requested` SETS the slot, superseding whatever it held. A
 *     daemon that dispatched a fresh approval without this cloud ever seeing
 *     the previous one resolved has moved on, and the newest request is what
 *     an operator is being asked about (`hub.ts:1399`).
 *   - `approval_resolved(X)` CLEARS the slot when the slot's own id is `X`, or
 *     when the slot has no id at all (a pre-M5 daemon never reported one, so
 *     the resolution can only be about the single outstanding request). A
 *     resolution naming some OTHER id is about an approval already superseded
 *     and leaves the current slot standing (`hub.ts:1569`).
 *
 * Two ways there is legitimately nothing pending: the tail has no unresolved
 * request, or the tail is gone entirely — it is a bounded, TTL'd observation
 * ring, not an authority that keeps facts forever. Both answer `undefined`,
 * and the callers fail closed on it. A dropped-then-expired approval is not
 * silently approved.
 */
import type { ApprovalTimelineTail } from './approval-timeline';

/**
 * M5 (approval targeting): thrown by `ByokCloud.approveTask`/`rejectTask` when
 * the caller supplied an `approvalId` that does NOT match the approval this
 * task currently has pending — the caller is targeting a SPECIFIC approval the
 * daemon has already superseded with a newer one.
 *
 * Distinct from the `task_not_awaiting_approval` `ByokCloudError` (there
 * is no pending approval at all, checked FIRST so it still wins when both would
 * apply): this error means the task genuinely IS awaiting an approval, just not
 * the one the caller thinks it is. Thrown before any mailbox row is allocated —
 * a stale-id call has zero side effects.
 *
 * A distinct class rather than a `CloudErrorCode`, unlike the rest of
 * this package's failures, because it carries the two ids the caller needs to
 * re-target: a code alone cannot say what the pending approval actually is.
 */
export class StaleApprovalError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly requestedApprovalId: string,
    public readonly currentApprovalId: string | undefined,
  ) {
    super(
      `cannot resolve approval ${requestedApprovalId} for task ${taskId}: the currently pending approval is ${
        currentApprovalId ?? '(none recorded)'
      }`,
    );
    this.name = 'StaleApprovalError';
  }
}

/** The one approval a task currently has outstanding. */
export interface PendingApproval {
  /**
   * The daemon's own id for this approval. ABSENT for a pre-M5 daemon that
   * reported `task.await_approval` without one — the approval is still pending
   * and still resolvable, it just cannot be targeted, so a caller-supplied
   * `approvalId` proceeds untargeted exactly as it does on the server.
   */
  readonly approvalId?: string;
  /** Immutable daemon envelope identity for this exact request observation. */
  readonly sourceEnvelopeId: string;
  /** Monotonic timeline revision for this exact request observation. */
  readonly revision: number;
}

/**
 * The task's current pending approval, or `undefined` when it has none — see
 * this module's own doc comment for the fold and why it holds one slot.
 */
export function pendingApproval(
  tail: ApprovalTimelineTail | undefined,
): PendingApproval | undefined {
  if (tail === undefined) return undefined;
  let pending: PendingApproval | undefined;
  for (const entry of tail.entries) {
    const event = entry.event;
    if (event.type === 'approval_requested') {
      pending = {
        sourceEnvelopeId: entry.sourceEnvelopeId,
        revision: entry.revision,
        ...(event.approvalId === undefined ? {} : { approvalId: event.approvalId }),
      };
      continue;
    }
    if (pending === undefined) continue;
    if (pending.approvalId === undefined || pending.approvalId === event.approvalId) {
      pending = undefined;
    }
  }
  return pending;
}
