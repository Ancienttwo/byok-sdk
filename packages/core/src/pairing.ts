/**
 * Nonce-signing domain separation for device token renewal (docs/protocol.md §6.2).
 *
 * S1 (GAP-004) put a domain tag in front of every challenge nonce a device
 * signs: the device key is a long-lived identity key that other planes (S6
 * device proof) also sign structured messages with, so without a tag a
 * signature produced for one purpose would be a valid signature for another.
 *
 * The tag started life as three separate literals — one in the daemon, one on
 * the hosted surface, one on the reference server — each with a comment saying
 * it was byte-identical to the others. That is a drift hazard written down, not
 * a design: three copies agree only until someone edits one. This module is the
 * single authority, and it lives in core for the same reason
 * {@link DEVICE_PROOF_DOMAIN_PREFIX} does — core is the one package all three
 * ends already depend on, it is Node-free and Workers-safe, and it holds no
 * crypto of its own. What travels is *bytes to sign*; who signs them, and with
 * which primitive, stays with each end.
 *
 * There is deliberately no dual mode and no grace window: a raw, unprefixed
 * nonce signature is simply invalid, and a device on an older encoding re-pairs.
 */

/**
 * The domain-separation prefix a device signs along with a challenge nonce.
 *
 * Byte-frozen: `62 79 6f 6b 2d 6e 6f 6e 63 65 2d 76 31 0a` (14 bytes, UTF-8).
 * Changing it invalidates every deployed device's token-renewal path, so it is
 * a wire constant, not a tunable.
 */
export const NONCE_SIGNING_DOMAIN = 'byok-nonce-v1\n';

/**
 * The exact bytes a device signs for a challenge nonce, and the exact bytes a
 * verifier reconstructs: {@link NONCE_SIGNING_DOMAIN} followed by `nonce`,
 * UTF-8 encoded.
 *
 * `TextEncoder` is a platform global on Node and Workers alike, which is what
 * lets the one authority sit in a package that imports no `node:` builtin.
 */
export function nonceSigningBytes(nonce: string): Uint8Array {
  return new TextEncoder().encode(NONCE_SIGNING_DOMAIN + nonce);
}
