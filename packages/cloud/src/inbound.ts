/**
 * The single inbound choke point for every daemon -> cloud envelope.
 *
 * The reference server runs this gate inside a live `ConnectionHub`; here it
 * is a pure function over a tenant-closed facade, so the same order holds with
 * no connection, no session, and no cross-request state:
 *
 * 0. **rate limit** — one token per inbound envelope, debited BEFORE anything
 *    else, so a flood of garbage-typed envelopes costs the same budget as a
 *    flood of well-formed ones. S3a's reference limiter allows everything; the
 *    seam is what matters at this position.
 * 1. **type-allow** — only `DAEMON_TO_SERVER_TYPES` may pass, plus the
 *    authenticated long-poll `conn.hello` capability snapshot handled below.
 *    A server -> daemon type arriving inbound, or anything unrecognized, is
 *    rejected before it is dispatched or counted accepted.
 * 2. **ownership** — an envelope for a task already owned by a DIFFERENT
 *    device is dropped, never force-failed: force-failing on an authz mismatch
 *    would let an attacker who merely guesses a `taskId` kill the real owner's
 *    task. A task with no owner yet, or that this tenant does not have at all,
 *    is not rejected here — the store's own no-op-on-missing behavior covers
 *    the latter, and it covers it per tenant, so a guessed id from another
 *    tenant writes nothing anywhere.
 * 3. **dedup** — an envelope id already seen from this device is a no-op. The
 *    wire is at-least-once (§9); this makes processing at-most-once.
 * 4. **apply** — the lifecycle write.
 *
 * A duplicate is still a wire-level success (§8.2): it just did not re-run
 * anything. Only `rejected`/`rate_limited` are excluded from `accepted`.
 */
import {
  DAEMON_TO_SERVER_TYPES,
  encodeEnvelope,
  PROTOCOL_VERSION,
  type AgentRef,
  type Envelope,
  type MessageType,
} from '@byok-sdk/protocol';
import {
  validateActivityBatch,
  appendActivityEvents,
  DEFAULT_ACTIVITY_BOUNDS,
  type ActivityBounds,
} from './coordination';
import {
  validateApprovalTimelineAppend,
  type ApprovalTimelineAppendInput,
} from './approval-timeline';
import { isCloudError } from './errors';
import { projectTerminalToReview } from './board-projection';
import type { TenantStores } from './tenant-stores';

export type InboundOutcome = 'accepted' | 'duplicate' | 'rejected' | 'rate_limited';

/** Receipt key a task's terminal is recorded under — the idempotency seam S3b's journal will share. */
export function terminalReceiptKey(taskId: string): string {
  return `task:${taskId}:terminal`;
}

function sameAgentRef(expected: AgentRef, actual: AgentRef | undefined): boolean {
  return actual?.agentId === expected.agentId && actual.profileRevision === expected.profileRevision;
}

function inboundAgentRef(envelope: Envelope): AgentRef | undefined {
  switch (envelope.type) {
    case 'task.claim':
    case 'task.decline':
    case 'task.complete':
    case 'task.fail':
    case 'task.cancelled':
      return envelope.payload.agentRef;
    default:
      return undefined;
  }
}

function agentRefEchoRequired(envelope: Envelope): boolean {
  return (
    envelope.type === 'task.claim' ||
    envelope.type === 'task.decline' ||
    envelope.type === 'task.complete' ||
    envelope.type === 'task.fail' ||
    envelope.type === 'task.cancelled'
  );
}

