import { ClaimedExecutorSchema, type AgentRef, type ClaimedExecutor } from '@byok-sdk/protocol';

/** The executor named by the adapter this device picked. */
export function claimedExecutorFor(descriptorId: string): ClaimedExecutor {
  return ClaimedExecutorSchema.parse({ id: descriptorId });
}

/**
 * Project sealed execution facts, never the offer's requested target. A
 * terminal carries `executor` exactly when the task was claimed: pass the
 * claimed adapter id, or `undefined` for a task this device never claimed.
 */
export function terminalIdentity(claimedId: string | undefined, agentRef?: AgentRef): { executor?: ClaimedExecutor; agentRef?: AgentRef } {
  return {
    ...(claimedId === undefined ? {} : { executor: claimedExecutorFor(claimedId) }),
    ...(agentRef === undefined ? {} : { agentRef }),
  };
}
