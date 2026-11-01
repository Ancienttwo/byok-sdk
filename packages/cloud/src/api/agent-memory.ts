import type { ByokCloud, ByokCloudOptions } from '../cloud';
import { type TenantId } from '@byok-sdk/core';
import {
  AgentMemoryProjectionPlainMutationSchema,
  type AgentMemoryProjectionPlainMutation,
  type AgentMemoryProjectionCommitResponse,
  type AgentMemoryProjectionEraseResult,
} from '@byok-sdk/protocol';
import { ByokCloudError } from '../errors';
import type { TenantStores } from '../tenant-stores';
import { sameAgentRef } from './enqueue';

interface Dependencies {
  options: ByokCloudOptions;
}

/** The Host erase, plus the store-bound commit the device projection route calls. */
export function createAgentMemoryApi({ options }: Dependencies): Pick<ByokCloud,
  'eraseAgentMemoryProjection'
> & {
  commitAgentMemoryProjectionFromStores: (stores: TenantStores, deviceId: string, mutationInput: AgentMemoryProjectionPlainMutation, redactedBytes: Uint8Array) => Promise<AgentMemoryProjectionCommitResponse>;
} {
  async function commitAgentMemoryProjectionFromStores(
    stores: TenantStores,
    deviceId: string,
    mutationInput: AgentMemoryProjectionPlainMutation,
    redactedBytes: Uint8Array,
  ): Promise<AgentMemoryProjectionCommitResponse> {
    const mutation = AgentMemoryProjectionPlainMutationSchema.parse(mutationInput);
    const attempt = await stores.tasks.get(mutation.taskId);
    if (
      attempt === undefined ||
      attempt.deviceId !== deviceId ||
      !sameAgentRef(mutation.agentRef, attempt.agentRef)
    ) {
      throw new ByokCloudError(
        'agent_memory_projection_task_mismatch',
        'The Agent-memory projection does not match an exact task/device/AgentRef binding.',
      );
    }
    const authorizer = options.agentMemoryProjectionAuthorizer;
    const store = options.agentMemoryProjectionStore;
    if (authorizer === undefined || store === undefined) {
      throw new ByokCloudError(
        'agent_capability_missing',
        'Hosted Agent-memory projection requires both an authorizer and a projection store.',
      );
    }
    const authorization = await authorizer.authorize({
      tenantId: stores.tenant,
      deviceId,
      taskId: mutation.taskId,
      agentRef: mutation.agentRef,
      sessionRef: mutation.sessionRef,
      runtimeId: mutation.runtimeId,
      grantRef: mutation.grantRef,
      writerEpoch: mutation.writerEpoch,
      policyRevision: mutation.policyRevision,
    });
    if (authorization.outcome !== 'authorized') {
      throw new ByokCloudError(
        'agent_memory_projection_authorization_denied',
        `The Agent-memory projection grant was denied: ${authorization.reasonCode}`,
      );
    }
    return store.commit({ tenantId: stores.tenant, deviceId, mutation, redactedBytes });
  }

  async function eraseAgentMemoryProjection(tenant: TenantId, agentId: string): Promise<AgentMemoryProjectionEraseResult> {
    const authorizer = options.agentMemoryProjectionAuthorizer;
    const store = options.agentMemoryProjectionStore;
    if (authorizer === undefined || store === undefined) {
      throw new ByokCloudError(
        'agent_capability_missing',
        'Hosted Agent-memory projection is not configured for this deployment.',
      );
    }
    // Consent revocation first ensures every later device replay is denied,
    // even when a subsequent external erase has to be retried by the caller.
    await authorizer.revoke({ tenantId: tenant, agentId });
    return store.erase({ tenantId: tenant, agentId });
  }

  return { eraseAgentMemoryProjection, commitAgentMemoryProjectionFromStores };
}
