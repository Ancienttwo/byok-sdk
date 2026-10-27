/**
 * One-shot migration of envelopes stored under wire v3 (#925). An operator
 * runs it once, after draining mailboxes and ending executions, before a v4
 * server starts. It ships in 0.31.x only; the next minor removes it.
 */
import { encodeEnvelope } from './codec';
import { EnvelopeSchema } from './envelope';
import { MESSAGE_TYPES, type MessageType } from './messages';

/**
 * Every wire v3 message type and its v4 type. `null` marks a v3 type that v4
 * does not carry: a stored body of that type cannot be migrated.
 */
export const WIRE_V3_TO_V4_TYPES: Readonly<Record<string, MessageType | null>> = Object.freeze({
  'conn.hello': 'conn.hello',
  'conn.ack': null,
  'task.offer': null,
  'task.offer_with_toolsets': null,
  'task.offer_for_agent': 'task.offer_for_agent',
  'task.offer_for_agent_with_egress': 'task.offer_for_agent_with_egress',
  'task.offer_for_agent_with_egress_fresh': 'task.offer_for_agent_with_egress_fresh',
  'task.offer_prepared': 'task.offer_prepared',
  'task.offer_sealed': null,
  'task.offer_with_toolsets_sealed': null,
  'task.offer_for_agent_sealed': 'task.offer_for_agent_sealed',
  'task.offer_for_agent_with_egress_sealed': 'task.offer_for_agent_with_egress_sealed',
  'task.offer_for_agent_with_egress_fresh_sealed': 'task.offer_for_agent_with_egress_fresh_sealed',
  'agent.egress.reliable': 'agent.egress.reliable',
  'agent.egress.ack': 'agent.egress.ack',
  'agent.message.draft': 'agent.message.draft',
  'agent.message.publish': 'agent.message.publish',
  'agent.message.disposition': 'agent.message.disposition',
  'agent.content.read': 'agent.content.read',
  'agent.content.receipt': 'agent.content.receipt',
  'agent.home.projection': 'agent.home.projection',
  'agent.input.preparation': 'agent.input.preparation',
  'provider.provisioning.available': 'provider.provisioning.available',
  'agent.memory.intent.available': 'agent.memory.intent.available',
  'task.approve': 'task.approve',
  'task.reject': 'task.reject',
  'task.cancel': 'task.cancel',
  'task.steer': 'task.steer',
  'task.claim': 'task.claim',
  'task.started': 'task.started',
  'task.decline': 'task.decline',
  'task.progress': 'task.progress',
  'task.artifact': 'task.artifact',
  'task.await_approval': 'task.await_approval',
  'task.complete': 'task.complete',
  'task.fail': 'task.fail',
  'task.cancelled': 'task.cancelled',
  'task.approval_resolved': 'task.approval_resolved',
  'task.steer_sealed': 'task.steer_sealed',
  'task.complete_sealed': 'task.complete_sealed',
  'task.fail_sealed': 'task.fail_sealed',
  'task.decline_sealed': 'task.decline_sealed',
  'task.cancelled_sealed': 'task.cancelled_sealed',
  'task.progress_sealed': 'task.progress_sealed',
  'task.artifact_sealed': 'task.artifact_sealed',
  'task.await_approval_sealed': 'task.await_approval_sealed',
  'e2ee.key_package.available': 'e2ee.key_package.available',
});

for (const [v3Type, v4Type] of Object.entries(WIRE_V3_TO_V4_TYPES)) {
  if (v4Type !== null && !(MESSAGE_TYPES as readonly string[]).includes(v4Type)) {
    throw new Error(`WIRE_V3_TO_V4_TYPES maps ${v3Type} to ${v4Type}, which is not a v4 message type`);
  }
}

/** Why a stored v3 body cannot be migrated. */
export type WireV4MigrationRefusal =
  /** Not JSON, not an envelope object, or not `v: 3`. */
  | 'not_wire_v3'
  /** A v3 type that {@link WIRE_V3_TO_V4_TYPES} maps to `null`, or does not list. */
  | 'type_without_v4_form'
  /** The mapped envelope does not parse under v4. */
  | 'invalid_under_v4';

export type WireV4MigrationResult =
  | { readonly ok: true; readonly type: MessageType; readonly body: string }
  | { readonly ok: false; readonly type?: string; readonly refusal: WireV4MigrationRefusal };

/** The v4 type of a v3 type, or `undefined` when v4 does not carry it. */
export function wireV4TypeOf(v3Type: string): MessageType | undefined {
  return Object.hasOwn(WIRE_V3_TO_V4_TYPES, v3Type) ? WIRE_V3_TO_V4_TYPES[v3Type] ?? undefined : undefined;
}

/**
 * Re-encodes one stored wire v3 envelope as v4. The result is the canonical
 * v4 encoding, so its bytes and hash differ from the v3 body.
 */
export function migrateWireV3Envelope(body: string): WireV4MigrationResult {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, refusal: 'not_wire_v3' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, refusal: 'not_wire_v3' };
  const stored = raw as Record<string, unknown>;
  const v3Type = typeof stored.type === 'string' ? stored.type : undefined;
  if (stored.v !== 3 || v3Type === undefined) return { ok: false, ...(v3Type === undefined ? {} : { type: v3Type }), refusal: 'not_wire_v3' };
  const v4Type = wireV4TypeOf(v3Type);
  if (v4Type === undefined) return { ok: false, type: v3Type, refusal: 'type_without_v4_form' };
  const parsed = EnvelopeSchema.safeParse({ ...stored, v: 4, type: v4Type });
  if (!parsed.success) return { ok: false, type: v3Type, refusal: 'invalid_under_v4' };
  return { ok: true, type: v4Type, body: encodeEnvelope(parsed.data) };
}
