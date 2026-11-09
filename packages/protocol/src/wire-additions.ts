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
 *   field, for example `sealed.ciphertextRef`. A type entry applies to every
 *   message of that type. Only server-to-daemon surfaces are gated, each by a
 *   device flag: wire v6 has no server flag.
 *
 * v3 baseline: every v3 decoder reads every surface v2 had, so the v2
 * strip-safe rows and the v2 `result-document` gate are gone. The device
 * gates kept below name capabilities a daemon advertises only when it is
 * configured for them (Agent home, egress, input preparation, provisioning,
 * memory intents and so on): they gate on the receiver's configuration.
 *
 * v4 baseline: every v4 server reads `task.approval_resolved`, so its
 * `approval_resolved` gate is gone. One `task.offer` replaces the Agent offer
 * types and sealed is a payload branch, so a gate that a v3 type carried is a
 * field or value row here. The offer is strict, so a daemon that does not know
 * one of its fields stops instead of stripping it. The daemon also refuses an offer whose rows name a flag it did not advertise. No
 * v4 release has been published yet, so no published decoder proves these rows
 * across releases.
 *
 * v6 baseline: every v6 server reads every daemon-to-server surface and every
 * v6 daemon reads every offer field that v5 gated on a flag both sides always
 * advertised, so the server-flag rows, the `custom-harness` and
 * `terminal-projection-selection` offer rows and every strip-safe row are
 * gone. The rows left name device flags that a daemon advertises only when it
 * is configured for them.
 *
 * Senders derive their admission flags from {@link requiredReceiverCapabilities}
 * and nowhere else, so a gate cannot exist in one place and be missing in
 * another. This module imports no runtime code except the plain-data split
 * table, so it stays free of zod.
 */
import type { MessageType } from './messages';
import { SEALED_CATEGORY_CAPABILITY, SEALED_SPLIT_TABLE, type SealableMessageType, type SealedSplitEntry } from './sealed-split-table';
import type { CapabilityFlag } from './version';

export interface WireAddition {
  readonly kind: 'envelope';
  readonly rule: 'gated';
  readonly surface: MessageType;
  readonly field?: string;
  readonly value?: string;
  readonly capability: CapabilityFlag;
  readonly advertisedBy: 'device' | 'server';
}

const offerRow = (field: string | undefined, capability: CapabilityFlag, value?: string): WireAddition => ({
  kind: 'envelope', rule: 'gated', surface: 'task.offer',
  ...(field === undefined ? {} : { field }), ...(value === undefined ? {} : { value }),
  capability, advertisedBy: 'device',
});

/**
 * Sealed payload (#654, #1045): the marker of each server-to-daemon sealed
 * branch is gated on its category's device flag. The sealed branch shares
 * every other row of its type, and a field it moves or drops is absent from
 * it, so sealing never removes a gate that the same fields would need.
 * A daemon-to-server sealed branch needs no flag: the server accepts it by the
 * task's frozen `sealing`.
 */
function sealedRows(): WireAddition[] {
  return (Object.keys(SEALED_SPLIT_TABLE) as SealableMessageType[]).flatMap((surface): WireAddition[] => {
    const entry: SealedSplitEntry = SEALED_SPLIT_TABLE[surface];
    if (entry.category !== 'task-input') return [];
    return [{ kind: 'envelope', rule: 'gated', surface, field: entry.marker, capability: SEALED_CATEGORY_CAPABILITY[entry.category], advertisedBy: 'device' }];
  });
}

/**
 * Sealed payload v2 (#1045) outside the split table: an offer whose frozen
 * `sealing` lists a v2 category, and the disposition of a sealed message,
 * which names it by `contentMac`. Both go to a device.
 */
const SEALED_V2_ROWS: readonly WireAddition[] = [
  offerRow('sealing.categories', 'sealed-payload-v2', 'agent-message'),
  offerRow('sealing.categories', 'sealed-payload-v2', 'memory-projection'),
  { kind: 'envelope', rule: 'gated', surface: 'agent.message.disposition', field: 'contentMac', capability: 'sealed-payload-v2', advertisedBy: 'device' },
];

const PLAIN_ROWS: readonly WireAddition[] = [
  // Server to daemon: the offer. Every offer binds an Agent; each optional
  // field and value names the device flag a daemon advertises when it is
  // configured for it.
  offerRow(undefined, 'agent-home-contract'),
  offerRow('dispatchSelection', 'dispatch-selection'),
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
  offerRow('preparation', 'agent-input-preparation-v9'),
  // Server to daemon: Agent control messages.
  { kind: 'envelope', rule: 'gated', surface: 'agent.content.read', capability: 'agent-home-contract', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'agent.content.read', capability: 'agent-egress-policy', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'agent.content.read', capability: 'agent-egress-reliable-ack', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'agent.content.read', field: 'surface', value: 'workspace', capability: 'agent-content-workspace-read', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'agent.content.read', field: 'surface', value: 'transcript', capability: 'agent-content-transcript-read', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'agent.content.read', field: 'surface', value: 'artifact', capability: 'agent-content-artifact-read', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'agent.home.projection', capability: 'agent-home-contract', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'agent.home.projection', capability: 'agent-home-projection', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'agent.home.projection', field: 'hostRevision', capability: 'agent-home-projection-host-revision', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'agent.input.preparation', capability: 'agent-home-contract', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'agent.input.preparation', capability: 'agent-input-preparation-v9', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'provider.provisioning.available', capability: 'provider-provisioning.v1', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'agent.memory.intent.available', capability: 'agent-memory-intent.v1', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'e2ee.key_package.available', capability: 'sealed-payload-v1', advertisedBy: 'device' },
];

export const WIRE_ADDITIONS: readonly WireAddition[] = Object.freeze([
  ...PLAIN_ROWS,
  ...sealedRows(),
  ...SEALED_V2_ROWS,
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
    if (entry.surface !== type) continue;
    if (entry.field !== undefined) {
      const value = entry.field.split('.').reduce<unknown>(
        (parent, segment) => (parent !== null && typeof parent === 'object' ? (parent as Record<string, unknown>)[segment] : undefined),
        fields,
      );
      if (value === undefined) continue;
      if (entry.value !== undefined && !(Array.isArray(value) ? value.includes(entry.value) : value === entry.value)) continue;
    }
    if (!required.includes(entry.capability)) required.push(entry.capability);
  }
  return required;
}
