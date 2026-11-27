import type { HostOfferPlainPayload, HostOfferSealedPayload } from '@byok-sdk/protocol';
import type { ByokCloud, ByokCloudOptions, EnqueuedAgentControl, EnqueuedOffer } from '../cloud.js';
import { contentHash, type ControlPlanePrincipal, type TenantId } from '@byok-sdk/core';
import { isProviderProfileModelId } from '@byok-sdk/core/provider-model';
import {
  AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY,
  NATIVE_SESSIONS_CAPABILITY,
  AgentContentReceiptPayloadSchema,
  AgentEgressAckPayloadSchema,
  AgentMessageServerContextSchema,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  harnessSelectionNeedsModel,
  harnessSupportsTarget,
  isSealedPayload,
  requiredReceiverCapabilities,
  uuidFromSha256,
  type AgentContentReceiptPayload,
  type AgentEgressAckPayload,
  type AgentMessageDispositionPayload,
  type AgentMessageServerContext,
  type AgentRef,
  type Envelope,
  type ExecutionTarget,
  type SessionSelection,
  type TaskOfferPayload,
} from '@byok-sdk/protocol';
import { sameAgentRef } from '../agent-message-disposition.js';
import { ByokCloudError, DeviceRetiredError, TaskOfferAppendRefusedError } from '../errors.js';
import { taskOfferMessageId } from '../offer-identity.js';
import { firstSealedPayload } from '../sealed-comparison.js';
import { retainSealedCiphertext, sealedCiphertextCommitted, sealedCiphertextRef } from '../sealed-ciphertext.js';
import type { AgentEgressRecord, TaskAttemptStatus } from '../stores/ports.js';
import { sameTaskBody } from '../task-redaction.js';
import { tenantStoresFor, type CloudRootStores, type TenantStores } from '../tenant-stores.js';

/**
 * Attempt statuses past which there is nothing left to approve or refuse. A
 * predicate rather than a `Set`: `constraints.test.ts` keeps every in-process
 * collection inside a store class, and this needs none.
 */
export function isTerminalAttemptStatus(status: TaskAttemptStatus): boolean {
  return status === 'complete' || status === 'failed' || status === 'cancelled';
}

/**
 * The wire requires UUID-shaped envelope ids, while retries need a stable
 * identity.  Reserve UUIDv8 for this opaque sha256-derived namespace rather
 * than pretending a fresh random UUID can identify the same logical action.
 */

function sameOfferEnvelope(expected: Envelope, actual: Envelope): boolean {
  // `ts` is deliberately excluded: it records when this particular producer
  // invocation ran, not the task body that a stable message identity names.
  return (
    expected.id === actual.id &&
    expected.type === actual.type &&
    expected.task_id === actual.task_id &&
    JSON.stringify(expected.payload) === JSON.stringify(actual.payload)
  );
}

/**
 * A plaintext lane refuses the sealed fields (#654), before any device read,
 * attempt, receipt or mailbox write. The message names the sealed lane when the
 * plaintext lane has one; a resume lane has no sealed counterpart.
 */
export function refuseSealedFields(payload: unknown, fields: readonly string[], sealedEntry?: string): void {
  if (payload === null || typeof payload !== 'object') return;
  const present = fields.filter((field) => field in payload);
  if (present.length > 0) {
    const message = sealedEntry === undefined
      ? `${present.join(', ')} belongs to a sealed lane; this lane has no sealed counterpart`
      : `${present.join(', ')} belongs to the sealed lane; use ${sealedEntry}`;
    throw new ByokCloudError('coordination_input_invalid', message);
  }
}

/** Give malformed overrides a typed enqueue refusal before parsing or persistence. */
export function assertProviderProfileModelOverride(payload: { readonly target?: ExecutionTarget } | undefined): void {
  const target = payload?.target;
  if (target?.lane === 'harness' && target.selection?.mode === 'byok-profile'
    && target.selection.modelId !== undefined && !isProviderProfileModelId(target.selection.modelId)) {
    throw new ByokCloudError('invalid_request', 'invalid provider profile model ID');
  }
}

export async function materializeEnvelope(body: string, crypto: ByokCloudOptions['crypto']) {
  const bytes = new TextEncoder().encode(body);
  return {
    body,
    bodyHash: contentHash(await crypto.sha256(bytes)),
    byteSize: BigInt(bytes.length),
  };
}

interface Dependencies {
  root: CloudRootStores;
  controlPlane: (tenant: TenantId) => ControlPlanePrincipal;
  options: ByokCloudOptions;
  readTaskOffer: ByokCloud['readTaskOffer'];
}

