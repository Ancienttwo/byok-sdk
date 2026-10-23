/**
 * Byte helpers shared by the sealed-payload modules (#654 E1a).
 *
 * Every function is WebCrypto-only and `node:`-free, so a browser, Workers,
 * Node and Bun run the same code. The subpath `@byok-sdk/core/sealed-payload`
 * exports the sealed-payload interface, but not these helpers. The package
 * root exports none of the sealed-payload modules.
 *
 * Caller input errors throw `sealed_secret_invalid`, the code `hpke.ts`
 * already raises for bad HPKE input. Receiver checks never throw for hostile
 * bytes; they return a typed failure.
 */
import { z } from 'zod';

import { ByokCoreError } from '../errors';
import {
  SealingPublicJwkSchema,
  decodeBase64Url,
  encodeBase64Url,
  sealingPublicKeyBytes,
  type SealingPublicJwk,
} from '../sealed-provider-secret';
import { webCryptoSubtle, type WebCryptoKey } from '../webcrypto';

export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * The strict EC P-256 public JWK core already uses for sealing keys. Member
 * signing keys and member KEM keys use the same shape.
 */
export type P256PublicJwk = SealingPublicJwk;
export const P256PublicJwkSchema = SealingPublicJwkSchema;

/** Raw P1363 (`r || s`) ECDSA P-256 signature length. */
const ECDSA_P256_SIGNATURE_BYTES = 64;

export function invalidInput(message: string): ByokCoreError {
  return new ByokCoreError('sealed_secret_invalid', message);
}

export function utf8(value: string): Bytes {
  return new TextEncoder().encode(value) as Bytes;
}

export function copy(bytes: Uint8Array): Bytes {
  return new Uint8Array(bytes) as Bytes;
}

export function concat(...parts: readonly Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out as Bytes;
}

export function hex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export { decodeBase64Url, encodeBase64Url };

/** Fresh CSPRNG bytes from `globalThis.crypto`, the same source WebCrypto keys come from. */
export function randomBytes(length: number): Bytes {
  const source = (globalThis as { crypto?: { getRandomValues?: <T extends Uint8Array>(array: T) => T } }).crypto;
  if (source?.getRandomValues === undefined) {
    throw new ByokCoreError('webcrypto_unavailable', 'WebCrypto getRandomValues is unavailable in this runtime');
  }
  return source.getRandomValues(new Uint8Array(length)) as Bytes;
}

export async function sha256(bytes: Uint8Array): Promise<Bytes> {
  return new Uint8Array(await webCryptoSubtle().digest('SHA-256', copy(bytes))) as Bytes;
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Bytes> {
  const subtle = webCryptoSubtle();
  const hmacKey = await subtle.importKey('raw', copy(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', hmacKey, copy(data))) as Bytes;
}

/** RFC 5869 HKDF-SHA-256 through WebCrypto's own HKDF. */
export async function hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Promise<Bytes> {
  const subtle = webCryptoSubtle();
  const key = await subtle.importKey('raw', copy(ikm), { name: 'HKDF' }, false, ['deriveBits']);
  const bits = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: copy(salt), info: utf8(info) }, key, length * 8);
  return new Uint8Array(bits) as Bytes;
}

/** A zod string that must be canonical unpadded base64url of exactly `bytes` bytes. */
export function base64UrlBytes(bytes: number) {
  return z.string().refine((value) => {
    try {
      return decodeBase64Url(value, 'field').byteLength === bytes;
    } catch {
      return false;
    }
  }, `must be canonical unpadded base64url of ${bytes} bytes`);
}

/**
 * ECDSA `sign` with an algorithm object, and `verify`. Core's public
 * `WebCryptoSubtle` interface declares neither, and widening it would change
 * the published API, so this module types the same runtime object locally.
 */
interface EcdsaSubtle {
  importKey(format: 'jwk', keyData: object, algorithm: object, extractable: boolean, usages: string[]): Promise<WebCryptoKey>;
  sign(algorithm: object, key: WebCryptoKey, data: Bytes): Promise<ArrayBuffer>;
  verify(algorithm: object, key: WebCryptoKey, signature: Bytes, data: Bytes): Promise<boolean>;
}

const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const;

function ecdsaSubtle(): EcdsaSubtle {
  return webCryptoSubtle() as unknown as EcdsaSubtle;
}

/** Uncompressed SEC1 bytes of a strict P-256 public JWK, checked to be a point on the curve. */
export async function p256PublicKeyBytes(publicJwk: P256PublicJwk): Promise<Bytes> {
  const raw = sealingPublicKeyBytes(publicJwk);
  await importEcdsaPublicKey(publicJwk);
  return raw;
}

async function importEcdsaPublicKey(publicJwk: P256PublicJwk): Promise<WebCryptoKey> {
  const jwk = P256PublicJwkSchema.parse(publicJwk);
  try {
    return await ecdsaSubtle().importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, ECDSA_P256, true, ['verify']);
  } catch (cause) {
    throw new ByokCoreError('sealed_secret_invalid', 'P-256 public key is not a valid curve point', { cause });
  }
}

/**
 * ECDSA P-256 / SHA-256 signature over `data`, as base64url of the 64-byte
 * P1363 form. The signature must verify under `publicJwk`, so a private key
 * that does not pair with the caller's public key throws
 * `sealed_secret_invalid` and signs nothing under another key's id.
 */
export async function ecdsaSign(publicJwk: P256PublicJwk, privateKey: WebCryptoKey, data: Uint8Array): Promise<string> {
  let signature: string;
  try {
    signature = encodeBase64Url(new Uint8Array(await ecdsaSubtle().sign(ECDSA_SHA256, privateKey, copy(data))));
  } catch (cause) {
    throw new ByokCoreError('sealed_secret_invalid', 'Signing key is not an ECDSA P-256 private key', { cause });
  }
  if (!(await ecdsaVerify(publicJwk, signature, data))) {
    throw invalidInput('Signing private key does not pair with the signing public key');
  }
  return signature;
}

/** True only for a canonical 64-byte P1363 signature that verifies under `publicJwk`. */
export async function ecdsaVerify(publicJwk: P256PublicJwk, signature: string, data: Uint8Array): Promise<boolean> {
  let signatureBytes: Bytes;
  try {
    signatureBytes = decodeBase64Url(signature, 'sig');
  } catch {
    return false;
  }
  if (signatureBytes.byteLength !== ECDSA_P256_SIGNATURE_BYTES) return false;
  const key = await importEcdsaPublicKey(publicJwk);
  return ecdsaSubtle().verify(ECDSA_SHA256, key, signatureBytes, copy(data));
}