export async function handleInboundEnvelope(
  stores: TenantStores,
  deviceId: string,
  envelope: Envelope,
  activityBounds: ActivityBounds = DEFAULT_ACTIVITY_BOUNDS,
): Promise<InboundOutcome> {
  if (!(await stores.rateLimiter.consume(deviceId))) return 'rate_limited';

  // Long-poll has no live WS handshake. A bearer-authenticated conn.hello is
  // therefore accepted only as a capability snapshot for the same device
  // principal, and is persisted in the durable device row. This is the sole
  // cloud path that admits the target capability; presence is not consulted.
  if (envelope.type === 'conn.hello') {
    if (envelope.payload.deviceId !== deviceId) return 'rejected';
    if (!envelope.payload.protocolVersions.includes(PROTOCOL_VERSION)) return 'rejected';
    const device = await stores.devices.get(deviceId);
    if (device === undefined || device.revoked || device.productId !== envelope.payload.productId) {
      return 'rejected';
    }
    if (await stores.dedup.checkAndRecord(deviceId, envelope.id)) return 'duplicate';
    return (await stores.devices.recordCapabilities({ capabilities: envelope.payload.capabilities })) === undefined
      ? 'rejected'
      : 'accepted';
  }

  if (!(DAEMON_TO_SERVER_TYPES as readonly MessageType[]).includes(envelope.type)) return 'rejected';

  const taskId = envelope.task_id;
  // Every `DAEMON_TO_SERVER_TYPES` member requires `task_id` at the schema
  // level; this is the defensive restatement, not a second contract.
  if (taskId === undefined) return 'rejected';

  const attempt = await stores.tasks.get(taskId);
  // Strict Agent offers are explicitly placed. Unlike legacy unowned task
  // attempts, a different tenant device may not claim or report one merely by
  // guessing its task id.
  if (attempt?.agentRef !== undefined && attempt.deviceId !== deviceId) return 'rejected';
  if (attempt?.ownerDeviceId !== undefined && attempt.ownerDeviceId !== deviceId) return 'rejected';
  // Agent identity is an exact-match boundary. A missing echo is a mismatch
  // just like a different id or profile revision; accepting it would let an
  // unrelated session write a terminal for the durable Agent attempt.
  if (
    attempt?.agentRef !== undefined &&
    agentRefEchoRequired(envelope) &&
    !sameAgentRef(attempt.agentRef, inboundAgentRef(envelope))
  ) {
    return 'rejected';
  }

  if (envelope.type === 'task.progress' && envelope.payload.events.length > 0) {
    try {
      validateActivityBatch(
        {
          taskId,
          sourceEnvelopeId: envelope.id,
          batchSeq: envelope.payload.seq,
          events: envelope.payload.events,
          dropped: 0,
        },
        activityBounds,
      );
    } catch (caught) {
      if (
        isCloudError(caught, 'activity_batch_too_large') ||
        isCloudError(caught, 'coordination_input_invalid')
      ) {
        return 'rejected';
      }
      throw caught;
    }
  }

  const approvalInput = approvalTimelineAppendInput(taskId, envelope);
  if (approvalInput !== undefined) {
    try {
      validateApprovalTimelineAppend(approvalInput);
    } catch (caught) {
      if (isCloudError(caught, 'coordination_input_invalid')) return 'rejected';
      throw caught;
    }
  }

  if (await stores.dedup.checkAndRecord(deviceId, envelope.id)) return 'duplicate';

  await applyLifecycle(stores, deviceId, taskId, envelope, activityBounds, attempt?.agentRef);
  return 'accepted';
}

/**
 * The lifecycle half. Deliberately thin: S3a records ownership, the coarse
 * attempt status, the terminal receipt, and bounded activity/approval
 * observations. Artifacts are accepted and carried, but the durable record of
 * what a task *produced* belongs to the truth and board planes (S5/S6) and to
 * S3b's journal — not to a map in this package.
 */
