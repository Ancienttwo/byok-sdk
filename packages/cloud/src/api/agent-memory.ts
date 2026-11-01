import type { ByokCloud, ByokCloudOptions } from '../cloud';
import { type TenantId } from '@byok-sdk/core';
import {
  type AgentMemoryProjectionPlainMutation,
  type AgentMemoryProjectionCommitResponse,
  type AgentMemoryProjectionEraseResult,
  type AgentMemoryProjectionSealedMutation,
} from '@byok-sdk/protocol';
import type { AgentMemoryProjectionSealing } from '../agent-memory-projection';
import { ByokCloudError } from '../errors';
import type { TenantStores } from '../tenant-stores';
import { sameAgentRef } from './enqueue';

interface Dependencies {
  options: ByokCloudOptions;
}

/** One mutation the device route parsed: a plaintext one with its decoded bytes, or a sealed one. */
export type AgentMemoryProjectionSubmission =
  | { readonly mutation: AgentMemoryProjectionPlainMutation; readonly redactedBytes: Uint8Array }
  | { readonly mutation: AgentMemoryProjectionSealedMutation; readonly redactedBytes?: never };

/** The Host erase, plus the store-bound commit the device projection route calls. */
export function createAgentMemoryApi({ options }: Dependencies): Pick<ByokCloud,
  'eraseAgentMemoryProjection'
> & {
  commitAgentMemoryProjectionFromStores: (stores: TenantStores, deviceId: string, submission: AgentMemoryProjectionSubmission) => Promise<AgentMemoryProjectionCommitResponse>;
} {
  async function commitAgentMemoryProjectionFromStores(
    stores: TenantStores,
    deviceId: string,
    submission: AgentMemoryProjectionSubmission,
  ): Promise<AgentMemoryProjectionCommitResponse> {
    const { mutation } = submission;
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
    if (!sealingMatches(authorization.sealing, submission)) {
      throw new ByokCloudError(
        'agent_memory_projection_sealing_mismatch',
        'The Agent-memory projection form does not match the sealing of its grant.',
      );
    }
    return store.commit({ tenantId: stores.tenant, deviceId, ...submission });
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

/**
 * A grant with `sealing` takes only a snapshot sealed under exactly that scope
 * and epoch; a grant without it takes only a plaintext snapshot (#1045 C4).
 */
function sealingMatches(sealing: AgentMemoryProjectionSealing | undefined, submission: AgentMemoryProjectionSubmission): boolean {
  const sealed = submission.mutation.sealed;
  if (sealing === undefined || sealed === undefined) return sealing === undefined && sealed === undefined;
  return sealed.scope.id === sealing.scopeId && sealed.scope.epoch === sealing.epoch;
}
