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