async function applyLifecycle(
  stores: TenantStores,
  deviceId: string,
  taskId: string,
  envelope: Envelope,
  activityBounds: ActivityBounds,
  persistedAgentRef: AgentRef | undefined,
): Promise<void> {
  switch (envelope.type) {
    case 'task.claim':
      await stores.tasks.claim({ taskId, deviceId });
      return;
    case 'task.started':
      await stores.tasks.recordStatus({
        taskId,
        status: 'running',
        ...(persistedAgentRef === undefined ? {} : { agentRef: persistedAgentRef }),
      });
      return;
    case 'task.decline':
      await stores.tasks.recordStatus({
        taskId,
        status: 'failed',
        ...(persistedAgentRef === undefined ? {} : { agentRef: persistedAgentRef }),
      });
      return;
    case 'task.progress':
      if (envelope.payload.events.length > 0) {
        await appendActivityEvents(
          stores.activity,
          {
            taskId,
            sourceEnvelopeId: envelope.id,
            batchSeq: envelope.payload.seq,
            events: envelope.payload.events,
            dropped: 0,
          },
          activityBounds,
        );
      }
      return;
    case 'task.await_approval':
      await stores.approvals.append(approvalTimelineAppendInput(taskId, envelope)!);
      return;
    case 'task.approval_resolved':
      await stores.approvals.append(approvalTimelineAppendInput(taskId, envelope)!);
      return;
    case 'task.complete':
      await recordTerminal(stores, taskId, envelope, 'complete');
      return;
    case 'task.fail':
      await recordTerminal(stores, taskId, envelope, 'failed');
      return;
    case 'task.cancelled':
      await recordTerminal(stores, taskId, envelope, 'cancelled');
      return;
    default:
      return;
  }
}

function approvalTimelineAppendInput(
  taskId: string,
  envelope: Envelope,
): ApprovalTimelineAppendInput | undefined {
  switch (envelope.type) {
    case 'task.await_approval':
      return {
        taskId,
        sourceEnvelopeId: envelope.id,
        event: {
          type: 'approval_requested',
          summary: envelope.payload.summary,
          ...(envelope.payload.approvalId === undefined
            ? {}
            : { approvalId: envelope.payload.approvalId }),
        },
      };
    case 'task.approval_resolved':
      return {
        taskId,
        sourceEnvelopeId: envelope.id,
        event: {
          type: 'approval_resolved',
          approvalId: envelope.payload.approvalId,
          decision: envelope.payload.decision,
          resolvedBy: envelope.payload.resolvedBy,
          at: envelope.payload.at,
        },
      };
    default:
      return undefined;
  }
}

/**
 * First terminal wins (§12.6.4: 不覆写第一份事实). A retried terminal — same
 * task, new envelope id, so dedup does not catch it — records nothing new and
 * leaves the attempt status where the first one put it.
 *
 * What gets stored is `encodeEnvelope(envelope)`: the canonical v1 encoding of
 * the envelope this gate already zod-parsed, NOT the device's original byte
 * sequence. The two are semantically identical by the frozen codec's own
 * round-trip guarantee, but they are not necessarily byte-identical (key
 * order, whitespace, and any field the schema drops are the parser's call, not
 * the device's) — so this receipt is evidence of the first terminal FACT, not
 * a byte-faithful capture of the first terminal REQUEST. S3b's local journal
 * is where the device's own bytes are kept.
 */
async function recordTerminal(
  stores: TenantStores,
  taskId: string,
  envelope: Envelope,
  status: 'complete' | 'failed' | 'cancelled',
): Promise<void> {
  const attempt = await stores.tasks.get(taskId);
  const { created } = await stores.receipts.record({
    key: terminalReceiptKey(taskId),
    body: encodeEnvelope(envelope),
  });
  if (attempt?.cancellation !== undefined) {
    if (status === 'cancelled') {
      await stores.tasks.recordStatus({
        taskId,
        status: 'cancelled',
        ...(attempt.agentRef === undefined ? {} : { agentRef: attempt.agentRef }),
      });
    }
    return;
  }
  if (!created) return;
  const cause =
    envelope.type === 'task.fail' || envelope.type === 'task.cancelled' ? envelope.payload.reason : undefined;
  const recordedAttempt = await stores.tasks.recordStatus({
    taskId,
    status,
    ...(attempt?.agentRef === undefined ? {} : { agentRef: attempt.agentRef }),
    ...(cause === undefined ? {} : { terminalCause: cause }),
  });
  // The attempt mutation is the ordering CAS. Cancellation may have landed
  // after the read above but before this write; in that race the store returns
  // the cancellation-bearing attempt and no business projection is allowed.
  if (recordedAttempt?.status !== status || recordedAttempt.cancellation !== undefined) return;
  await projectTerminalToReview(stores.board, taskId);
}
