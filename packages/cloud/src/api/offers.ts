import type { ByokCloud, EnqueuedOffer } from '../cloud';
import { z } from 'zod';
import { type TenantId } from '@byok-sdk/core';
import {
  AgentEgressPolicySchema,
  InputPreparationOfferBindingSchema,
  SessionSelectionSchema,
  TaskOfferPlainPayloadSchema,
  TaskOfferSealedPayloadSchema,
  createEnvelope,
  requiredReceiverCapabilities,
  type AgentMessageServerContext,
  type TaskOfferSealedPayload,
} from '@byok-sdk/protocol';
import { ByokCloudError } from '../errors';
import { refuseSealedFields, type EnqueuePaths } from './enqueue';

const RESUME_SESSION = SessionSelectionSchema.options[0];
const NO_EGRESS = { egressPolicy: z.never().optional(), messageEgress: z.never().optional() };

/** The `task.offer` payload each enqueue lane admits; every lane sends `task.offer`. */
const AgentOfferLaneSchema = TaskOfferPlainPayloadSchema.safeExtend({ session: RESUME_SESSION, ...NO_EGRESS, preparation: z.never().optional() });
const AgentEgressOfferLaneSchema = TaskOfferPlainPayloadSchema.safeExtend({
  session: RESUME_SESSION, egressPolicy: AgentEgressPolicySchema, preparation: z.never().optional(),
});
const PreparedOfferLaneSchema = TaskOfferPlainPayloadSchema.safeExtend({ preparation: InputPreparationOfferBindingSchema });
const SealedAgentOfferLaneSchema = TaskOfferSealedPayloadSchema.safeExtend({ session: RESUME_SESSION, ...NO_EGRESS });
const SealedAgentEgressOfferLaneSchema = TaskOfferSealedPayloadSchema.safeExtend({ session: RESUME_SESSION, egressPolicy: AgentEgressPolicySchema });

/** Resume-only Agent lanes refuse a payload that does not resume an exact session. */
function assertResumeSession(payload: { readonly session?: unknown }): void {
  const session = payload.session as { readonly mode?: unknown; readonly sessionRef?: unknown } | undefined;
  if (session?.mode !== 'resume' || typeof session.sessionRef !== 'string' || session.sessionRef.length === 0) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      'Agent resume offer requires session.mode resume with an exact sessionRef; use submitAgentExecution for fresh execution',
    );
  }
}

interface Dependencies {
  assertAgentCapabilities: EnqueuePaths['assertAgentCapabilities'];
  enqueueTaskEnvelope: EnqueuePaths['enqueueTaskEnvelope'];
  agentMessageOfferWriter: EnqueuePaths['agentMessageOfferWriter'];
}

export function createOffersApi({
  assertAgentCapabilities,
  enqueueTaskEnvelope,
  agentMessageOfferWriter,
}: Dependencies): Pick<ByokCloud,
  | 'enqueueAgentOffer'
  | 'enqueuePreparedOffer'
  | 'enqueueAgentEgressOffer'
  | 'enqueueSealedAgentOffer'
  | 'enqueueSealedAgentEgressOffer'