/**
 * The admission gates and mailbox appends shared by every Host enqueue lane
 * and by the device routes that acknowledge inbound messages.
 */
export function createEnqueuePaths({ root, controlPlane, options, readTaskOffer }: Dependencies) {
  /** The first offer owns resolution and admission; retries compare against that receipt without another device read. */
  async function resolveOfferPayload(
    tenant: TenantId, deviceId: string, payload: HostOfferPlainPayload | HostOfferSealedPayload,
    taskId?: string,
  ): Promise<TaskOfferPayload> {
    if (taskId !== undefined) {
      const messageId = await taskOfferMessageId(tenant, taskId, deviceId, payload.agentRef, bytes => options.crypto.sha256(bytes));
      await assertOfferUndelivered(tenantStoresFor(controlPlane(tenant), root), taskId, messageId);
    }
    const recorded = taskId === undefined ? undefined : await readTaskOffer(tenant, taskId);
    const { agentMemoryCommit, nativeSessions, ...rest } = payload;
    const conditionalCommit = agentMemoryCommit === 'on-success-if-advertised';
    const conditionalSessions = nativeSessions?.ifAdvertised === true;
    const device = recorded === undefined && (conditionalCommit || conditionalSessions)
      ? await options.cloud.devices.get(tenant, deviceId) : undefined;
    const commit = conditionalCommit
      ? (recorded !== undefined ? recorded.payload.agentMemoryCommit
        : device?.capabilities?.includes(AGENT_MEMORY_COMMIT_ON_SUCCESS_CAPABILITY) ? 'on-success' : undefined)
      : agentMemoryCommit;
    const window = nativeSessions !== undefined && (!conditionalSessions || (recorded !== undefined
      ? recorded.payload.nativeSessions !== undefined : device?.capabilities?.includes(NATIVE_SESSIONS_CAPABILITY)))
      ? { fromMs: nativeSessions.fromMs, toMs: nativeSessions.toMs } : undefined;
    const resolved = { ...rest, ...(commit === undefined ? {} : { agentMemoryCommit: commit }),
      ...(window === undefined ? {} : { nativeSessions: window }) };
    if (recorded === undefined) {
      await assertAgentCapabilities(tenant, deviceId, requiredReceiverCapabilities('task.offer', resolved));
      const target = resolved.target;
      if (target.lane === 'harness') {
        const registered = device ?? await options.cloud.devices.get(tenant, deviceId);
        const harness = registered?.harnesses?.find(entry => entry.id === target.harnessId);
        if (harness !== undefined && harnessSelectionNeedsModel(target.selection, harness.capabilities.defaultModelModes)) {
          throw new ByokCloudError('invalid_request', 'the requested harness selection requires a model ID');
        }
        if (harness === undefined || !harnessSupportsTarget(harness, target)) {
          const options = target.serviceTier === undefined ? 'effort' : 'effort and service tier options';
          throw new ByokCloudError('agent_capability_missing', `the device does not advertise the requested harness, selection mode and ${options}`);
        }
      }
    }
    return resolved;
  }

  async function assertOfferUndelivered(stores: TenantStores, taskId: string, messageId: string): Promise<void> {
    if (await stores.receipts.get(`task-offer-delivered:${messageId}`) !== undefined) {
      throw new ByokCloudError('agent_task_already_exists', `Task ${taskId} already has a durable delivered attempt and cannot be enqueued again.`);
    }
  }

  async function enqueueTaskEnvelope(
    tenant: TenantId,
    deviceId: string,
    requestedTaskId: string | undefined,
    agentRef: AgentRef,
    buildEnvelope: (taskId: string, seq: number, messageId: string) => Envelope,
    beforeMailbox?: (stores: TenantStores, taskId: string) => Promise<void>,
  ): Promise<EnqueuedOffer> {
    const stores = tenantStoresFor(controlPlane(tenant), root);
    const taskId = requestedTaskId ?? `task_${options.crypto.randomUuid()}`;
    const messageId = await taskOfferMessageId(tenant, taskId, deviceId, agentRef, bytes => options.crypto.sha256(bytes));
    const proposed = buildEnvelope(taskId, 0, messageId);
    await assertSealedCiphertext(tenant, proposed.payload);
    // An attempt is the task authority, so reserve it BEFORE the offer is
    // observable in a mailbox.  The stable message identity then makes an
    // append failure retry converge on the one offer rather than allocating a
    // second executable body.
    const reservation = await stores.tasks.reserveAgentOffer({ taskId, deviceId, agentRef });
    const openedBeforeAppend = reservation.attempt;
    if (
      openedBeforeAppend.deviceId !== deviceId ||
      !sameAgentRef(agentRef, openedBeforeAppend.agentRef)
    ) {
      throw new ByokCloudError('agent_ref_mismatch', `Task ${taskId} already has a different durable target or Agent identity.`);
    }

    const offerReceiptKey = `task-offer:${messageId}`;
    const deliveryReceiptKey = `task-offer-delivered:${messageId}`;
    // The task id is the immutable execution identity for every offer kind.
    // This receipt outlives mailbox retention, so a completed or retired task
    // can never be made executable again by reusing the caller-supplied id. A
    // missing marker is the sole retryable state after a pre-delivery failure.
    await assertOfferUndelivered(stores, taskId, messageId);

    // Reserve the immutable executable semantics before a fallible mailbox
    // append. The attempt intentionally contains no payload; this existing
    // idempotent receipt authority supplies the missing comparison so a retry
    // after append failure cannot silently replace an undelivered body.
    const proposedBody = JSON.stringify({
      deviceId,
      type: proposed.type,
      payload: proposed.payload,
    });
    const recorded = await stores.receipts.record({
      key: offerReceiptKey,
      body: proposedBody,
    });
    // A sealed retry may seal the same content again. When its comparison
    // projection matches, the first ciphertext stays the offer (§9.2).
    let build = buildEnvelope;
    let offerPayload: Record<string, unknown> = proposed.payload;
    if (!recorded.created && !(await sameTaskBody(recorded.receipt.body, proposedBody, options.crypto))) {
      const first = isSealedPayload(proposed.type, proposed.payload)
        ? firstSealedPayload(recorded.receipt.body, { deviceId, type: proposed.type, payload: proposed.payload })
        : undefined;
      if (first === undefined) {
        throw new ByokCloudError(
          'coordination_input_invalid',
          `Task ${taskId} already has a different executable offer body.`,
        );
      }
      build = (id, seq, message) => ({ ...buildEnvelope(id, seq, message), payload: first }) as Envelope;
      offerPayload = first;
    }

    await retainTaskCiphertext(tenant, taskId, offerPayload);
    await beforeMailbox?.(stores, taskId);
    // The attempt is already open, so a refused append must name it: a Host
    // that let cloud allocate the id has no other way to retry or cancel it.
    const message = await stores.mailbox.append({
      admission: 'limited',
      deviceId,
      messageId,
      materialize: async (seq) => {
        // Core stays protocol-free: the mailbox reserves the one authoritative
        // delivery number, then asks this producer to build opaque bytes while
        // allocation and insertion are still serialized per device.
        const envelope = build(taskId, seq, messageId);
        const body = encodeEnvelope(envelope);
        return materializeEnvelope(body, options.crypto);
      },
    }).catch(async (refusal: unknown) => {
      // A retired device's stream refuses every retry of this offer, and the
      // Host's cancel would append to the same closed stream, so the attempt
      // opened above is settled here with the retirement's cause.
      if (refusal instanceof DeviceRetiredError) {
        await stores.cancellations.abandon({ taskId, cause: refusal.retirementCause });
        throw new DeviceRetiredError(refusal.deviceId, refusal.retirementCause, { cause: refusal, taskId });
      }
      throw new TaskOfferAppendRefusedError(taskId, refusal);
    });
    const envelope = decodeEnvelope(message.body);
    if (envelope.seq !== message.seq) {
      throw new ByokCloudError(
        'mailbox_seq_mismatch',
        `Mailbox stored offer seq ${String(envelope.seq)} at row ${message.seq}; the daemon's redelivery cursor would be wrong.`,
      );
    }
    if (!sameOfferEnvelope(build(taskId, message.seq, messageId), envelope)) {
      throw new ByokCloudError(
        'coordination_input_invalid',
        `Task ${taskId} already has a different executable offer body.`,
      );
    }
    const delivered = await stores.receipts.record({ key: deliveryReceiptKey, body: messageId });
    if (!reservation.created && !delivered.created) {
      throw new ByokCloudError(
        'agent_task_already_exists',
        `Task ${taskId} already has a durable Agent attempt and cannot be enqueued again.`,
      );
    }
    return { taskId, seq: message.seq, envelope, attempt: openedBeforeAppend };
  }

  /** A sealed member above the inline limit names its ciphertext blob (#654); see {@link sealedCiphertextCommitted}. */
  async function assertSealedCiphertext(tenant: TenantId, payload: Record<string, unknown>): Promise<void> {
    const ref = sealedCiphertextRef(payload);
    if (ref !== undefined && !(await sealedCiphertextCommitted(tenantStoresFor(controlPlane(tenant), root).objects, ref))) {
      throw new ByokCloudError('coordination_input_invalid', 'A sealed ciphertextRef must name a committed object of this tenant with its size and content type.');
    }
  }

  async function retainTaskCiphertext(tenant: TenantId, taskId: string, payload: Record<string, unknown>): Promise<void> {
    const ref = sealedCiphertextRef(payload);
    if (ref !== undefined) await retainSealedCiphertext(tenantStoresFor(controlPlane(tenant), root).objects, taskId, ref);
  }

  async function assertAgentCapabilities(
    tenant: TenantId,
    deviceId: string,
    required: readonly string[],
  ): Promise<void> {
    // This is deliberately a durable device-row read. Core presence is
    // lossy/TTL-bounded and is never consulted for an execution admission.
    const device = await options.cloud.devices.get(tenant, deviceId);
    if (
      device === undefined ||
      device.revoked ||
      !device.capabilities ||
      !required.every((capability) => device.capabilities!.includes(capability))
    ) {
      const missing = required.filter((capability) => !device?.capabilities?.includes(capability));
      throw new ByokCloudError(
        'agent_capability_missing',
        `Device ${deviceId} lacks durable Agent capabilities (${missing.join(', ')}); refusing before mailbox append.`,
      );
    }
  }

  async function enqueueAgentControlEnvelope(
    tenant: TenantId,
    deviceId: string,
    messageId: string,
    buildEnvelope: (seq: number) => Envelope,
  ): Promise<EnqueuedAgentControl> {
    const stores = tenantStoresFor(controlPlane(tenant), root);
    const message = await stores.mailbox.append({
      admission: 'limited',
      deviceId,
      messageId,
      materialize: async (seq) => {
        const body = encodeEnvelope(buildEnvelope(seq));
        return materializeEnvelope(body, options.crypto);
      },
    });
    const envelope = decodeEnvelope(message.body);
    if (envelope.seq !== message.seq) {
      throw new ByokCloudError(
        'mailbox_seq_mismatch',
        `Mailbox stored Agent control seq ${String(envelope.seq)} at row ${message.seq}.`,
      );
    }
    return { seq: message.seq, envelope };
  }

  async function agentControlEnvelopeId(
    domain: string,
    tenant: TenantId,
    deviceId: string,
    agentRef: AgentRef,
    logicalRequestId: string,
  ): Promise<string> {
    return uuidFromSha256(
      await options.crypto.sha256(
        new TextEncoder().encode(
          JSON.stringify({ domain, tenant, deviceId, agentRef, logicalRequestId }),
        ),
      ),
    );
  }

  async function enqueueReliableEgressAck(stores: TenantStores, record: AgentEgressRecord): Promise<void> {
    const payload: AgentEgressAckPayload = AgentEgressAckPayloadSchema.parse({
      agentRef: record.payload.agentRef,
      sessionRef: record.payload.sessionRef,
      policyRevision: record.payload.policyRevision,
      eventId: record.payload.eventId,
      cursor: record.payload.cursor,
      receiptId: record.receiptId,
    });
    const message = await stores.mailbox.append({
      admission: 'limited',
      deviceId: record.deviceId,
      messageId: record.receiptId,
      materialize: async (seq) => {
        const body = encodeEnvelope(createEnvelope('agent.egress.ack', payload, { id: record.receiptId, seq }));
        return materializeEnvelope(body, options.crypto);
      },
    });
    const decoded = decodeEnvelope(message.body);
    if (
      decoded.type !== 'agent.egress.ack' ||
      decoded.seq !== message.seq ||
      JSON.stringify(decoded.payload) !== JSON.stringify(payload)
    ) {
      throw new ByokCloudError(
        'mailbox_receipt_mismatch',
        `Mailbox receipt ${record.receiptId} does not exactly acknowledge Agent egress ${record.payload.eventId}.`,
      );
    }
  }

  /** Durable content receipt first; this exact mailbox acknowledgement is then replayable by request id. */
  async function enqueueContentReceiptAck(
    stores: TenantStores,
    deviceId: string,
    receipt: AgentContentReceiptPayload,
  ): Promise<void> {
    const exactReceipt = AgentContentReceiptPayloadSchema.parse(receipt);
    if (exactReceipt.eventId !== exactReceipt.requestId) {
      throw new ByokCloudError('mailbox_receipt_mismatch', 'Content receipt eventId must equal requestId.');
    }
    const payload: AgentEgressAckPayload = AgentEgressAckPayloadSchema.parse({
      agentRef: exactReceipt.agentRef,
      sessionRef: exactReceipt.sessionRef,
      policyRevision: exactReceipt.policyRevision,
      eventId: exactReceipt.eventId,
      cursor: exactReceipt.cursor,
      receiptId: exactReceipt.requestId,
    });
    const message = await stores.mailbox.append({
      admission: 'limited',
      deviceId,
      // The request itself already occupies its bare request id in this
      // mailbox. A namespaced producer key keeps the ack idempotent without
      // returning that control envelope on duplicate receipt delivery.
      messageId: `agent-content-ack:${exactReceipt.requestId}`,
      materialize: async (seq) => {
        const body = encodeEnvelope(createEnvelope('agent.egress.ack', payload, { id: exactReceipt.requestId, seq }));
        return materializeEnvelope(body, options.crypto);
      },
    });
    const decoded = decodeEnvelope(message.body);
    if (
      decoded.type !== 'agent.egress.ack' ||
      decoded.seq !== message.seq ||
      JSON.stringify(decoded.payload) !== JSON.stringify(payload)
    ) {
      throw new ByokCloudError(
        'mailbox_receipt_mismatch',
        `Mailbox content receipt ${exactReceipt.requestId} does not exactly acknowledge its durable content fact.`,
      );
    }
  }

  async function enqueueAgentMessageDisposition(
    stores: TenantStores,
    deviceId: string,
    taskId: string,
    payload: AgentMessageDispositionPayload,
  ): Promise<void> {
    const message = await stores.mailbox.append({
      admission: 'limited',
      deviceId,
      messageId: `agent-message-disposition:${payload.receiptId}`,
      materialize: async (seq) => {
        const body = encodeEnvelope(createEnvelope('agent.message.disposition', payload, {
          id: payload.receiptId,
          taskId,
          seq,
        }));
        return materializeEnvelope(body, options.crypto);
      },
    });
    const decoded = decodeEnvelope(message.body);
    if (decoded.type !== 'agent.message.disposition' || decoded.seq !== message.seq) {
      throw new ByokCloudError('mailbox_receipt_mismatch', 'Agent message disposition mailbox readback mismatched.');
    }
  }

  function agentMessageOfferWriter(
    deviceId: string,
    payload: {
      agentRef: AgentRef;
      session: SessionSelection;
      messageEgress?: TaskOfferPayload['messageEgress'];
      sealing?: TaskOfferPayload['sealing'];
    },
    context: AgentMessageServerContext | undefined,
  ): ((stores: TenantStores, taskId: string) => Promise<void>) | undefined {
    if (payload.messageEgress === undefined) {
      if (context !== undefined) throw new ByokCloudError('coordination_input_invalid', 'agentMessageContext requires messageEgress');
      return undefined;
    }
    if (payload.sealing?.categories.includes('agent-message') === true && typeof options.agentMessage?.consumeSealed !== 'function') {
      throw new ByokCloudError(
        'agent_message_sealed_consumer_missing',
        'A task that seals its Agent message requires agentMessage.consumeSealed.',
      );
    }
    const messageContext = AgentMessageServerContextSchema.parse(context);
    const body = JSON.stringify({
      agentRef: payload.agentRef,
      ...(payload.session.mode === 'resume' ? { sessionRef: payload.session.sessionRef } : {}),
      requirement: payload.messageEgress,
      context: messageContext,
    });
    return async (stores, taskId) => {
      const recorded = await stores.receipts.record({ key: `agent-message-offer:${deviceId}:${taskId}`, body });
      if (!recorded.created && !(await sameTaskBody(recorded.receipt.body, body, options.crypto))) {
        throw new ByokCloudError('agent_content_request_mismatch', `Task ${taskId} already has a different Agent message context.`);
      }
    };
  }

  return {
    resolveOfferPayload,
    enqueueTaskEnvelope,
    assertSealedCiphertext,
    retainTaskCiphertext,
    assertAgentCapabilities,
    enqueueAgentControlEnvelope,
    agentControlEnvelopeId,
    enqueueReliableEgressAck,
    enqueueContentReceiptAck,
    enqueueAgentMessageDisposition,
    agentMessageOfferWriter,
  };
}

export type EnqueuePaths = ReturnType<typeof createEnqueuePaths>;
