import { HarnessIdSchema, RuntimeIdSchema, type AgentRef } from '@byok-sdk/protocol';

/** Project sealed execution facts, never the offer's requested harness. */
export function terminalIdentity(runtimeId: string | undefined, agentRef?: AgentRef): { harnessId?: string; agentRef?: AgentRef } {
  return {
    ...(runtimeId === undefined || RuntimeIdSchema.safeParse(runtimeId).success
      ? {} : { harnessId: HarnessIdSchema.parse(runtimeId) }),
    ...(agentRef === undefined ? {} : { agentRef }),
  };
}
