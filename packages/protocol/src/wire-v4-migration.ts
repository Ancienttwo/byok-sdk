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
 * does not carry: a stored body of that type cannot be migrated. The Agent
 * offers become `task.offer`, and each sealed type becomes its plaintext type,
 * whose sealed branch its payload takes unchanged.
 */
export const WIRE_V3_TO_V4_TYPES: Readonly<Record<string, MessageType | null>> = Object.freeze({
  'conn.hello': 'conn.hello',
  'conn.ack': null,
  'task.offer': null,
  'task.offer_with_toolsets': null,
  'task.offer_for_agent': 'task.offer',
  'task.offer_for_agent_with_egress': 'task.offer',
  'task.offer_for_agent_with_egress_fresh': 'task.offer',
  'task.offer_prepared': 'task.offer',
  'task.offer_sealed': null,
  'task.offer_with_toolsets_sealed': null,
  'task.offer_for_agent_sealed': 'task.offer',
  'task.offer_for_agent_with_egress_sealed': 'task.offer',
  'task.offer_for_agent_with_egress_fresh_sealed': 'task.offer',
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
  'task.steer_sealed': 'task.steer',
  'task.complete_sealed': 'task.complete',
  'task.fail_sealed': 'task.fail',
  'task.decline_sealed': 'task.decline',
  'task.cancelled_sealed': 'task.cancelled',
  'task.progress_sealed': 'task.progress',
  'task.artifact_sealed': 'task.artifact',
  'task.await_approval_sealed': 'task.await_approval',
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
 * The `session` each v3 Agent offer type implies. A v3 resume offer names its
 * session in `sessionRef`; the fresh and prepared offers had none. A
 * `task.offer_for_agent` without `sessionRef` has no v4 form: v4 has no fresh
 * offer without egress, and a missing reference never means fresh.
 */
const V3_OFFER_SESSION: Readonly<Record<string, 'resume' | 'fresh'>> = Object.freeze({
  'task.offer_for_agent': 'resume',
  'task.offer_for_agent_with_egress': 'resume',
  'task.offer_for_agent_sealed': 'resume',
  'task.offer_for_agent_with_egress_sealed': 'resume',
  'task.offer_for_agent_with_egress_fresh': 'fresh',
  'task.offer_for_agent_with_egress_fresh_sealed': 'fresh',
  'task.offer_prepared': 'fresh',
});

/**
 * The v4 type and payload of a stored v3 message, before v4 validation, or
 * `undefined` when v4 does not carry its type. An Agent offer's `sessionRef`
 * becomes `session`; every other payload keeps its fields.
 */
export function wireV4FormOf(v3Type: string, payload: unknown): { readonly type: MessageType; readonly payload: unknown } | undefined {
  const type = wireV4TypeOf(v3Type);
  if (type === undefined) return undefined;
  const mode = Object.hasOwn(V3_OFFER_SESSION, v3Type) ? V3_OFFER_SESSION[v3Type] : undefined;
  if (mode === undefined || payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { type, payload };
  const { sessionRef, ...rest } = payload as Readonly<Record<string, unknown>>;
  if (mode === 'fresh') return { type, payload: sessionRef === undefined ? { ...rest, session: { mode } } : payload };
  return { type, payload: sessionRef === undefined ? rest : { ...rest, session: { mode, sessionRef } } };
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
  const v4 = wireV4FormOf(v3Type, stored.payload);
  if (v4 === undefined) return { ok: false, type: v3Type, refusal: 'type_without_v4_form' };
  const parsed = EnvelopeSchema.safeParse({ ...stored, v: 4, type: v4.type, payload: v4.payload });
  if (!parsed.success) return { ok: false, type: v3Type, refusal: 'invalid_under_v4' };
  return { ok: true, type: v4.type, body: encodeEnvelope(parsed.data) };
}
