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
 * The literal is byte-identical to `@byok/server`'s `NONCE_SIGNING_DOMAIN`
 * and to what the daemon signs (`packages/client/src/daemon/device-keys.ts`),
 * because the daemon must not be able to tell self-hosted from hosted. Parity
 * is asserted by behavior tests, never by importing the server.
 */
import type { CloudCrypto } from '../crypto/port';

export const NONCE_SIGNING_DOMAIN = 'byok-nonce-v1\n';

export function verifyNonceSignature(
  crypto: CloudCrypto,
  devicePublicKey: string,
  nonce: string,
  signature: string,
): Promise<boolean> {
  return crypto.verifyEd25519(devicePublicKey, NONCE_SIGNING_DOMAIN + nonce, signature);
}
