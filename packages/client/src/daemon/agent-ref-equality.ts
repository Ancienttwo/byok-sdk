import type { AgentRef } from '@byok-sdk/protocol';

// AgentRef is a public protocol type; client has no internal AgentRef module, so daemon-only rules live here.
export function sameAgentRef(left: AgentRef, right: AgentRef): boolean {
  return left.agentId === right.agentId && left.profileRevision === right.profileRevision;
}
