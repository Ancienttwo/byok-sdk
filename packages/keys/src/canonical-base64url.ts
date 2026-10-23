import { z } from 'zod';

/**
 * Exactly 32 bytes in canonical unpadded base64url, for the stored P-256 JWK
 * coordinates and private scalars of the device sealing key store.
 *
 * The re-encode check rejects a last character whose unused low bits are not
 * zero. WebCrypto reads such a string as the same scalar, so a length and
 * alphabet check alone lets a malformed record pass the fail-closed check.
 * Internal: not exported from the package root.
 */
export const CanonicalBase64Url32 = z.string().refine((value) => {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === value;
}, 'must be 32 bytes in canonical base64url');
