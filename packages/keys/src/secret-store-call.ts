import { BYOK_KEYS_ERROR_CODES, ByokKeysError, type ByokKeysErrorCode } from './errors.js';

/**
 * What the failing entry holds. The fixed guidance names the recovery that
 * works for it: a provider key is repaired by supplying the key again, the
 * device sealing key only by deleting the entry so the device generates and
 * registers a new one.
 */
export type SecretStoreSubject = 'provider' | 'device_sealing_key';

/** Fixed, credential-free guidance for the store codes an operator can act on. */
const SECRET_STORE_GUIDANCE: Record<SecretStoreSubject, Partial<Record<ByokKeysErrorCode, string>>> = {
  provider: {
    KEYCHAIN_SECRET_CORRUPTED: 'The OS keychain entry for this provider cannot be decoded; supply a new key to replace it',
    KEYCHAIN_SECRET_DECODE_FAILED: "The OS keychain holds an entry with this provider key's name that the SDK did not write; delete or rename it, or use another profile",
    CREDENTIAL_MANAGER_READ_FAILED: 'Windows Credential Manager could not read this secret; if the entry is damaged, delete it in Credential Manager and supply the key again',
  },
  device_sealing_key: {
    KEYCHAIN_SECRET_CORRUPTED: 'The OS keychain entry for the device sealing key cannot be decoded; delete it so the device generates a new key, then register that key again',
    KEYCHAIN_SECRET_DECODE_FAILED: "The OS keychain holds an entry with the device sealing key's name that the SDK did not write; delete or rename it so the device generates a new key, then register that key again",
    CREDENTIAL_MANAGER_READ_FAILED: 'Windows Credential Manager could not read the device sealing key; if the entry is damaged, delete it in Credential Manager so the device generates a new key, then register that key again',
  },
};

const KEYCHAIN_UNAVAILABLE_GUIDANCE = 'The OS keychain is unavailable; on Linux, install secret-tool and unlock a keyring on the session D-Bus';

/**
 * The credential-free form of an injected secret store's error: a store may
 * echo a key in its message, its cause, or an error it builds itself. A known
 * keychain, Credential Manager or secret-shape code keeps its code with a fixed
 * message (guidance where an operator can act, such as installing secret-tool);
 * anything else becomes `PROVIDER_SECRET_STORE_FAILED`.
 */
export function sanitizeSecretStoreError(error: unknown, subject: SecretStoreSubject = 'provider'): ByokKeysError {
  const code = error instanceof ByokKeysError ? error.code : '';
  if (isSecretStoreErrorCode(code) && code !== 'PROVIDER_SECRET_STORE_FAILED') {
    const guidance = code === 'KEYCHAIN_UNAVAILABLE' ? KEYCHAIN_UNAVAILABLE_GUIDANCE : SECRET_STORE_GUIDANCE[subject][code as ByokKeysErrorCode];
    return new ByokKeysError(code, guidance ?? 'Credential store operation failed');
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
export async function secretStoreCall<T>(call: () => Promise<T>, subject: SecretStoreSubject = 'provider'): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw sanitizeSecretStoreError(error, subject);
  }
}
