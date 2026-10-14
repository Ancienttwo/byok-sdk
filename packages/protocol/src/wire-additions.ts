/**
 * The one table of v2 wire additions that an older receiver may not decode
 * (docs/protocol.md "Freeze rule").
 *
 * A v2 change takes exactly one of three paths: a version bump, a gated
 * addition, or a strip-safe addition. The last two are declared here, and
 * `src/__tests__/compat.test.ts` proves every declaration against the
 * published decoders pinned in package.json.
 *
 * - `gated`: the sender must not emit the surface unless the receiver
 *   durably advertised `capability`. A field entry applies when the payload
 *   carries the field (and, with `value`, when the field equals it); a type
 *   entry applies to every message of that type. Server-to-daemon surfaces
 *   are gated by a device flag, daemon-to-server surfaces by a server flag.
 * - `strip-safe`: an optional field an older receiver drops without changing
 *   what it executes or acknowledges.
 *
 * Senders derive their admission flags from {@link requiredReceiverCapabilities}
 * and nowhere else, so a gate cannot exist in one place and be missing in
 * another. This module imports no runtime code (types only) so it stays free
 * of zod.
 */
import type { MessageType } from './messages';
import type { CapabilityFlag } from './version';

export type WireAddition =
  | {
      readonly rule: 'gated';
      readonly surface: MessageType;
      readonly field?: string;
      readonly value?: string;
      readonly capability: CapabilityFlag;
      readonly advertisedBy: 'device' | 'server';
    }
  | { readonly rule: 'strip-safe'; readonly surface: MessageType; readonly field: string };

const AGENT_OFFER_FIELDS = (surface: MessageType): readonly WireAddition[] => [
  { rule: 'gated', surface, field: 'terminalProjection', capability: 'terminal-projection-selection', advertisedBy: 'device' },
  { rule: 'gated', surface, field: 'homeAccess', capability: 'agent-home-readers', advertisedBy: 'device' },
];

const EGRESS_OFFER_FIELDS = (surface: MessageType): readonly WireAddition[] => [
  { rule: 'gated', surface, field: 'messageEgress', capability: 'agent-message-egress', advertisedBy: 'device' },
  ...AGENT_OFFER_FIELDS(surface),
];

const TERMINAL_STRIP_SAFE = (surface: MessageType): readonly WireAddition[] => [
  { rule: 'strip-safe', surface, field: 'agentHomeProjection' },
  { rule: 'strip-safe', surface, field: 'agentHomeMemoryChange' },
];

