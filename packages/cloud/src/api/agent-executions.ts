import type { ByokCloud, ByokCloudOptions, EnqueuedOffer } from '../cloud';
import { type TenantId } from '@byok-sdk/core';
import { createEnvelope, requiredReceiverCapabilities } from '@byok-sdk/protocol';
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
  assertAgentCapabilities: EnqueuePaths['assertAgentCapabilities'];
  enqueueTaskEnvelope: EnqueuePaths['enqueueTaskEnvelope'];
  agentMessageOfferWriter: EnqueuePaths['agentMessageOfferWriter'];
}

export function createAgentExecutionsApi({
  options,
  assertAgentCapabilities,
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
    const { deviceId, payload } = validated;
    // A task that seals its message needs `consumeSealed` instead; agentMessageOfferWriter checks it.
    const sealsMessage = payload.sealing?.categories.includes('agent-message') === true;
    if (payload.messageEgress !== undefined && !sealsMessage && typeof options.agentMessage?.consume !== 'function') {
      throw new Error('Agent execution with messageEgress requires a registered Agent message consumer.');
    }
    const beforeMailbox = agentMessageOfferWriter(deviceId, payload, validated.agentMessageContext);
    // Selection admission comes from WIRE_ADDITIONS via requiredReceiverCapabilities
    // (dispatch-selection / toolset-selection). Refuse a mismatched runtime before
    // any attempt, receipt or mailbox write.
    if (payload.dispatchSelection !== undefined && payload.runtime !== payload.dispatchSelection.runtimeId) {
      throw new ByokCloudError(
        'coordination_input_invalid',
        `Agent execution runtime ${payload.runtime} does not match dispatchSelection.runtimeId ${payload.dispatchSelection.runtimeId}.`,
      );
    }
    await assertAgentCapabilities(tenant, deviceId, requiredReceiverCapabilities('task.offer', payload));
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
