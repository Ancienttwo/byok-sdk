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
 *
 * 5. **observe** — an optional {@link ByokCloudObserver} is told, once, about
 *    each envelope whose write committed. It runs after step 4 has returned,
 *    it cannot change the outcome, and it is not the admission hook.
 */
import {
  AGENT_CONTENT_ARTIFACT_READ_CAPABILITY,
  AGENT_CONTENT_TRANSCRIPT_READ_CAPABILITY,
  AGENT_CONTENT_WORKSPACE_READ_CAPABILITY,
  AGENT_EGRESS_POLICY_CAPABILITY,
  AGENT_EGRESS_RELIABLE_ACK_CAPABILITY,
  AGENT_MESSAGE_EGRESS_CAPABILITY,
  AgentContentReadPayloadSchema,
  DAEMON_TO_SERVER_TYPES,
  encodeEnvelope,
  PROTOCOL_VERSION,
  type AgentRef,
  type AgentContentReceiptPayload,
  type AgentContentReadPayload,
  type AgentEgressReliablePayload,
  type AgentMessageDispositionPayload,
  type AgentMessagePublishPayload,
  type AgentMessageServerContext,
  type Envelope,
  type MessageType,
} from '@byok-sdk/protocol';
import type { TenantId } from '@byok-sdk/core';
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

/**
 * One envelope whose write COMMITTED, handed to {@link ByokCloudObserver}.
 *
 * `outcome` is constant by construction — `accepted` is the only outcome that
 * committed anything — and is carried anyway because it names the fact in the
 * gate's own vocabulary rather than leaving the reader to infer it from the
 * hook's name. A `duplicate` re-ran nothing, a `rejected` and a `rate_limited`
 * wrote nothing; none of them appear here.
 */
export interface InboundCommitted {
  readonly tenantId: TenantId;
  readonly deviceId: string;
  readonly envelope: Envelope;
  readonly outcome: Extract<InboundOutcome, 'accepted'>;
}

/**
 * Post-commit relay for the host (the `TaskHandle` fan-out `@byok-sdk/server`
 * drives off its live hub).
 *
 * Deliberately NOT the admission hook. `ByokCloudOptions.agentMessage.consume`
 * runs BEFORE a write and decides whether it happens; this runs AFTER one and
 * cannot decide anything: it returns `void`, it is called inside a `try`, and
 * a throw from it is swallowed with the outcome already fixed. An observer
 * that wants to refuse work has the admission hook; an observer here is
 * watching, not gating.
 *
 * Synchronous and cheap by contract — it runs inline on the request path.
 */
export interface ByokCloudObserver {
  onInboundCommitted(input: InboundCommitted): void;
}