export const WIRE_ADDITIONS: readonly WireAddition[] = Object.freeze([
  // Server to daemon: offers.
  { rule: 'gated', surface: 'task.offer', field: 'harnessId', capability: 'custom-harness', advertisedBy: 'device' },
  { rule: 'gated', surface: 'task.offer_with_toolsets', field: 'harnessId', capability: 'custom-harness', advertisedBy: 'device' },
  { rule: 'gated', surface: 'task.offer_for_agent', capability: 'agent-home-contract', advertisedBy: 'device' },
  ...AGENT_OFFER_FIELDS('task.offer_for_agent'),
  { rule: 'gated', surface: 'task.offer_for_agent_with_egress', capability: 'agent-home-contract', advertisedBy: 'device' },
  { rule: 'gated', surface: 'task.offer_for_agent_with_egress', capability: 'agent-egress-policy', advertisedBy: 'device' },
  { rule: 'gated', surface: 'task.offer_for_agent_with_egress', capability: 'agent-egress-reliable-ack', advertisedBy: 'device' },
  ...EGRESS_OFFER_FIELDS('task.offer_for_agent_with_egress'),
  { rule: 'gated', surface: 'task.offer_for_agent_with_egress_fresh', capability: 'agent-home-contract', advertisedBy: 'device' },
  { rule: 'gated', surface: 'task.offer_for_agent_with_egress_fresh', capability: 'agent-egress-policy', advertisedBy: 'device' },
  { rule: 'gated', surface: 'task.offer_for_agent_with_egress_fresh', capability: 'agent-egress-reliable-ack', advertisedBy: 'device' },
  { rule: 'gated', surface: 'task.offer_for_agent_with_egress_fresh', capability: 'agent-egress-fresh-session', advertisedBy: 'device' },
  ...EGRESS_OFFER_FIELDS('task.offer_for_agent_with_egress_fresh'),
  { rule: 'gated', surface: 'task.offer_prepared', capability: 'agent-home-contract', advertisedBy: 'device' },
  { rule: 'gated', surface: 'task.offer_prepared', capability: 'agent-input-preparation-v9', advertisedBy: 'device' },
  { rule: 'gated', surface: 'task.offer_prepared', capability: 'agent-egress-policy', advertisedBy: 'device' },
  { rule: 'gated', surface: 'task.offer_prepared', capability: 'agent-egress-reliable-ack', advertisedBy: 'device' },
  { rule: 'gated', surface: 'task.offer_prepared', capability: 'agent-egress-fresh-session', advertisedBy: 'device' },
  ...EGRESS_OFFER_FIELDS('task.offer_prepared'),
  // Server to daemon: Agent control messages.
  { rule: 'gated', surface: 'agent.content.read', capability: 'agent-home-contract', advertisedBy: 'device' },
  { rule: 'gated', surface: 'agent.content.read', capability: 'agent-egress-policy', advertisedBy: 'device' },
  { rule: 'gated', surface: 'agent.content.read', capability: 'agent-egress-reliable-ack', advertisedBy: 'device' },
  { rule: 'gated', surface: 'agent.content.read', field: 'surface', value: 'workspace', capability: 'agent-content-workspace-read', advertisedBy: 'device' },
  { rule: 'gated', surface: 'agent.content.read', field: 'surface', value: 'transcript', capability: 'agent-content-transcript-read', advertisedBy: 'device' },
  { rule: 'gated', surface: 'agent.content.read', field: 'surface', value: 'artifact', capability: 'agent-content-artifact-read', advertisedBy: 'device' },
  { rule: 'gated', surface: 'agent.home.projection', capability: 'agent-home-contract', advertisedBy: 'device' },
  { rule: 'gated', surface: 'agent.home.projection', capability: 'agent-home-projection', advertisedBy: 'device' },
  { rule: 'gated', surface: 'agent.input.preparation', capability: 'agent-home-contract', advertisedBy: 'device' },
  { rule: 'gated', surface: 'agent.input.preparation', capability: 'agent-input-preparation-v9', advertisedBy: 'device' },
  { rule: 'gated', surface: 'provider.provisioning.available', capability: 'provider-provisioning.v1', advertisedBy: 'device' },
  { rule: 'gated', surface: 'agent.memory.intent.available', capability: 'agent-memory-intent.v1', advertisedBy: 'device' },
  // Daemon to server.
  { rule: 'gated', surface: 'task.approval_resolved', capability: 'approval_resolved', advertisedBy: 'server' },
  { rule: 'gated', surface: 'task.complete', field: 'document', capability: 'result-document', advertisedBy: 'server' },
  { rule: 'strip-safe', surface: 'task.complete', field: 'finalMessage' },
  ...TERMINAL_STRIP_SAFE('task.complete'),
  ...TERMINAL_STRIP_SAFE('task.fail'),
  ...TERMINAL_STRIP_SAFE('task.cancelled'),
] satisfies readonly WireAddition[]);

/**
 * Every capability the receiver must have durably advertised before a sender
 * may emit this message. Deduplicated, in table order. A sender refuses (before
 * creating the task or appending to the mailbox) when any is missing.
 */
export function requiredReceiverCapabilities(type: MessageType, payload: unknown): CapabilityFlag[] {
  const fields = payload !== null && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const required: CapabilityFlag[] = [];
  for (const entry of WIRE_ADDITIONS) {
    if (entry.rule !== 'gated' || entry.surface !== type) continue;
    if (entry.field !== undefined) {
      const value = fields[entry.field];
      if (value === undefined) continue;
      if (entry.value !== undefined && value !== entry.value) continue;
    }
    if (!required.includes(entry.capability)) required.push(entry.capability);
  }
  return required;
}
