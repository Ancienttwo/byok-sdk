/**
 * The reference {@link CloudCrypto}, built entirely on the WebCrypto API that
 * Node >=20, Cloudflare Workers, and Deno all expose as `globalThis.crypto`.
 *
 * No `node:crypto`, no dependency: the point of the port is that a hosted
 * composition stays runtime-neutral, and an adapter that reached for a Node
 * built-in here would make that claim false for the default composition.
 */
import type { CloudCrypto } from './port';

/** Short, human-typeable pairing code alphabet — no `0/O`, no `1/I` (mirrors the reference server's). */
const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const HEX_DIGITS = '0123456789abcdef';

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Decode base64url. Returns `undefined` rather than throwing for input that
 * is not base64url at all — every caller here is verifying attacker-supplied
 * material, where "not decodable" and "does not verify" must be the same
 * answer.
 */
export function base64UrlDecode(value: string): Uint8Array | undefined {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += HEX_DIGITS[(byte >> 4) & 0xf];
    out += HEX_DIGITS[byte & 0xf];
  }
  return out;
}

/**
 * WebCrypto's own types are derived from the runtime's `globalThis.crypto`
 * rather than named directly: `CryptoKey`/`SubtleCrypto`/`KeyUsage` are DOM
 * lib globals, and this package compiles without the DOM lib (a Workers build
 * has no DOM either). Deriving keeps the types exact without pulling in a
 * `node:` import or widening `lib`.
 */
export type SubtleCryptoLike = typeof globalThis.crypto.subtle;
export type CryptoKeyLike = Awaited<ReturnType<SubtleCryptoLike['importKey']>>;
export type KeyUsageLike = Parameters<SubtleCryptoLike['importKey']>[4][number];

function subtle(): SubtleCryptoLike {
  const webCrypto = globalThis.crypto;
  if (webCrypto?.subtle === undefined) {
    throw new Error('@byok-sdk/cloud requires a WebCrypto implementation on globalThis.crypto');
  }
  return webCrypto.subtle;
}

export function createWebCrypto(): CloudCrypto {
  return {
    randomUuid(): string {
      return globalThis.crypto.randomUUID();
    },

    randomToken(byteLength: number): string {
      return base64UrlEncode(globalThis.crypto.getRandomValues(new Uint8Array(byteLength)));
    },

    randomPairingCode(length: number): string {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length));
      let out = '';
      for (const byte of bytes) {
        out += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length];
      }
      return out;
    },

    async verifyEd25519(
      publicKeyBase64Url: string,
      message: string | Uint8Array,
      signature: string,
    ): Promise<boolean> {
      const signatureBytes = base64UrlDecode(signature);
      if (signatureBytes === undefined) return false;
      try {
        const key = await subtle().importKey(
          'jwk',
          { kty: 'OKP', crv: 'Ed25519', x: publicKeyBase64Url },
          { name: 'Ed25519' },
          false,
          ['verify'],
        );
        const messageBytes = typeof message === 'string' ? new TextEncoder().encode(message) : message;
        return await subtle().verify({ name: 'Ed25519' }, key, signatureBytes, messageBytes);
      } catch {
        // A key that will not import is a key that cannot have signed this —
        // same answer as a bad signature, with no distinguishing error.
        return false;
      }
    },

    async hmacSha256(secret: Uint8Array, message: string): Promise<string> {
      const key = await subtle().importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const signature = await subtle().sign('HMAC', key, new TextEncoder().encode(message));
      return base64UrlEncode(new Uint8Array(signature));
    },

    async sha256(data: Uint8Array): Promise<string> {
      const digest = await subtle().digest('SHA-256', data);
      return `sha256:${toHex(new Uint8Array(digest))}`;
    },

    timingSafeEqual(left: string, right: string): boolean {
      const leftBytes = base64UrlDecode(left);
      const rightBytes = base64UrlDecode(right);
      if (leftBytes === undefined || rightBytes === undefined) return false;
      if (leftBytes.length !== rightBytes.length) return false;
      let diff = 0;
      for (let index = 0; index < leftBytes.length; index += 1) {
        diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
      }
      return diff === 0;
    },
  };
}
