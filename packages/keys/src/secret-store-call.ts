import { BYOK_KEYS_ERROR_CODES, ByokKeysError, type ByokKeysErrorCode } from './errors.js';

/**
 * What the failing entry holds. The fixed guidance names the recovery that
 * works for it: a provider key is repaired by supplying the key again, the
 * device sealing key only by deleting the entry so the device generates and
 * registers a new one.
 */
export type SecretStoreSubject = 'provider' | 'device_sealing_key';

/**
 * What replacing the device sealing key does to provisioning: requests sealed
 * to the old key and not yet applied end as `sealing_key_rotated`.
 */
const DEVICE_KEY_REPLACED = '. Unfinished provisioning requests sealed to the old key can no longer be opened and must be submitted again to the new key; completed results stay readable from their receipts, and stored provider keys are unaffected';

/** Fixed, credential-free guidance for the store codes an operator can act on. */
const SECRET_STORE_GUIDANCE: Record<SecretStoreSubject, Partial<Record<ByokKeysErrorCode, string>>> = {
  provider: {
    KEYCHAIN_SECRET_CORRUPTED: 'The OS keychain entry for this provider cannot be decoded; supply a new key to replace it',
    KEYCHAIN_SECRET_DECODE_FAILED: "The OS keychain holds an entry with this provider key's name that the SDK did not write; delete or rename it, or use another profile",
    CREDENTIAL_MANAGER_READ_FAILED: 'Windows Credential Manager could not read this secret; if the entry is damaged, delete it in Credential Manager and supply the key again',
  },
  device_sealing_key: {
    KEYCHAIN_SECRET_CORRUPTED: `The OS keychain entry for the device sealing key cannot be decoded; delete it so the device generates a new key, then register that key again${DEVICE_KEY_REPLACED}`,
    KEYCHAIN_SECRET_DECODE_FAILED: `The OS keychain holds an entry with the device sealing key's name that the SDK did not write; delete or rename it so the device generates a new key, then register that key again${DEVICE_KEY_REPLACED}`,
    CREDENTIAL_MANAGER_READ_FAILED: `Windows Credential Manager could not read the device sealing key; if the entry is damaged, delete it in Credential Manager so the device generates a new key, then register that key again${DEVICE_KEY_REPLACED}`,
  },
};

const STORE_FAILED_MESSAGE: Record<SecretStoreSubject, string> = {
  provider: 'Provider credential store operation failed',
  device_sealing_key: 'Device sealing key credential store operation failed',
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
  // Classifying reads the store's object, which may itself throw (a `code`
  // getter, for one); any such failure falls back to the fixed generic error.
  try {
    const code = error instanceof ByokKeysError ? error.code : '';
    if (isSecretStoreErrorCode(code) && code !== 'PROVIDER_SECRET_STORE_FAILED') {
      const guidance = code === 'KEYCHAIN_UNAVAILABLE' ? KEYCHAIN_UNAVAILABLE_GUIDANCE : SECRET_STORE_GUIDANCE[subject][code as ByokKeysErrorCode];
      return new ByokKeysError(code, guidance ?? 'Credential store operation failed');
    }
  } catch {
    // Fall through to the generic error.
  }
  return new ByokKeysError('PROVIDER_SECRET_STORE_FAILED', STORE_FAILED_MESSAGE[subject]);
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
