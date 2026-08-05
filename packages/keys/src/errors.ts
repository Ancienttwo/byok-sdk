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
 *
 * Five codes have no source counterpart. Four of them guard checks the source
 * did not make: `KEYCHAIN_SECRET_DECODE_FAILED` (the source returned an
 * undecodable stored value as-is), `SECRET_ENVELOPE_INVALID` (it reported a
 * malformed envelope as an absent secret), and `SECRET_NAME_INVALID` /
 * `SECRET_VALUE_INVALID` (the runtime replacements for the closed
 * `KeychainSecretName` union). The fifth, `SECRET_NAMESPACE_INVALID`, guards a
 * check the source did make: `normalizeSecretNamespace` (`index.ts:748-757`),
 * whose pattern this package ports verbatim. Only the check is ported — no
 * source code string is recorded for its rejection path — so treat the code
 * itself as this package's, not as a compatibility surface K4 must match.
 * Everything else matches the source string for string.
 */
export const BYOK_KEYS_ERROR_CODES = {
  CREDENTIAL_MANAGER_DELETE_FAILED: 'CREDENTIAL_MANAGER_DELETE_FAILED',
  CREDENTIAL_MANAGER_READ_FAILED: 'CREDENTIAL_MANAGER_READ_FAILED',
  CREDENTIAL_MANAGER_SECRET_INVALID: 'CREDENTIAL_MANAGER_SECRET_INVALID',
  CREDENTIAL_MANAGER_UNAVAILABLE: 'CREDENTIAL_MANAGER_UNAVAILABLE',
  CREDENTIAL_MANAGER_WRITE_FAILED: 'CREDENTIAL_MANAGER_WRITE_FAILED',
  KEYCHAIN_ARGUMENT_INVALID: 'KEYCHAIN_ARGUMENT_INVALID',
  KEYCHAIN_DELETE_FAILED: 'KEYCHAIN_DELETE_FAILED',
  KEYCHAIN_READ_FAILED: 'KEYCHAIN_READ_FAILED',
  KEYCHAIN_SECRET_DECODE_FAILED: 'KEYCHAIN_SECRET_DECODE_FAILED',
  KEYCHAIN_SECRET_INVALID: 'KEYCHAIN_SECRET_INVALID',
  KEYCHAIN_UNAVAILABLE: 'KEYCHAIN_UNAVAILABLE',
  KEYCHAIN_WRITE_FAILED: 'KEYCHAIN_WRITE_FAILED',
  LOCAL_ACCOUNT_SCOPE_INVALID: 'LOCAL_ACCOUNT_SCOPE_INVALID',
  MODEL_PROVIDER_AUTH_FAILED: 'MODEL_PROVIDER_AUTH_FAILED',
  MODEL_PROVIDER_BALANCE_INSUFFICIENT: 'MODEL_PROVIDER_BALANCE_INSUFFICIENT',
  MODEL_PROVIDER_HTTP_ERROR: 'MODEL_PROVIDER_HTTP_ERROR',
  MODEL_PROVIDER_MODEL_NOT_FOUND: 'MODEL_PROVIDER_MODEL_NOT_FOUND',
  MODEL_PROVIDER_RATE_LIMITED: 'MODEL_PROVIDER_RATE_LIMITED',
  MODEL_RESPONSE_INVALID: 'MODEL_RESPONSE_INVALID',
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  PROVIDER_PROFILE_INVALID: 'PROVIDER_PROFILE_INVALID',
  PROVIDER_REQUEST_TIMEOUT: 'PROVIDER_REQUEST_TIMEOUT',
  PROVIDER_RESPONSE_INVALID: 'PROVIDER_RESPONSE_INVALID',
  PROVIDER_RESPONSE_TOO_LARGE: 'PROVIDER_RESPONSE_TOO_LARGE',
  PROVIDER_SECRET_EMPTY: 'PROVIDER_SECRET_EMPTY',
  PROVIDER_SECRET_MISSING: 'PROVIDER_SECRET_MISSING',
  PROVIDER_SECRET_NOT_ALLOWED: 'PROVIDER_SECRET_NOT_ALLOWED',
  PROVIDER_STORE_UNAVAILABLE: 'PROVIDER_STORE_UNAVAILABLE',
  PROVIDER_URL_INVALID: 'PROVIDER_URL_INVALID',
  SECRET_ENVELOPE_INVALID: 'SECRET_ENVELOPE_INVALID',
  SECRET_NAME_INVALID: 'SECRET_NAME_INVALID',
  SECRET_NAMESPACE_INVALID: 'SECRET_NAMESPACE_INVALID',
  SECRET_VALUE_INVALID: 'SECRET_VALUE_INVALID',
} as const;

export type ByokKeysErrorCode =
  (typeof BYOK_KEYS_ERROR_CODES)[keyof typeof BYOK_KEYS_ERROR_CODES];
