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

/** Safe policy selected only when the host has not opted into content. */
export const DEFAULT_AGENT_EGRESS_POLICY: Readonly<AgentEgressPolicy> = Object.freeze({
  policyRevision: 'metadata-status-v1',
  activity: Object.freeze({ mode: 'metadata-status', delivery: 'latest-value' }),
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

/**
 * Default activity projection. Every retained string is SDK-authored; no
 * runtime trajectory, tool, prompt, environment, argv, path, or credential
 * value survives this transformation.
 *
 * Each case CONSTRUCTS a fresh event from SDK-authored literals rather than
 * editing the incoming one, which is what makes the guarantee total rather
 * than a list of fields someone remembered to strip. `spill` on
 * `tool_use`/`tool_result` is covered by exactly that: a `BlobRef` is a
 * readable locator for the omitted tool payload — content, not metadata — so
 * it never survives a metadata-status projection, and neither do the byte
 * counts that would leak the payload's size.
 */
export function metadataStatusEvent(event: AgentEvent): AgentEvent {
  switch (event.type) {
    case 'progress': return { type: 'progress', text: '[content omitted]' };
    case 'tool_use': return { type: 'tool_use', tool: '[tool omitted]' };
    case 'tool_result': return event.isError === undefined
      ? { type: 'tool_result', tool: '[tool omitted]' }
      : { type: 'tool_result', tool: '[tool omitted]', isError: event.isError };
    case 'artifact': return { type: 'artifact', name: '[artifact omitted]', contentType: 'application/octet-stream' };
    case 'needs_approval': return { type: 'needs_approval', summary: '[approval pending]' };
    case 'error': return { type: 'error', message: '[runtime error]' };
    case 'usage':
    case 'turn_end': return { ...event };
  }
}

const encoder = new TextEncoder();
export function eventBytes(event: AgentEvent): number {
  return encoder.encode(JSON.stringify(event)).length;
}
