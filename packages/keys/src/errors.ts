/**
 * Single error class for `@byok/keys`.
 *
 * The ported source (`aip-main-open@c6a5385`, `apps/local-agent/src/providers.ts`)
 * raised two different classes — `LocalExecutionError` and
 * `ResearchExecutionError` — that differed only in which subsystem owned the
 * throw site; both carried a `code` string and consumers branched on that code.
 * The narrative/research subsystem stays behind in aip-main-open, so this
 * package keeps one class and preserves the `code` strings verbatim. K4's swap
 * converts aip's two `instanceof` sites to structured code detection, so the
 * strings — not the class identity — are the compatibility surface.
 */
export class ByokKeysError extends Error {
  public readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ByokKeysError';
    this.code = code;
  }
}

/**
 * Error codes this package can throw, ported verbatim from the source. Kept as
 * a named record so consumers (and K4's aip-main-open swap) can branch on
 * `error.code` without retyping string literals.
 */
export const BYOK_KEYS_ERROR_CODES = {
  MODEL_PROVIDER_AUTH_FAILED: 'MODEL_PROVIDER_AUTH_FAILED',
  MODEL_PROVIDER_BALANCE_INSUFFICIENT: 'MODEL_PROVIDER_BALANCE_INSUFFICIENT',
  MODEL_PROVIDER_HTTP_ERROR: 'MODEL_PROVIDER_HTTP_ERROR',
  MODEL_PROVIDER_MODEL_NOT_FOUND: 'MODEL_PROVIDER_MODEL_NOT_FOUND',
  MODEL_PROVIDER_RATE_LIMITED: 'MODEL_PROVIDER_RATE_LIMITED',
  MODEL_RESPONSE_INVALID: 'MODEL_RESPONSE_INVALID',
  PROVIDER_PROFILE_INVALID: 'PROVIDER_PROFILE_INVALID',
  PROVIDER_REQUEST_TIMEOUT: 'PROVIDER_REQUEST_TIMEOUT',
  PROVIDER_RESPONSE_INVALID: 'PROVIDER_RESPONSE_INVALID',
  PROVIDER_RESPONSE_TOO_LARGE: 'PROVIDER_RESPONSE_TOO_LARGE',
  PROVIDER_SECRET_MISSING: 'PROVIDER_SECRET_MISSING',
  PROVIDER_URL_INVALID: 'PROVIDER_URL_INVALID',
} as const;

export type ByokKeysErrorCode =
  (typeof BYOK_KEYS_ERROR_CODES)[keyof typeof BYOK_KEYS_ERROR_CODES];