> {
  /**
   * The two sealed enqueue lanes (#654). Each follows its plaintext sibling:
   * the resume check, the gates of the sealed `task.offer` and the same task
   * envelope path. The strict parse comes first, and every later step reads
   * that copy, so a caller that changes its object during an await cannot make
   * the checks and the enqueue see different payloads.
   */
  async function enqueueSealedTaskOffer(
    tenant: TenantId,
    deviceId: string,
    lane: typeof SealedAgentOfferLaneSchema | typeof SealedAgentEgressOfferLaneSchema,
    input: { readonly taskId?: string; readonly payload: object; readonly agentMessageContext?: AgentMessageServerContext },
  ): Promise<EnqueuedOffer> {
    const { taskId } = input;
    assertResumeSession(input.payload);
    const payload: TaskOfferSealedPayload = lane.parse(input.payload);
    // A sealed instruction binds the task id, so cloud cannot mint one for it.
    if (payload.sealed !== undefined && (typeof taskId !== 'string' || taskId === '')) {
      throw new ByokCloudError('coordination_input_invalid', 'a sealed instruction needs its taskId');
    }
    await assertAgentCapabilities(tenant, deviceId, requiredReceiverCapabilities('task.offer', payload));
    return enqueueTaskEnvelope(
      tenant,
      deviceId,
      taskId,
      payload.agentRef,
      (id, seq, messageId) => createEnvelope('task.offer', payload, { id: messageId, taskId: id, seq }),
      payload.egressPolicy === undefined ? undefined : agentMessageOfferWriter(deviceId, payload, input.agentMessageContext),
    );
  }

  return {
    async enqueueAgentOffer(tenant, deviceId, input) {
      // Resume-only: this lane never starts a fresh Agent execution; that has
      // exactly one authority, `submitAgentExecution`. Checked first, before
      // capability admission and any attempt, receipt or mailbox write, so a JS
      // caller always gets the same code whatever the target device's state.
      refuseSealedFields(input.payload, ['sealing', 'sealed'], 'enqueueSealedAgentOffer');
      assertResumeSession(input.payload);
      await assertAgentCapabilities(tenant, deviceId, requiredReceiverCapabilities('task.offer', input.payload));
      // Parse the strict control payload before reserving a mailbox sequence.
      // A malformed/oversized AgentRef therefore cannot leave a durable
      // delivery row behind.
      const payload = AgentOfferLaneSchema.parse(input.payload);
      return enqueueTaskEnvelope(tenant, deviceId, input.taskId, payload.agentRef, (taskId, seq, messageId) =>
        createEnvelope('task.offer', payload, { id: messageId, taskId, seq }),
      );
    },

    async enqueuePreparedOffer(tenant, deviceId, input) {
      await assertAgentCapabilities(tenant, deviceId, requiredReceiverCapabilities('task.offer', input.payload));
      // Parsed before a mailbox sequence is reserved, exactly as the strict
      // Agent offer above is: a malformed preparation reference must not leave
      // a durable delivery row behind. A caller that tried to smuggle an
      // `instruction` or a resume session onto this lane is rejected here.
      const payload = PreparedOfferLaneSchema.parse(input.payload);
      return enqueueTaskEnvelope(tenant, deviceId, input.taskId, payload.agentRef, (taskId, seq, messageId) =>
        createEnvelope('task.offer', payload, { id: messageId, taskId, seq }),
        agentMessageOfferWriter(deviceId, payload, input.agentMessageContext),
      );
    },

    async enqueueAgentEgressOffer(tenant, deviceId, input) {
      refuseSealedFields(input.payload, ['sealing', 'sealed'], 'enqueueSealedAgentEgressOffer');
      assertResumeSession(input.payload);
      await assertAgentCapabilities(tenant, deviceId, requiredReceiverCapabilities('task.offer', input.payload));
      const payload = AgentEgressOfferLaneSchema.parse(input.payload);
      const enqueued = await enqueueTaskEnvelope(
        tenant,
        deviceId,
        input.taskId,
        payload.agentRef,
        (taskId, seq, messageId) => createEnvelope('task.offer', payload, { id: messageId, taskId, seq }),
        agentMessageOfferWriter(deviceId, payload, input.agentMessageContext),
      );
      return enqueued;
    },

    enqueueSealedAgentOffer: (tenant, deviceId, input) => enqueueSealedTaskOffer(tenant, deviceId, SealedAgentOfferLaneSchema, input),
    enqueueSealedAgentEgressOffer: (tenant, deviceId, input) => enqueueSealedTaskOffer(tenant, deviceId, SealedAgentEgressOfferLaneSchema, input),
  };
}
