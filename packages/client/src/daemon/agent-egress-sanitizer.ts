import { parseMessage, type AgentEvent, type Envelope } from '@byok-sdk/protocol';
import {
  metadataStatusEvent,
  type AgentEgressDropReason,
  type AgentEgressPolicy,
} from './agent-egress-policy';

export interface AgentEgressSanitizerContext {
  readonly lane: 'latest-value' | 'reliable';
  readonly policyRevision: string;
  readonly envelopeType?: string;
  readonly agentId?: string;
  readonly tenantId?: string;
}

/**
 * Optional named host redaction hook for an explicitly contentful policy.
 * It receives the SDK-projected value, never a second raw wire
 * representation. Throwing/refusing drops the event; callers never receive
 * an original-payload fallback.
 */
export type AgentEgressSanitizer = (value: unknown, context: AgentEgressSanitizerContext) => unknown;

export class AgentEgressSanitizationError extends Error {
  constructor(message: string, readonly reason: AgentEgressDropReason = 'sanitizer_rejected') {
    super(message);
    this.name = 'AgentEgressSanitizationError';
  }
}

export type SanitizedEnvelope =
  | Readonly<{ ok: true; envelope: Envelope }>
  | Readonly<{ ok: false; reason: AgentEgressDropReason }>;

function cloneJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new AgentEgressSanitizationError(
      `egress value cannot be serialized safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function contentlessPayload(envelope: Envelope): unknown | undefined {
  const payload = cloneJson(envelope.payload);
  const record = asRecord(payload);
  if (!record) return payload;

  switch (envelope.type) {
    case 'task.progress': {
      if (!Array.isArray(record.events)) throw new AgentEgressSanitizationError('task.progress has no event array');
      return {
        ...record,
        events: record.events.map((event) => metadataStatusEvent(event as AgentEvent)),
      };
    }
    case 'task.complete':
      if (typeof record.summary === 'string') record.summary = '[content omitted]';
      // A result document is product content, not status. Omit its optional
      // field rather than half-redacting it into an invalid document shape.
      delete record.document;
      return record;
    case 'task.fail':
    case 'task.decline':
    case 'task.cancelled':
      if (typeof record.reason === 'string') record.reason = '[status omitted]';
      return record;
    case 'task.await_approval':
      if (typeof record.summary === 'string') record.summary = '[approval pending]';
      if (typeof record.reason === 'string') record.reason = '[approval pending]';
      return record;
    case 'task.artifact':
      // Artifact fields are a separate, capability-gated content surface.
      return undefined;
    case 'agent.egress.reliable':
      return { ...record, payload: metadataOnlyValue(record.payload) };
    default:
      return record;
  }
}

function applyHostSanitizer(
  value: unknown,
  sanitizer: AgentEgressSanitizer | undefined,
  context: AgentEgressSanitizerContext,
): unknown {
  if (!sanitizer) return value;
  try {
    return sanitizer(value, context);
  } catch (error) {
    throw new AgentEgressSanitizationError(
      `configured Agent egress sanitizer rejected the value: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The one envelope-boundary sanitizer used before either transport sees an
 * envelope. It parses the final value through the frozen protocol so a
 * broken custom sanitizer also fails locally, before WS bytes or long-poll
 * JSON can be created.
 */
export function sanitizeEgressEnvelope(
  envelope: Envelope,
  policy: Readonly<AgentEgressPolicy>,
  sanitizer: AgentEgressSanitizer | undefined,
  context: Omit<AgentEgressSanitizerContext, 'lane' | 'policyRevision' | 'envelopeType'> & {
    lane?: 'latest-value' | 'reliable';
  } = {},
): SanitizedEnvelope {
  try {
    const payload = policy.activity.mode === 'metadata-status'
      ? contentlessPayload(envelope)
      : cloneJson(envelope.payload);
    if (payload === undefined) return { ok: false, reason: 'policy_denied' };
    const sanitizedPayload = applyHostSanitizer(payload, sanitizer, {
      lane: context.lane ?? 'latest-value',
      policyRevision: policy.policyRevision,
      envelopeType: envelope.type,
      agentId: context.agentId,
      tenantId: context.tenantId,
    });
    const parsed = parseMessage({ ...envelope, payload: sanitizedPayload });
    return { ok: true, envelope: parsed };
  } catch (error) {
    if (error instanceof AgentEgressSanitizationError) return { ok: false, reason: error.reason };
    return { ok: false, reason: 'sanitizer_rejected' };
  }
}

/** Sanitizes a reliable payload before it is hashed/appended, never after. */
export function sanitizeReliablePayload(
  payload: unknown,
  policy: Readonly<AgentEgressPolicy>,
  sanitizer: AgentEgressSanitizer | undefined,
  context: Omit<AgentEgressSanitizerContext, 'lane' | 'policyRevision'> = {},
): unknown {
  const projected = policy.activity.mode === 'metadata-status' ? metadataOnlyValue(payload) : cloneJson(payload);
  return applyHostSanitizer(projected, sanitizer, {
    lane: 'reliable',
    policyRevision: policy.policyRevision,
    envelopeType: context.envelopeType,
    agentId: context.agentId,
    tenantId: context.tenantId,
  });
}

/** A reliable metadata projection never recursively inspects opaque content. */
function metadataOnlyValue(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return { status: 'content omitted' };
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    if (/^(id|eventId|cursor|status|state|code|kind|type|createdAt|updatedAt|count|bytes)$/iu.test(key)) {
      if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') result[key] = child;
    }
  }
  return result;
}
