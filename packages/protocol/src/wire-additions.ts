/**
 * The one table of receiver-capability gates and wire additions
 * (docs/protocol.md "Freeze rule").
 *
 * A change takes exactly one of three paths: a version bump, a gated
 * addition, or a strip-safe addition. Gated additions are declared here.
 *
 * - `gated`: the sender must not emit the surface unless the receiver
 *   durably advertised `capability`. A field entry applies when the payload
 *   carries the field (and, with `value`, when the field equals it, or when
 *   the field is an array that includes it); a dotted field names a nested
 *   field, for example `sealed.ciphertextRef`. `when` limits a field gate to
 *   a matching payload discriminator. A type entry applies to every
 *   message of that type. Only server-to-daemon surfaces are gated, each by a
 *   device flag: the server advertises nothing (wire v7).
 *
 * Every row gates a server-to-daemon surface on a configured device facility.
 * The server advertises no capability flags. Offers are strict: unknown fields
 * are refused, and a sender must check every applicable row before enqueue.
 *
 * Senders derive their admission flags from {@link requiredReceiverCapabilities}
 * and nowhere else, so a gate cannot exist in one place and be missing in
 * another. This module imports no runtime code except the plain-data split
 * table, so it stays free of zod.
 */
import {
  AGENT_INPUT_PREPARATION_CAPABILITY,
  HARNESS_SERVICE_TIER_CAPABILITY,
  INPUT_IMAGES_CAPABILITY,
  SEALED_PAYLOAD_CAPABILITY,
  SEALED_PAYLOAD_V2_CAPABILITY,
} from './capability-constants.js';
import type { MessageType } from './messages.js';
import { SEALED_CATEGORY_CAPABILITY, SEALED_SPLIT_TABLE, type SealableMessageType, type SealedSplitEntry } from './sealed-split-table.js';
import type { CapabilityFlag } from './version.js';

/** One gated server-to-daemon surface and the device flag it needs. */
export interface WireAddition {
  readonly surface: MessageType;
  readonly field?: string;
  readonly value?: string;
  readonly when?: { readonly field: string; readonly value: string };
  readonly capability: CapabilityFlag;
}

const offerRow = (field: string | undefined, capability: CapabilityFlag, value?: string): WireAddition => ({
  surface: 'task.offer',
  ...(field === undefined ? {} : { field }), ...(value === undefined ? {} : { value }),
  capability,
});

/**
 * Sealed payload (#654, #1045): the marker of each server-to-daemon sealed
 * branch is gated on its category's device flag. The sealed branch shares
 * every other row of its type that applies to its visible fields. Moved input
 * fields (e.g. `images`) are checked before sealing and after opening, via
 * the same rows. Dropped fields are absent from the sealed branch.
 * A daemon-to-server sealed branch needs no flag: the server accepts it by the
 * task's frozen `sealing`.
 */
function sealedRows(): WireAddition[] {
  return (Object.keys(SEALED_SPLIT_TABLE) as SealableMessageType[]).flatMap((surface): WireAddition[] => {
    const entry: SealedSplitEntry = SEALED_SPLIT_TABLE[surface];
    if (entry.category !== 'task-input') return [];
    return [{ surface, field: entry.marker, capability: SEALED_CATEGORY_CAPABILITY[entry.category] }];
  });
}

/**
 * Sealed payload v2 (#1045) outside the split table: an offer whose frozen
 * `sealing` lists a v2 category, and the disposition of a sealed message,
 * which names it by `contentMac`. Both go to a device.
 */
const SEALED_V2_ROWS: readonly WireAddition[] = [
  offerRow('sealing.categories', SEALED_PAYLOAD_V2_CAPABILITY, 'agent-message'),
  offerRow('sealing.categories', SEALED_PAYLOAD_V2_CAPABILITY, 'memory-projection'),
  { surface: 'agent.message.disposition', field: 'contentMac', capability: SEALED_PAYLOAD_V2_CAPABILITY },
];

