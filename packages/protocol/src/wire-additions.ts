/**
 * The one table of receiver-capability gates and wire additions
 * (docs/protocol.md "Freeze rule").
 *
 * A v4 change takes exactly one of three paths: a version bump, a gated
 * addition, or a strip-safe addition. Envelope and HTTP rows have explicit
 * kinds. The last two are declared here.
 *
 * - `gated`: the sender must not emit the surface unless the receiver
 *   durably advertised `capability`. A field entry applies when the payload
 *   carries the field (and, with `value`, when the field equals it); a
 *   dotted field names a nested field, for example `sealed.ciphertextRef`. A type
 *   entry applies to every message of that type. Server-to-daemon surfaces
 *   are gated by a device flag, daemon-to-server surfaces by a server flag.
 * - `strip-safe`: an optional field an older receiver drops without changing
 *   what it executes or acknowledges.
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
 * Senders derive their admission flags from {@link requiredReceiverCapabilities}
 * and nowhere else, so a gate cannot exist in one place and be missing in
 * another. This module imports no runtime code except the plain-data split
 * table, so it stays free of zod.
 */
import type { MessageType } from './messages';
import { SEALED_SPLIT_TABLE, type SealableMessageType, type SealedSplitEntry } from './sealed-split-table';
import type { CapabilityFlag } from './version';

type HttpWireSurface =
  | 'ChallengeRequest' | 'ChallengeResponse' | 'TokenRequest' | 'TokenResponse'
  | 'EventsPollQuery' | 'EventsPollResponse' | 'MessagesSendRequest' | 'MessagesSendResponse';

export type WireAddition =
  | {
      readonly kind: 'envelope';
      readonly rule: 'gated';
      readonly surface: MessageType;
      readonly field?: string;
      readonly value?: string;
      readonly capability: CapabilityFlag;
      readonly advertisedBy: 'device' | 'server';
    }
  | { readonly kind: 'envelope'; readonly rule: 'strip-safe'; readonly surface: MessageType; readonly field: string }
  | { readonly kind: 'http'; readonly rule: 'strip-safe'; readonly surface: HttpWireSurface; readonly field: string };

const offerRow = (field: string | undefined, capability: CapabilityFlag, value?: string): WireAddition => ({
  kind: 'envelope', rule: 'gated', surface: 'task.offer',
  ...(field === undefined ? {} : { field }), ...(value === undefined ? {} : { value }),
  capability, advertisedBy: 'device',
});

/**
 * Sealed payload v1 (#654), one table entry at a time: the marker of each
 * sealed branch is gated on `sealed-payload-v1`, a server-to-daemon type on
 * the device flag, a daemon-to-server type on the server flag. The sealed
 * branch shares every other row of its type, and a field it moves or drops is
 * absent from it, so sealing never removes a gate that the same fields would
 * need. A sealed task output that may name its ciphertext blob is also gated
 * on that field. The four sealed failure codes on the plaintext
 * `task.decline` are value gates.
 */
function sealedRows(): WireAddition[] {
  return (Object.keys(SEALED_SPLIT_TABLE) as SealableMessageType[]).flatMap((surface) => {
    const entry: SealedSplitEntry = SEALED_SPLIT_TABLE[surface];
    const advertisedBy = entry.category === 'task-input' ? 'device' : 'server';
    const byReference: WireAddition[] = advertisedBy === 'server' && entry.inlineOnly !== true
      ? [{ kind: 'envelope', rule: 'gated', surface, field: 'sealed.ciphertextRef', capability: 'sealed-output-ciphertext-ref', advertisedBy }]
      : [];
    return [{ kind: 'envelope', rule: 'gated', surface, field: entry.marker, capability: 'sealed-payload-v1', advertisedBy }, ...byReference];
  });
}
const SEALED_DECLINE_CODE = (value: string): WireAddition =>
  ({ kind: 'envelope', rule: 'gated', surface: 'task.decline', field: 'code', value, capability: 'sealed-payload-v1', advertisedBy: 'server' });

const PLAIN_ROWS: readonly WireAddition[] = [
  // Server to daemon: the offer. Every offer binds an Agent; each optional
  // field and value names the device flag a daemon advertises when it is
  // configured for it.
  offerRow(undefined, 'agent-home-contract'),
  offerRow('dispatchSelection', 'dispatch-selection'),
  offerRow('requiredToolsets', 'toolset-selection'),
  offerRow('terminalProjection', 'terminal-projection-selection'),
  offerRow('homeAccess', 'agent-home-readers'),
  offerRow('harnessId', 'custom-harness'),
  offerRow('agentMemory', 'agent-memory-selection'),
  offerRow('agentMemory', 'agent-memory-read-if-admitted', 'read-if-admitted'),
  offerRow('agentMemory', 'agent-memory-read-write-if-admitted', 'read-write-if-admitted'),
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
  { kind: 'envelope', rule: 'gated', surface: 'agent.input.preparation', capability: 'agent-home-contract', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'agent.input.preparation', capability: 'agent-input-preparation-v9', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'provider.provisioning.available', capability: 'provider-provisioning.v1', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'agent.memory.intent.available', capability: 'agent-memory-intent.v1', advertisedBy: 'device' },
  { kind: 'envelope', rule: 'gated', surface: 'e2ee.key_package.available', capability: 'sealed-payload-v1', advertisedBy: 'device' },
  // One optional runtime capability, shared by discovery and the claim snapshot.
  { kind: 'envelope', rule: 'strip-safe', surface: 'conn.hello', field: 'runtimes[].capabilities.messageDraft' },
  { kind: 'envelope', rule: 'strip-safe', surface: 'conn.hello', field: 'harnesses[].capabilities.messageDraft' },
  { kind: 'envelope', rule: 'strip-safe', surface: 'task.claim', field: 'capabilities.messageDraft' },
  // Optional MCP event identity is observability only; older receivers may omit it.
  { kind: 'envelope', rule: 'strip-safe', surface: 'task.progress', field: 'events[].mcp' },
  // Daemon to server.
  { kind: 'envelope', rule: 'gated', surface: 'agent.message.draft', capability: 'agent-message-draft', advertisedBy: 'server' },
  { kind: 'envelope', rule: 'gated', surface: 'task.fail', field: 'failure', capability: 'runtime-failure-class', advertisedBy: 'server' },
  // Relative token lifetime (#1114). A published device drops it and keeps
  // reading `expiresAt`, which the Host still sends.
  { kind: 'http', rule: 'strip-safe', surface: 'TokenResponse', field: 'expiresIn' },
];

export const WIRE_ADDITIONS: readonly WireAddition[] = Object.freeze([
  ...PLAIN_ROWS,
  ...sealedRows(),
  SEALED_DECLINE_CODE('sealed_key_unavailable'),
  SEALED_DECLINE_CODE('sealed_open_failed'),
  SEALED_DECLINE_CODE('sealed_content_mac_mismatch'),
  SEALED_DECLINE_CODE('sealing_policy_mismatch'),
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
    if (entry.kind !== 'envelope' || entry.rule !== 'gated' || entry.surface !== type) continue;
    if (entry.field !== undefined) {
      const value = entry.field.split('.').reduce<unknown>(
        (parent, segment) => (parent !== null && typeof parent === 'object' ? (parent as Record<string, unknown>)[segment] : undefined),
        fields,
      );
      if (value === undefined) continue;
      if (entry.value !== undefined && value !== entry.value) continue;
    }
    if (!required.includes(entry.capability)) required.push(entry.capability);
  }
  return required;
}