export async function handleAgentMessagePublish(
  stores: TenantStores,
  deviceId: string,
  taskId: string,
  payload: AgentMessagePublishPayload,
  consume: ((input: {
    readonly tenant: TenantStores['tenant'];
    readonly deviceId: string;
    readonly taskId: string;
    readonly context: AgentMessageServerContext;
    readonly payload: AgentMessagePublishPayload;
  }) => Promise<{ readonly outcome: 'accepted' | 'held' | 'refused'; readonly reasonCode?: string }>) | undefined,
  alreadyDeduplicated: boolean,
): Promise<{ readonly outcome: InboundOutcome; readonly disposition?: AgentMessageDispositionPayload }> {
  const device = await stores.devices.get(deviceId);
  const attempt = await stores.tasks.get(taskId);
  const binding = await stores.receipts.get(`agent-message-offer:${deviceId}:${taskId}`);
  if (
    device === undefined || device.revoked ||
    !hasCapabilities(device.capabilities, [AGENT_MESSAGE_EGRESS_CAPABILITY]) ||
    attempt === undefined || attempt.deviceId !== deviceId || binding === undefined ||
    attempt.agentRef === undefined || !sameAgentRef(attempt.agentRef, payload.agentRef)
  ) return { outcome: 'rejected' };

  let frozen: { agentRef?: AgentRef; sessionRef?: string; requirement?: { contract?: string; contentType?: string; maxBytes?: number }; context?: AgentMessageServerContext };
  try { frozen = JSON.parse(binding.body) as typeof frozen; } catch { return { outcome: 'rejected' }; }
  if (
    !sameAgentRef(frozen.agentRef!, payload.agentRef) ||
    frozen.context === undefined ||
    frozen.requirement?.contract !== payload.contract ||
    (frozen.sessionRef !== undefined && frozen.sessionRef !== payload.sessionRef) ||
    frozen.requirement.contentType !== payload.contentType ||
    typeof frozen.requirement.maxBytes !== 'number' || payload.byteCount > frozen.requirement.maxBytes
  ) return { outcome: 'rejected' };

  // Terminal receipt replay is intentionally before the live-state reservation:
  // an already-consumed side effect remains a replay even when the task has
  // subsequently become complete or cancellation-requested.
  const priorDisposition = await readAgentMessageDisposition(stores, deviceId, taskId, payload);
  if (priorDisposition !== undefined) return { outcome: 'duplicate', disposition: priorDisposition };

  if (alreadyDeduplicated) return { outcome: 'rejected' };

  const payloadBody = JSON.stringify(payload);
  const reservation = await stores.tasks.reserveAgentMessage({
    taskId,
    deviceId,
    messageId: payload.messageId,
    payloadBody,
  });
  if (reservation === 'pending') return { outcome: 'rejected' };
  if (reservation !== 'reserved') return { outcome: 'rejected' };

  let decision: { readonly outcome: 'accepted' | 'held' | 'refused'; readonly reasonCode?: string };
  if (consume === undefined) {
    decision = { outcome: 'held', reasonCode: 'consumer_unavailable' };
  } else {
    try {
      decision = await consume({ tenant: stores.tenant, deviceId, taskId, context: frozen.context, payload });
    } catch {
      // A throwing consumer may have already crossed an external side-effect
      // boundary. Freeze a held terminal rather than retrying that consumer.
      decision = { outcome: 'held', reasonCode: 'consumer_failed' };
    }
  }
  const disposition = agentMessageDisposition(payload, decision);
  const admission = await stores.tasks.finalizeAgentMessage({
    taskId,
    deviceId,
    messageId: payload.messageId,
    payloadBody,
    terminalBody: JSON.stringify({ payload, disposition }),
  });
  const terminal = admission?.terminalBody === undefined
    ? undefined
    : parseAgentMessageDisposition(payload, admission.terminalBody);
  return terminal === undefined ? { outcome: 'rejected' } : { outcome: 'accepted', disposition: terminal };
}

function agentMessageDisposition(
  payload: AgentMessagePublishPayload,
  decision: { readonly outcome: 'accepted' | 'held' | 'refused'; readonly reasonCode?: string },
): AgentMessageDispositionPayload {
  return {
    agentRef: payload.agentRef,
    sessionRef: payload.sessionRef,
    contract: payload.contract,
    messageId: payload.messageId,
    cursor: payload.cursor,
    contentHash: payload.contentHash,
    outcome: decision.outcome,
    receiptId: crypto.randomUUID(),
    ...(decision.reasonCode === undefined ? {} : { reasonCode: decision.reasonCode }),
  };
}

/** Reads only a terminal immutable admission; pending rows have no disposition to acknowledge. */
export async function readAgentMessageDisposition(
  stores: TenantStores,
  deviceId: string,
  taskId: string,
  payload: AgentMessagePublishPayload,
): Promise<AgentMessageDispositionPayload | undefined> {
  const admission = await stores.tasks.readAgentMessage({
    taskId,
    deviceId,
    messageId: payload.messageId,
    payloadBody: JSON.stringify(payload),
  });
  return admission?.terminalBody === undefined ? undefined : parseAgentMessageDisposition(payload, admission.terminalBody);
}

function parseAgentMessageDisposition(
  payload: AgentMessagePublishPayload,
  terminalBody: string,
): AgentMessageDispositionPayload | undefined {
  try {
    const decoded = JSON.parse(terminalBody) as {
      readonly payload?: AgentMessagePublishPayload;
      readonly disposition?: AgentMessageDispositionPayload;
    };
    return decoded.disposition !== undefined && JSON.stringify(decoded.payload) === JSON.stringify(payload)
      ? decoded.disposition
      : undefined;
  } catch {
    return undefined;
  }
}

