import {
  AgentEgressPolicySchema,
  type AgentEgressDropReason,
  type AgentEgressPolicy,
  type AgentEvent,
} from '@byok-sdk/protocol';

export type { AgentEgressDropReason, AgentEgressPolicy } from '@byok-sdk/protocol';

export interface AgentEgressDropReceipt {
  lane: 'latest-value' | 'reliable';
  reason: AgentEgressDropReason;
  agentId?: string;
  tenantId?: string;
  eventId?: string;
  occurredAt: string;
}

export interface AgentEgressLaneStatus {
  pendingEvents: number;
  pendingBytes: number;
  replaced: number;
  dropped: number;
  lastDropReason?: AgentEgressDropReason;
}

export interface AgentEgressStatus {
  policyRevision: string;
  latestValue: AgentEgressLaneStatus;
  reliable: AgentEgressLaneStatus;
}

/**
 * Policy used when the host configures no Agent egress. Activity goes to the
 * Host as the runtime produced it; the limits only bound transport.
 */
export const DEFAULT_AGENT_EGRESS_POLICY: Readonly<AgentEgressPolicy> = Object.freeze({
  policyRevision: 'default-v1',
  activity: Object.freeze({ delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 256 * 1024 }),
  reliable: Object.freeze({
    maxPendingEventsPerAgent: 256,
    maxPendingBytesPerAgent: 4 * 1024 * 1024,
    maxPendingBytesPerTenant: 16 * 1024 * 1024,
  }),
  transfers: Object.freeze({ workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' }),
});

export class AgentEgressPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentEgressPolicyError';
  }
}

/** Resolve/validate once at construction; unknown policy shapes never become an implicit default. */
export function resolveAgentEgressPolicy(policy: AgentEgressPolicy | undefined): Readonly<AgentEgressPolicy> {
  if (policy === undefined) return DEFAULT_AGENT_EGRESS_POLICY;
  const parsed = AgentEgressPolicySchema.safeParse(policy);
  if (!parsed.success) {
    throw new AgentEgressPolicyError(`Agent egress policy is invalid: ${parsed.error.message}`);
  }
  return Object.freeze({
    ...parsed.data,
    activity: Object.freeze({ ...parsed.data.activity }),
    reliable: Object.freeze({ ...parsed.data.reliable }),
    transfers: Object.freeze({ ...parsed.data.transfers }),
  });
}

const encoder = new TextEncoder();
export function eventBytes(event: AgentEvent): number {
  return encoder.encode(JSON.stringify(event)).length;
}