const PLAIN_ROWS: readonly WireAddition[] = [
  // Server to daemon: the offer. Every offer binds an Agent; each optional
  // field and value names the device flag a daemon advertises when it is
  // configured for it.
  offerRow(undefined, 'agent-home-contract'),
  offerRow('images', INPUT_IMAGES_CAPABILITY),
  { surface: 'task.steer', field: 'images', capability: INPUT_IMAGES_CAPABILITY },
  offerRow('requiredToolsets', 'toolset-selection'),
  offerRow('homeAccess', 'agent-home-readers'),
  offerRow('agentMemory', 'agent-memory-selection'),
  offerRow('agentMemory', 'agent-memory-read-if-admitted', 'read-if-admitted'),
  offerRow('agentMemory', 'agent-memory-read-write-if-admitted', 'read-write-if-admitted'),
  offerRow('agentMemoryCommit', 'agent-memory-commit-on-success'),
  offerRow('nativeSessions', 'native-sessions'),
  offerRow('egressPolicy', 'agent-egress-policy'),
  offerRow('egressPolicy', 'agent-egress-reliable-ack'),
  offerRow('messageEgress', 'agent-message-egress'),
  offerRow('session.mode', 'agent-egress-fresh-session', 'fresh'),
  offerRow('preparation', AGENT_INPUT_PREPARATION_CAPABILITY),
  offerRow('target.serviceTier', HARNESS_SERVICE_TIER_CAPABILITY),
  offerRow('target.serviceTierFallback', HARNESS_SERVICE_TIER_CAPABILITY),
  // Server to daemon: Agent control messages.
  { surface: 'agent.content.read', capability: 'agent-home-contract' },
  { surface: 'agent.content.read', capability: 'agent-egress-policy' },
  { surface: 'agent.content.read', capability: 'agent-egress-reliable-ack' },
  { surface: 'agent.content.read', field: 'surface', value: 'workspace', capability: 'agent-content-workspace-read' },
  { surface: 'agent.content.read', field: 'surface', value: 'transcript', capability: 'agent-content-transcript-read' },
  { surface: 'agent.content.read', field: 'surface', value: 'artifact', capability: 'agent-content-artifact-read' },
  { surface: 'agent.home.projection', capability: 'agent-home-contract' },
  { surface: 'agent.home.projection', capability: 'agent-home-projection' },
  { surface: 'agent.home.projection', field: 'hostRevision', capability: 'agent-home-projection-host-revision' },
  { surface: 'agent.input.preparation', capability: 'agent-home-contract' },
  { surface: 'agent.input.preparation', capability: AGENT_INPUT_PREPARATION_CAPABILITY },
  { surface: 'provider.provisioning.available', capability: 'provider-provisioning.v1' },
  { surface: 'agent.memory.intent.available', capability: 'agent-memory-intent.v1' },
  { surface: 'e2ee.key_package.available', capability: SEALED_PAYLOAD_CAPABILITY },
];

export const WIRE_ADDITIONS: readonly WireAddition[] = Object.freeze([
  ...PLAIN_ROWS,
  ...sealedRows(),
  ...SEALED_V2_ROWS,
] satisfies readonly WireAddition[]);

interface FieldMatch {
  readonly field: string;
  readonly value?: string;
}

function matchesField(payload: unknown, { field, value }: FieldMatch): boolean {
  const actual = field.split('.').reduce<unknown>(
    (parent, segment) => (parent !== null && typeof parent === 'object' ? (parent as Record<string, unknown>)[segment] : undefined),
    payload,
  );
  return actual !== undefined && (value === undefined || (Array.isArray(actual) ? actual.includes(value) : actual === value));
}

/**
 * Every capability the receiver must have durably advertised before a sender
 * may emit this message. Deduplicated, in table order. A sender refuses (before
 * creating the task or appending to the mailbox) when any is missing.
 * For fields moved into ciphertext, pass the logical payload before sealing
 * or after opening to derive their gates as well.
 */
export function requiredReceiverCapabilities(type: MessageType, payload: unknown): CapabilityFlag[] {
  const required: CapabilityFlag[] = [];
  for (const entry of WIRE_ADDITIONS) {
    if (entry.surface !== type) continue;
    if (entry.when !== undefined && !matchesField(payload, entry.when)) continue;
    if (entry.field !== undefined && !matchesField(payload, { field: entry.field, value: entry.value })) continue;
    if (!required.includes(entry.capability)) required.push(entry.capability);
  }
  return required;
}