/** Receipt key a task's terminal is recorded under — the idempotency seam S3b's journal will share. */
export function terminalReceiptKey(taskId: string): string {
  return `task:${taskId}:terminal`;
}

function sameAgentRef(expected: AgentRef, actual: AgentRef | undefined): boolean {
  return actual?.agentId === expected.agentId && actual.profileRevision === expected.profileRevision;
}

function sameReliableEgress(
  expected: AgentEgressReliablePayload,
  actual: AgentEgressReliablePayload,
): boolean {
  return (
    sameAgentRef(expected.agentRef, actual.agentRef) &&
    expected.sessionRef === actual.sessionRef &&
    expected.policyRevision === actual.policyRevision &&
    expected.eventId === actual.eventId &&
    expected.cursor === actual.cursor &&
    expected.contentHash === actual.contentHash &&
    expected.byteCount === actual.byteCount &&
    JSON.stringify(expected.payload) === JSON.stringify(actual.payload)
  );
}

function contentReadCapability(surface: AgentContentReceiptPayload['surface']): string {
  switch (surface) {
    case 'workspace':
      return AGENT_CONTENT_WORKSPACE_READ_CAPABILITY;
    case 'transcript':
      return AGENT_CONTENT_TRANSCRIPT_READ_CAPABILITY;
    case 'artifact':
      return AGENT_CONTENT_ARTIFACT_READ_CAPABILITY;
  }
}

function hasCapabilities(capabilities: readonly string[] | undefined, required: readonly string[]): boolean {
  return capabilities !== undefined && required.every((capability) => capabilities.includes(capability));
}

function contentRequestReceiptKey(deviceId: string, requestId: string): string {
  return `agent-content-request:${deviceId}:${requestId}`;
}

function contentReceiptKey(deviceId: string, requestId: string): string {
  return `agent-content:${deviceId}:${requestId}`;
}

function matchesContentReadReceipt(request: AgentContentReadPayload, receipt: AgentContentReceiptPayload): boolean {
  return (
    request.requestId === receipt.requestId &&
    request.surface === receipt.surface &&
    request.actor.kind === receipt.actor.kind &&
    request.actor.id === receipt.actor.id &&
    sameAgentRef(request.agentRef, receipt.agentRef) &&
    request.sessionRef === receipt.sessionRef &&
    request.runtime === receipt.runtime &&
    request.cwd === receipt.cwd &&
    request.policyRevision === receipt.policyRevision &&
    request.target === receipt.target &&
    request.mimeType === receipt.mimeType &&
    request.decodeAs === receipt.decodeAs
  );
}

async function readContentRequest(
  stores: TenantStores,
  deviceId: string,
  requestId: string,
): Promise<AgentContentReadPayload | undefined> {
  const stored = await stores.receipts.get(contentRequestReceiptKey(deviceId, requestId));
  if (stored === undefined) return undefined;
  try {
    return AgentContentReadPayloadSchema.parse(JSON.parse(stored.body));
  } catch {
    return undefined;
  }
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
  agentMessageConsume?: Parameters<typeof handleAgentMessagePublish>[4],
  observer?: ByokCloudObserver,
): Promise<InboundOutcome> {
  const outcome = await applyInboundGate(
    stores,
    deviceId,
    envelope,
    activityBounds,
    agentMessageConsume,
  );
  // One notification per envelope whose write committed, at the ONE exit the
  // gate has. Firing from the gate's own return points instead would have to
  // be repeated at each of them and would be one edit away from firing twice
  // or not at all.
  if (outcome === 'accepted' && observer !== undefined) {
    try {
      observer.onInboundCommitted({ tenantId: stores.tenant, deviceId, envelope, outcome });
    } catch {
      // The write already committed. A relay that throws is the host's problem
      // to see in its own instrumentation; it cannot retract a durable fact, so
      // it does not get to change what this route answers either.
    }
  }
  return outcome;
}

