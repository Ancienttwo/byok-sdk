import { createPrivateKey, generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';

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

/** PKCS8 PEM — the on-disk fallback form (0600 file under storeDir; OS keychain is M3). */
export function exportPrivateKeyPem(privateKey: KeyObject): string {
  return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
}

export function importPrivateKeyPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

/** Sign `nonce` (UTF-8) with the device private key; returns the raw 64-byte signature, base64url-encoded (protocol §6.2). */
export function signNonce(privateKey: KeyObject, nonce: string): string {
  const signature = edSign(null, Buffer.from(nonce, 'utf8'), privateKey);
  return signature.toString('base64url');
}
