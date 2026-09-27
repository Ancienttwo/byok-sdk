/**
 * The WebCrypto surface core relies on, declared structurally so core's
 * published types need neither the DOM lib nor Node's types, and resolved
 * from `globalThis.crypto.subtle` so the browser, Node, and Bun share one
 * code path. No `node:crypto`.
 */
import { ByokCoreError } from './errors';

/**
 * A WebCrypto `CryptoKey`, declared structurally so core's published types
 * need neither the DOM lib nor Node's types. Every runtime's native
 * `CryptoKey` satisfies it.
 */
export interface WebCryptoKey {
  readonly type: string;
  readonly extractable: boolean;
  readonly algorithm: object;
  readonly usages: readonly string[];
}

/** The subset of `SubtleCrypto` this package calls, typed loosely on purpose (see {@link WebCryptoKey}). */
export interface WebCryptoSubtle {
  importKey(format: 'raw' | 'jwk', keyData: object, algorithm: object, extractable: boolean, usages: string[]): Promise<WebCryptoKey>;
  exportKey(format: 'raw', key: WebCryptoKey): Promise<ArrayBuffer>;
  generateKey(algorithm: object, extractable: boolean, usages: string[]): Promise<{ publicKey: WebCryptoKey; privateKey: WebCryptoKey }>;
  deriveBits(algorithm: object, baseKey: WebCryptoKey, length: number): Promise<ArrayBuffer>;
  sign(algorithm: string, key: WebCryptoKey, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
  encrypt(algorithm: object, key: WebCryptoKey, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
  decrypt(algorithm: object, key: WebCryptoKey, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
  digest(algorithm: string, data: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer>;
}

/** The WebCrypto subtle interface, or a closed-set failure when the runtime lacks it. */
export function webCryptoSubtle(): WebCryptoSubtle {
  const subtle = (globalThis as { crypto?: { subtle?: WebCryptoSubtle } }).crypto?.subtle;
  if (subtle === undefined) {
    throw new ByokCoreError('webcrypto_unavailable', 'WebCrypto subtle is unavailable in this runtime');
  }
  return subtle;
}
