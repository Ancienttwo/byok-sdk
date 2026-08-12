import { createPrivateKey, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import { nonceSigningBytes } from '@byok-sdk/core';

/**
 * Device identity keypair (protocol §6): Ed25519, generated once on first
 * pair and reused across re-pairs (§6.3 — "a fresh device keypair is not
 * required" when re-pairing after revocation). The private key never
 * leaves this device; only the public key ever goes over the wire
 * (`PairRequest.devicePublicKey`).
 *
 * Encoding choice: an OKP (Ed25519) key's JWK `x` member is defined by
 * RFC 8037 as the raw 32-byte public key, base64url-encoded with no
 * padding — exactly "Ed25519 public key, base64url-encoded" per
 * docs/protocol.md §6.1, and avoids shipping an ASN.1/SPKI wrapper the
 * server would otherwise have to strip. Signatures are the raw 64-byte
 * Ed25519 signature (`crypto.sign(null, data, privateKey)` — Ed25519 needs
 * no digest algorithm), also base64url-encoded.
 */
export interface DeviceKeyPair {
  publicKeyBase64Url: string;
  privateKey: KeyObject;
}

export function generateDeviceKeyPair(): DeviceKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKeyBase64Url: publicKeyToBase64Url(publicKey), privateKey };
}

function publicKeyToBase64Url(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: 'jwk' }) as { x?: string };
  if (!jwk.x) throw new Error('failed to export Ed25519 public key as JWK');
  return jwk.x;
}

/** PKCS8 PEM — the on-disk storage form (0600 file under storeDir). OS keychain integration is deferred (tracked as a future roadmap item, not promised for any specific milestone). */
export function exportPrivateKeyPem(privateKey: KeyObject): string {
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
}

export function importPrivateKeyPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

/**
 * S1 (GAP-004): the domain-separation prefix this device signs along with a
 * challenge nonce. The device key is a long-lived identity key that later
 * planes will also sign structured messages with; tagging the domain is what
 * stops a signature made for one of those from being replayable as a
 * token-renewal credential.
 *
 * The literal itself now lives in `@byok-sdk/core` (`src/pairing.ts`), which
 * the daemon, the hosted surface, and the reference server all already depend
 * on. It used to be three copies, each commented as byte-identical to the
 * others — an agreement that holds only until someone edits one of them.
 * Re-exported here so this module's public surface is unchanged.
 */
export { NONCE_SIGNING_DOMAIN } from '@byok-sdk/core';

/**
 * Sign a challenge nonce with the device private key: the signed message is
 * `NONCE_SIGNING_DOMAIN` followed by `nonce` (UTF-8) — core's
 * {@link nonceSigningBytes} produces those bytes — and the result is the raw
 * 64-byte Ed25519 signature, base64url-encoded (protocol §6.2). A server on the
 * domain-separated contract rejects the undomained form, so there is no variant
 * of this that omits the prefix.
 */
export function signNonce(privateKey: KeyObject, nonce: string): string {
  const signature = edSign(null, nonceSigningBytes(nonce), privateKey);
  return signature.toString('base64url');
}
