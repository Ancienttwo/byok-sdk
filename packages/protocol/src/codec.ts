import type { z } from 'zod';
import { EnvelopeSchema, type Envelope } from './envelope';
import { MESSAGE_TYPES, MESSAGE_PAYLOAD_SCHEMAS, type MessageType } from './messages';
import { PROTOCOL_VERSION } from './version';
import { EnvelopeParseError, EnvelopeValidationError, UnknownMessageTypeError } from './errors';

const MESSAGE_TYPE_SET = new Set<string>(MESSAGE_TYPES);

function decodeText(input: string | Uint8Array): string {
  return typeof input === 'string' ? input : new TextDecoder('utf-8').decode(input);
}

/**
 * Validate an already-parsed JS value as an {@link Envelope}, narrowing
 * `payload` by `type`. Throws {@link UnknownMessageTypeError} when `type`
 * isn't a recognized message type (safe for the caller to skip/ignore), or
 * {@link EnvelopeValidationError} when a recognized type fails schema
 * validation.
 */
export function parseMessage(data: unknown): Envelope {
  const result = EnvelopeSchema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  const typeValue =
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>).type
      : undefined;

  if (typeof typeValue !== 'string' || !MESSAGE_TYPE_SET.has(typeValue)) {
    throw new UnknownMessageTypeError(typeValue);
  }

  throw new EnvelopeValidationError(
    `Envelope failed validation for type "${typeValue}"`,
    result.error,
  );
}

/**
 * Decode a single NDJSON line into a validated {@link Envelope}. Accepts a
 * string or raw bytes (e.g. a WebSocket binary frame) — isomorphic, no
 * stream handling required of the caller.
 */
export function decodeEnvelope(line: string | Uint8Array): Envelope {
  const text = decodeText(line).replace(/[\r\n]+$/, '');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (cause) {
    throw new EnvelopeParseError('Envelope line is not valid JSON', cause);
  }
  return parseMessage(json);
}

/** Encode an {@link Envelope} as a single-line NDJSON string (trailing `\n` included). */
export function encodeEnvelope(env: Envelope): string {
  return `${JSON.stringify(env)}\n`;
}

export interface CreateEnvelopeOptions {
  id?: string;
  ts?: string;
  v?: number;
  taskId?: string;
  sessionRef?: string;
  seq?: number;
}

type PayloadOf<T extends MessageType> = z.infer<(typeof MESSAGE_PAYLOAD_SCHEMAS)[T]>;

/** Build a well-formed {@link Envelope}, filling `v` / `id` / `ts` with defaults. */
export function createEnvelope<T extends MessageType>(
  type: T,
  payload: PayloadOf<T>,
  opts: CreateEnvelopeOptions = {},
): Extract<Envelope, { type: T }> {
  const envelope = {
    v: opts.v ?? PROTOCOL_VERSION,
    id: opts.id ?? crypto.randomUUID(),
    ts: opts.ts ?? new Date().toISOString(),
    type,
    ...(opts.taskId !== undefined ? { task_id: opts.taskId } : {}),
    ...(opts.sessionRef !== undefined ? { session_ref: opts.sessionRef } : {}),
    ...(opts.seq !== undefined ? { seq: opts.seq } : {}),
    payload,
  };
  return envelope as unknown as Extract<Envelope, { type: T }>;
}
