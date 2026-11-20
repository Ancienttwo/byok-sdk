import { HostOfferPlainPayloadSchema } from '@byok-sdk/protocol';
import type { ByokCloud } from '../cloud.js';
import { z } from 'zod';
import {
  AgentEgressPolicySchema,
  InputPreparationOfferBindingSchema,
  SessionSelectionSchema,
  createEnvelope,
} from '@byok-sdk/protocol';
import { ByokCloudError } from '../errors.js';
import { assertProviderProfileModelOverride, refuseSealedFields, type EnqueuePaths } from './enqueue.js';

const RESUME_SESSION = SessionSelectionSchema.options[0];
const NO_EGRESS = { egressPolicy: z.never().optional(), messageEgress: z.never().optional() };

/** The `task.offer` payload each enqueue lane admits; every lane sends `task.offer`. */
const AgentOfferLaneSchema = HostOfferPlainPayloadSchema.safeExtend({ session: RESUME_SESSION, ...NO_EGRESS, preparation: z.never().optional() });
const AgentEgressOfferLaneSchema = HostOfferPlainPayloadSchema.safeExtend({
  session: RESUME_SESSION, egressPolicy: AgentEgressPolicySchema, preparation: z.never().optional(),
});
const PreparedOfferLaneSchema = HostOfferPlainPayloadSchema.safeExtend({ preparation: InputPreparationOfferBindingSchema });

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
  resolveOfferPayload: EnqueuePaths['resolveOfferPayload'];
  enqueueTaskEnvelope: EnqueuePaths['enqueueTaskEnvelope'];
  agentMessageOfferWriter: EnqueuePaths['agentMessageOfferWriter'];
}

export function createOffersApi({
  resolveOfferPayload,
  enqueueTaskEnvelope,
  agentMessageOfferWriter,
}: Dependencies): Pick<ByokCloud,
  | 'enqueueAgentOffer'
  | 'enqueuePreparedOffer'
  | 'enqueueAgentEgressOffer'
> {
  return {
    async enqueueAgentOffer(tenant, deviceId, input) {
      // Resume-only: this lane never starts a fresh Agent execution; that has
      // exactly one authority, `submitAgentExecution`. Checked first, before
      // capability admission and any attempt, receipt or mailbox write, so a JS
      // caller always gets the same code whatever the target device's state.
      refuseSealedFields(input.payload, ['sealing', 'sealed']);
      assertResumeSession(input.payload);
      // Parse the strict control payload before reserving a mailbox sequence.
      // A malformed/oversized AgentRef therefore cannot leave a durable
      // delivery row behind.
      assertProviderProfileModelOverride(input.payload);
      const payload = await resolveOfferPayload(tenant, deviceId, AgentOfferLaneSchema.parse(input.payload), input.taskId);
      return enqueueTaskEnvelope(tenant, deviceId, input.taskId, payload.agentRef, (taskId, seq, messageId) =>
        createEnvelope('task.offer', payload, { id: messageId, taskId, seq }),
      );
    },

    async enqueuePreparedOffer(tenant, deviceId, input) {
      // Parsed before a mailbox sequence is reserved, exactly as the strict
      // Agent offer above is: a malformed preparation reference must not leave
      // a durable delivery row behind. A caller that tried to smuggle an
      // `instruction` or a resume session onto this lane is rejected here.
      assertProviderProfileModelOverride(input.payload);
      const payload = await resolveOfferPayload(tenant, deviceId, PreparedOfferLaneSchema.parse(input.payload), input.taskId);
      return enqueueTaskEnvelope(tenant, deviceId, input.taskId, payload.agentRef, (taskId, seq, messageId) =>
        createEnvelope('task.offer', payload, { id: messageId, taskId, seq }),
        agentMessageOfferWriter(deviceId, payload, input.agentMessageContext),
      );
    },

    async enqueueAgentEgressOffer(tenant, deviceId, input) {
      refuseSealedFields(input.payload, ['sealing', 'sealed']);
      assertResumeSession(input.payload);
      assertProviderProfileModelOverride(input.payload);
      const payload = await resolveOfferPayload(tenant, deviceId, AgentEgressOfferLaneSchema.parse(input.payload), input.taskId);
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
  };
}
