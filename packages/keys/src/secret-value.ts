/**
 * The secret-shape rule both OS backends share: non-empty, without null or
 * newline characters. It has no Node dependency, so the browser-safe
 * `@byok-sdk/keys/model-route` entry checks a new key with the same rule.
 */
export function isSharedSecretValue(secret: string): boolean {
  return secret.length > 0 && !/[\u0000\r\n]/u.test(secret);
}

/**
 * The smaller of the two OS backends' secret ceilings (Windows Credential
 * Manager: 2560 UTF-8 bytes), so a too-large key is a deterministic rejection
 * on every platform instead of a store failure that leaves a pending marker.
 */
export const PROVIDER_PROVISIONING_SECRET_MAX_BYTES = 2560;
