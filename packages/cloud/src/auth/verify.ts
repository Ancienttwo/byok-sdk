/**
 * The one nonce-signature check on the hosted surface (docs/protocol.md §6.2).
 *
 * S1 (GAP-004): a device signs `byok-nonce-v1\n` + nonce, never the bare
 * nonce. The device key is a long-lived identity key that later planes (S6
 * device proof) also sign structured messages with; without a domain tag, a
 * signature produced for one purpose is a valid signature for another.
 *
 * Applying the domain HERE rather than at the call site is the point: there
 * is exactly one place that decides what a device signature over a nonce
 * means, so no route can be written that accepts the undomained form. There
 * is deliberately no dual mode and no grace window — a device on the old
 * encoding re-pairs.
 *
 * The domain literal itself lives in `@byok-sdk/core` (`src/pairing.ts`): the
 * daemon must not be able to tell self-hosted from hosted, and three copies
 * each commented as byte-identical to the other two were a drift hazard, not a
 * design. Importing the constant from the package all three ends already depend
 * on is not the same as importing the server — parity of *behavior* is still
 * asserted by behavior tests, and this package still has no `@byok-sdk/server`
 * edge. Re-exported so this module's public surface is unchanged.
 */
import { NONCE_SIGNING_DOMAIN } from '@byok-sdk/core';
import type { CloudCrypto } from '../crypto/port';

export { NONCE_SIGNING_DOMAIN } from '@byok-sdk/core';

export function verifyNonceSignature(
  crypto: CloudCrypto,
  devicePublicKey: string,
  nonce: string,
  signature: string,
): Promise<boolean> {
  // `CloudCrypto.verifyEd25519` takes the message as a string and encodes it as
  // UTF-8 itself, so the concatenation happens here rather than through core's
  // `nonceSigningBytes` — same bytes, one encoding step instead of two.
  return crypto.verifyEd25519(devicePublicKey, NONCE_SIGNING_DOMAIN + nonce, signature);
}