async function applyInboundGate(
  stores: TenantStores,
  deviceId: string,
  envelope: Envelope,
  activityBounds: ActivityBounds,
  agentMessageConsume: Parameters<typeof handleAgentMessagePublish>[4] | undefined,
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

  if (envelope.type === 'agent.message.publish') {
    const alreadyDeduplicated = await stores.dedup.checkAndRecord(deviceId, envelope.id);
    return (await handleAgentMessagePublish(
      stores,
      deviceId,
      envelope.task_id,
      envelope.payload,
      agentMessageConsume,
      alreadyDeduplicated,
    )).outcome;
  }

  if (envelope.type === 'agent.egress.reliable') {
    const device = await stores.devices.get(deviceId);
    if (
      device === undefined ||
      device.revoked ||
      !hasCapabilities(device.capabilities, [AGENT_EGRESS_POLICY_CAPABILITY, AGENT_EGRESS_RELIABLE_ACK_CAPABILITY])
    ) {
      return 'rejected';
    }
    const outcome = await stores.egress.record({
      deviceId,
      payload: envelope.payload,
      receiptId: crypto.randomUUID(),
    });
    return outcome.created || sameReliableEgress(outcome.record.payload, envelope.payload)
      ? outcome.created
        ? 'accepted'
        : 'duplicate'
      : 'rejected';
  }

  if (envelope.type === 'agent.content.receipt') {
    const device = await stores.devices.get(deviceId);
    if (
      device === undefined ||
      device.revoked ||
      envelope.payload.eventId !== envelope.payload.requestId ||
      !hasCapabilities(device.capabilities, [contentReadCapability(envelope.payload.surface), AGENT_EGRESS_RELIABLE_ACK_CAPABILITY])
    ) {
      return 'rejected';
    }
    const request = await readContentRequest(stores, deviceId, envelope.payload.requestId);
    if (request === undefined || !matchesContentReadReceipt(request, envelope.payload)) return 'rejected';
    const key = contentReceiptKey(deviceId, envelope.payload.requestId);
    // The durable fact is the protocol-validated payload, not a transport
    // envelope whose id/timestamp changes when the Agent replays its spool.
    // Zod has already projected this to its canonical field order, so equal
    // protocol facts have one byte representation while a changed cursor or
    // BlobRef metadata is rejected as a conflicting second receipt.
    const body = JSON.stringify(envelope.payload);
    const receipt = await stores.receipts.record({ key, body });
    return receipt.created ? 'accepted' : receipt.receipt.body === body ? 'duplicate' : 'rejected';
  }

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
      // The claiming adapter's own self-report, carried straight through as
      // the write-once claim snapshot. Nothing is read from the durable
      // connection-level capability list here (`DeviceRecord.capabilities`,
      // written by `conn.hello` above): that describes a device build, not the
      // adapter that took THIS task, and letting it reach the snapshot is the
      // exact scope defect the steer gate exists to forbid.
      await stores.tasks.claim({
        taskId,
        deviceId,
        ...(envelope.payload.runtime === undefined ? {} : { runtime: envelope.payload.runtime }),
        ...(envelope.payload.capabilities === undefined
          ? {}
          : { capabilities: envelope.payload.capabilities }),
      });
      return;
    case 'task.started':
      await stores.tasks.recordStatus({
        taskId,
        status: 'running',
        ...(persistedAgentRef === undefined ? {} : { agentRef: persistedAgentRef }),
      });
      return;
    case 'task.decline':
      // A decline is a terminal (§3.2, `Offered -> Failed`), so it takes the
      // same path as complete/fail/cancelled: one terminal receipt under the
      // same key, first-terminal-wins, and therefore a readable result.
      // Recording only the coarse `failed` status here left an attempt that a
      // reader could see reach a terminal and then find no result to read.
      await recordTerminal(stores, taskId, envelope, 'failed');
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
    envelope.type === 'task.fail' ||
    envelope.type === 'task.cancelled' ||
    envelope.type === 'task.decline'
      ? envelope.payload.reason
      : undefined;
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
