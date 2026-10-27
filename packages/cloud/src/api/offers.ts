import type {
  ByokCloud,
  AgentDispatchInput,
  PreparedDispatchInput,
  AgentEgressDispatchInput,
  EnqueuedOffer,
} from '../cloud';
import { requiredReceiverCapabilities } from '@byok-sdk/protocol';
import { type TenantId } from '@byok-sdk/core';
import {
  createEnvelope,
  type Envelope,
  type SessionSelection,
  type TaskOfferPayload,
  type AgentRef,
  type AgentMessageServerContext,
} from '@byok-sdk/protocol';
import { type TenantStores } from '../tenant-stores';

interface Dependencies {
  assertAgentCapabilities: (tenant: TenantId, deviceId: string, required: readonly string[]) => Promise<void>;
  refuseSealedFields: (payload: unknown, fields: readonly string[], sealedMethod: string) => void;
  assertResumeSession: (payload: { readonly session?: unknown }) => void;
  AgentOfferLaneSchema: { parse(input: unknown): AgentDispatchInput['payload'] };
  PreparedOfferLaneSchema: { parse(input: unknown): PreparedDispatchInput['payload'] };
  AgentEgressOfferLaneSchema: { parse(input: unknown): AgentEgressDispatchInput['payload'] };
  enqueueTaskEnvelope: (
    tenant: TenantId, deviceId: string, requestedTaskId: string | undefined, agentRef: AgentRef,
    buildEnvelope: (taskId: string, seq: number, messageId: string) => Envelope,
    beforeMailbox?: (stores: TenantStores, taskId: string) => Promise<void>,
  ) => Promise<EnqueuedOffer>;
  agentMessageOfferWriter: (
    deviceId: string,
    payload: { agentRef: AgentRef; session: SessionSelection; messageEgress?: TaskOfferPayload['messageEgress'] },
    context: AgentMessageServerContext | undefined,
  ) => ((stores: TenantStores, taskId: string) => Promise<void>) | undefined;
}

export function createOffersApi({
  assertAgentCapabilities,
  refuseSealedFields,
  assertResumeSession,
  AgentOfferLaneSchema,
  PreparedOfferLaneSchema,
  AgentEgressOfferLaneSchema,
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
  };
}
