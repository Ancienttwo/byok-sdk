import type { ZodError } from 'zod';

/** Base class for all protocol decode/validation errors. */
export class ProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProtocolError';
  }
}

/** The input was not valid JSON at all (only thrown by `decodeEnvelope`). */
export class EnvelopeParseError extends ProtocolError {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'EnvelopeParseError';
  }
}

/**
 * The `type` field did not match any known message type. This is distinct
 * from {@link EnvelopeValidationError} on purpose: a daemon/server on an
 * older minor version should catch this specifically and skip the message
 * instead of treating it as a bug, since a newer peer may have introduced an
 * additive message type it doesn't understand yet.
 */
export class UnknownMessageTypeError extends ProtocolError {
  public readonly type: unknown;

  constructor(type: unknown) {
    super(`Unknown message type: ${String(type)}`);
    this.name = 'UnknownMessageTypeError';
    this.type = type;
  }
}

/** The `type` field was recognized but the envelope/payload failed schema validation. */
export class EnvelopeValidationError extends ProtocolError {
  public readonly issues: ZodError;

  constructor(message: string, issues: ZodError) {
    super(message, { cause: issues });
    this.name = 'EnvelopeValidationError';
    this.issues = issues;
  }
}

/**
 * A peer did not negotiate this wire major (wire v7). The answer to a lone
 * `conn.hello` was an explicit, permanent refusal — a `rejected` outcome with
 * `protocol_version_unsupported`, or a 4xx other than 401, 403, 409, 413 and 429 —
 * so the peer cannot read this major. `peerVersion` is present only when the
 * peer stated its major; a refusal never implies which major the peer speaks.
 * A coordinated upgrade of the server side and the daemons resolves it.
 */
export class ProtocolNegotiationError extends ProtocolError {
  public readonly code = 'protocol_negotiation_failed' as const;
  public readonly localVersion: number;
  public readonly peerVersion: number | undefined;
  public readonly httpStatus: number;

  constructor(input: { readonly localVersion: number; readonly peerVersion?: number; readonly httpStatus: number }) {
    super(`peer did not negotiate wire v${input.localVersion}${input.peerVersion === undefined ? '' : ` (peer speaks v${input.peerVersion})`}; upgrade the server side and the daemons to the same wire major`);
    this.name = 'ProtocolNegotiationError';
    this.localVersion = input.localVersion;
    this.peerVersion = input.peerVersion;
    this.httpStatus = input.httpStatus;
  }
}
