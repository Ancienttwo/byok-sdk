import { AgentRefSchema, type AgentRef } from '@byok-sdk/protocol';

/**
 * Exact, unambiguous storage identity for one Agent-scoped reliability fact.
 *
 * The device remains explicit because one Agent is placed on at most one
 * device today, while one device may run many Agents. JSON supplies a stable
 * length-delimited encoding without inventing a Placement authority.
 */
export function agentReliabilityKey(
  domain: string,
  deviceId: string,
  agentRef: AgentRef,
  id: string,
): string {
  const exact = AgentRefSchema.parse(agentRef);
  return `${domain}:${JSON.stringify([deviceId, exact.agentId, exact.profileRevision, id])}`;
}
