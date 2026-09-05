/**
 * Single error class for `@byok-sdk/keys`.
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
  public readonly httpStatus?: number;

  constructor(
    code: string,
    message: string,
    options?: ErrorOptions & { httpStatus?: number },
  ) {
    super(message, options);
    this.name = 'ByokKeysError';
    this.code = code;
    this.httpStatus = options?.httpStatus;
  }
}

/**
 * Error codes this package can throw, ported verbatim from the source. Kept as
 * a named record so consumers (and K4's aip-main-open swap) can branch on
 * `error.code` without retyping string literals.
 *
 * Four codes have no source counterpart, and each guards a check the source did
 * not make: `KEYCHAIN_SECRET_DECODE_FAILED` (the source returned an undecodable
 * stored value as-is), `SECRET_ENVELOPE_INVALID` (it reported a malformed
 * envelope as an absent secret), and `SECRET_NAME_INVALID` /
 * `SECRET_VALUE_INVALID` (the runtime replacements for the closed
 * `KeychainSecretName` union). `PROVIDER_STORE_SCHEMA_STALE` joins them: it
 * guards a persisted `provider_profile` DDL that differs from the one this
 * package generates. Everything else matches the source string for string.
 *
 * `SECRET_NAMESPACE_INVALID` is a separate case. The source does record it:
 * `normalizeSecretNamespace` (`index.ts:748-757`) throws the verbatim string
 * `'SECRET_NAMESPACE_INVALID'` at `index.ts:752`, and this package ports both
 * that string and its pattern unchanged. It is still not a compatibility
 * surface K4 must match, but for a different reason than the string: neither
 * side has a branch consumer. In the source the only callers are the two OS
 * stores' `scope()` methods, which just compose a service prefix; here the code
 * is only ever asserted in tests. Matching it costs nothing and constrains
 * nothing.
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
  PROVIDER_PROFILE_CONFLICT: 'PROVIDER_PROFILE_CONFLICT',
  PROVIDER_REQUEST_TIMEOUT: 'PROVIDER_REQUEST_TIMEOUT',
  PROVIDER_RESPONSE_INVALID: 'PROVIDER_RESPONSE_INVALID',
  PROVIDER_RESPONSE_TOO_LARGE: 'PROVIDER_RESPONSE_TOO_LARGE',
  PROVIDER_SECRET_EMPTY: 'PROVIDER_SECRET_EMPTY',
  PROVIDER_SECRET_MISSING: 'PROVIDER_SECRET_MISSING',
  PROVIDER_SECRET_NOT_ALLOWED: 'PROVIDER_SECRET_NOT_ALLOWED',
  PROVIDER_SECRET_ROLLBACK_FAILED: 'PROVIDER_SECRET_ROLLBACK_FAILED',
  PROVIDER_STORE_SCHEMA_STALE: 'PROVIDER_STORE_SCHEMA_STALE',
  PROVIDER_STORE_UNAVAILABLE: 'PROVIDER_STORE_UNAVAILABLE',
  PROVIDER_TRUTH_INVALID: 'PROVIDER_TRUTH_INVALID',
  PROVIDER_URL_INVALID: 'PROVIDER_URL_INVALID',
  SECRET_ENVELOPE_INVALID: 'SECRET_ENVELOPE_INVALID',
  SECRET_NAME_INVALID: 'SECRET_NAME_INVALID',
  SECRET_NAMESPACE_INVALID: 'SECRET_NAMESPACE_INVALID',
  SECRET_VALUE_INVALID: 'SECRET_VALUE_INVALID',
} as const;

export type ByokKeysErrorCode =
  (typeof BYOK_KEYS_ERROR_CODES)[keyof typeof BYOK_KEYS_ERROR_CODES];
