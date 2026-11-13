import { BYOK_KEYS_ERROR_CODES, ByokKeysError, type ByokKeysErrorCode } from './errors.js';

/** Fixed, credential-free guidance for the store codes an operator can act on. */
const SECRET_STORE_GUIDANCE: Partial<Record<ByokKeysErrorCode, string>> = {
  KEYCHAIN_SECRET_CORRUPTED: 'The OS keychain entry for this provider cannot be decoded; supply a new key to replace it',
  KEYCHAIN_SECRET_DECODE_FAILED: "The OS keychain holds an entry with this provider key's name that the SDK did not write; delete or rename it, or use another profile",
  KEYCHAIN_UNAVAILABLE: 'The OS keychain is unavailable; on Linux, install secret-tool and unlock a keyring on the session D-Bus',
  CREDENTIAL_MANAGER_READ_FAILED: 'Windows Credential Manager could not read this secret; if the entry is damaged, delete it in Credential Manager and supply the key again',
};

/**
 * The credential-free form of an injected secret store's error: a store may
 * echo a key in its message, its cause, or an error it builds itself. A known
 * keychain, Credential Manager or secret-shape code keeps its code with a fixed
 * message (guidance where an operator can act, such as installing secret-tool);
 * anything else becomes `PROVIDER_SECRET_STORE_FAILED`.
 */
export function sanitizeSecretStoreError(error: unknown): ByokKeysError {
  const code = error instanceof ByokKeysError ? error.code : '';
  if (isSecretStoreErrorCode(code) && code !== 'PROVIDER_SECRET_STORE_FAILED') {
    return new ByokKeysError(code, SECRET_STORE_GUIDANCE[code as ByokKeysErrorCode] ?? 'Credential store operation failed');
  }
  return new ByokKeysError('PROVIDER_SECRET_STORE_FAILED', 'Provider credential store operation failed');
}

/** Whether `code` is one the boundary can produce. */
export function isSecretStoreErrorCode(code: string): boolean {
  return code === 'PROVIDER_SECRET_STORE_FAILED'
    || (Object.hasOwn(BYOK_KEYS_ERROR_CODES, code) && /^(?:KEYCHAIN|CREDENTIAL_MANAGER|SECRET)_/u.test(code));
}

/**
 * Call an injected secret store with {@link sanitizeSecretStoreError} as the
 * only way its error leaves. Every SDK call on an injected store goes through
 * here, so none can pass on a key the store put in its error.
 */
export async function secretStoreCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw sanitizeSecretStoreError(error);
  }
}
