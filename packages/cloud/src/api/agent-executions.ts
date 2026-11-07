import type { ByokCloud, ByokCloudOptions, EnqueuedOffer } from '../cloud';
import { type TenantId } from '@byok-sdk/core';
import { createEnvelope } from '@byok-sdk/protocol';
import {
  AgentExecutionInputSchema,
  SealedAgentExecutionInputSchema,
  type AgentExecutionInput,
  type SealedAgentExecutionInput,
} from '../agent-execution';
import { ByokCloudError } from '../errors';
import { refuseSealedFields, type EnqueuePaths } from './enqueue';

interface Dependencies {
  options: ByokCloudOptions;
  resolveOfferPayload: EnqueuePaths['resolveOfferPayload'];
  enqueueTaskEnvelope: EnqueuePaths['enqueueTaskEnvelope'];
  agentMessageOfferWriter: EnqueuePaths['agentMessageOfferWriter'];
}

export function createAgentExecutionsApi({
  options,
  resolveOfferPayload,
  enqueueTaskEnvelope,
  agentMessageOfferWriter,
}: Dependencies): Pick<ByokCloud,
  | 'submitAgentExecution'
  | 'submitSealedAgentExecution'
> {
  async function submitAgentExecution(
    tenant: TenantId, input: AgentExecutionInput,
  ): Promise<EnqueuedOffer> {
    refuseSealedFields((input as { payload?: unknown } | undefined)?.payload, ['sealing', 'sealed'], 'submitSealedAgentExecution');
    return submitExecution(tenant, AgentExecutionInputSchema.parse(input));
  }

  async function submitSealedAgentExecution(
    tenant: TenantId, input: SealedAgentExecutionInput,
  ): Promise<EnqueuedOffer> {
    return submitExecution(tenant, SealedAgentExecutionInputSchema.parse(input));
  }

  /** One fresh Agent execution on the plaintext or the sealed lane; `validated` is the lane's parsed input. */
  async function submitExecution(
    tenant: TenantId,
    validated: AgentExecutionInput | SealedAgentExecutionInput,
  ): Promise<EnqueuedOffer> {
    const { deviceId, payload: requested } = validated;
    // A task that seals its message needs `consumeSealed` instead; agentMessageOfferWriter checks it.
    const sealsMessage = requested.sealing?.categories.includes('agent-message') === true;
    if (requested.messageEgress !== undefined && !sealsMessage && typeof options.agentMessage?.consume !== 'function') {
      throw new Error('Agent execution with messageEgress requires a registered Agent message consumer.');
    }
    const beforeMailbox = agentMessageOfferWriter(deviceId, requested, validated.agentMessageContext);
    // Refuse a mismatched runtime before any attempt, receipt or mailbox write.
    if (requested.dispatchSelection !== undefined && requested.runtime !== requested.dispatchSelection.runtimeId) {
      throw new ByokCloudError(
        'coordination_input_invalid',
        `Agent execution runtime ${requested.runtime} does not match dispatchSelection.runtimeId ${requested.dispatchSelection.runtimeId}.`,
      );
    }
    const payload = await resolveOfferPayload(tenant, deviceId, requested, validated.taskId);
    const enqueued = await enqueueTaskEnvelope(
      tenant,
      deviceId,
      validated.taskId,
      payload.agentRef,
      (taskId, seq, messageId) => createEnvelope('task.offer', payload, { id: messageId, taskId, seq }),
      beforeMailbox,
    );
    return enqueued;
  }

  return { submitAgentExecution, submitSealedAgentExecution };
}
