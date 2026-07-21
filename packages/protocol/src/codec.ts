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

// ---------------------------------------------------------------------------
// createEnvelope — finding F1: `taskId`/`seq` used to be uniformly optional
// regardless of `type`, so e.g. `createEnvelope('task.offer', payload)` (no
// `taskId`, no `seq`) type-checked cleanly and only failed much later, at
// runtime, wherever the resulting envelope happened to get decoded — often
// on the *other* side of the wire, several hops from the actual mistake.
//
// `EnvelopeShapeOptions` is the per-type source of truth for `taskId`/`seq`
// requiredness, deliberately parallel to `envelope.ts`'s own
// `envelopeShape()` calls (which encode the identical rule at the schema
// level — see docs/protocol.md §1.1/§1.2): every `task.*` type requires
// `taskId`; every type the *server* sends to the daemon additionally
// requires `seq`. `createEnvelope`'s `opts` parameter is conditionally
// required/optional per `T` from this map (`RequiredKeys`/`CreateEnvelopeArgs`
// below), so a call site missing a required field is a compile error, not a
// runtime surprise. The constructed envelope is also validated against
// {@link EnvelopeSchema} before being returned, throwing
// {@link EnvelopeValidationError} on failure — a second, runtime-level net
// for whatever the type system can't catch (e.g. a payload widened via `as`).
// ---------------------------------------------------------------------------

interface EnvelopeShapeOptions {
  'conn.hello': { taskId?: string; seq?: number };
  'conn.ack': { taskId?: string; seq: number };
  'task.offer': { taskId: string; seq: number };
  'task.approve': { taskId: string; seq: number };
  'task.reject': { taskId: string; seq: number };
  'task.cancel': { taskId: string; seq: number };
  'task.steer': { taskId: string; seq: number };
  'task.claim': { taskId: string; seq?: number };
  'task.started': { taskId: string; seq?: number };
  'task.decline': { taskId: string; seq?: number };
  'task.progress': { taskId: string; seq?: number };
  'task.artifact': { taskId: string; seq?: number };
  'task.await_approval': { taskId: string; seq?: number };
  'task.complete': { taskId: string; seq?: number };
  'task.fail': { taskId: string; seq?: number };
  'task.cancelled': { taskId: string; seq?: number };
  'task.approval_resolved': { taskId: string; seq?: number };
}

interface EnvelopeCommonOptions {
  id?: string;
  ts?: string;
  v?: number;
  /** Always optional regardless of `type` (docs/protocol.md §1.3). */
  sessionRef?: string;
}

/** Public options shape for `createEnvelope<T>` — conditionally required `taskId`/`seq` per `EnvelopeShapeOptions[T]`, plus the always-optional common fields. Defaults to the full `MessageType` union (a loose, all-optional-ish shape) when `T` isn't pinned, which is also what `createEnvelope`'s own implementation uses internally to read `opts` without fighting the per-call-site conditional. */
export type CreateEnvelopeOptions<T extends MessageType = MessageType> = EnvelopeCommonOptions &
  EnvelopeShapeOptions[T];

/** `never` unless every key of `T` is optional — i.e. whether `createEnvelope`'s `opts` argument can be omitted entirely for a given message type. */
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];

/** The rest-parameter shape for `createEnvelope`'s 3rd argument: present-and-optional when `T` needs nothing, present-and-required when it needs `taskId` and/or `seq`. */
type CreateEnvelopeArgs<T extends MessageType> = RequiredKeys<EnvelopeShapeOptions[T]> extends never
  ? [opts?: CreateEnvelopeOptions<T>]
  : [opts: CreateEnvelopeOptions<T>];

type PayloadOf<T extends MessageType> = z.infer<(typeof MESSAGE_PAYLOAD_SCHEMAS)[T]>;

/**
 * Build a well-formed {@link Envelope}, filling `v`/`id`/`ts` with defaults.
 * `opts` (`taskId`/`seq`) is required or optional depending on `type` — see
 * the module doc above — and the constructed envelope is validated against
 * {@link EnvelopeSchema} before being returned, throwing
 * {@link EnvelopeValidationError} if it doesn't satisfy the schema.
 */
export function createEnvelope<T extends MessageType>(
  type: T,
  payload: PayloadOf<T>,
  ...rest: CreateEnvelopeArgs<T>
): Extract<Envelope, { type: T }> {
  // `rest[0]`'s precise per-T type doesn't survive being read back out
  // inside a generic function body (a well-known TS limitation, not a
  // soundness gap: every concrete instantiation of `T` at the call site was
  // already checked against `CreateEnvelopeArgs<T>` above) — `opts` is
  // treated as the loose, common shape here, and the schema validation below
  // is what actually guards this function's output either way.
  const opts = (rest[0] ?? {}) as CreateEnvelopeOptions;
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

  const result = EnvelopeSchema.safeParse(envelope);
  if (!result.success) {
    throw new EnvelopeValidationError(`createEnvelope built an invalid envelope for type "${type}"`, result.error);
  }
  return result.data as Extract<Envelope, { type: T }>;
}
