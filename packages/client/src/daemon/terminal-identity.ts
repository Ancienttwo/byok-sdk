import { HarnessIdSchema, RuntimeIdSchema, type AgentRef, type ClaimedExecutor } from '@byok-sdk/protocol';

/** What `task.claim.executor` names for the adapter this device picked: a wire runtime id, else a custom harness. */
export function claimedExecutorFor(descriptorId: string): ClaimedExecutor {
  const runtime = RuntimeIdSchema.safeParse(descriptorId);
  return runtime.success ? { kind: 'runtime', runtimeId: runtime.data } : { kind: 'harness', harnessId: HarnessIdSchema.parse(descriptorId) };
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
