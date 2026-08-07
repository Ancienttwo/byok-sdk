/**
 * The crypto seam.
 *
 * `@byok/server` reaches straight for `node:crypto`. Cloud cannot: a hosted
 * composition has to load on Workers and Deno too, and `src/__tests__/
 * constraints.test.ts` asserts this package never imports a `node:` module.
 * So every primitive the device surface needs — random identifiers, Ed25519
 * verification of a challenge signature, HMAC for presigned blob URLs,
 * SHA-256 for content addressing — arrives through this port.
 *
 * `web-crypto.ts` in this directory is the reference implementation, built on
 * the WebCrypto API that Node >=20, Workers, and Deno all expose as
 * `globalThis.crypto`. A composition backed by a KMS or an HSM supplies its
 * own instead.
 */

export interface CloudCrypto {
  /** A fresh UUID v4 — envelope ids, device ids, blob ids, task ids. */
  randomUuid(): string;
  /** `byteLength` random bytes, base64url-encoded — nonces and opaque tokens. */
  randomToken(byteLength: number): string;
  /** A short, human-typeable pairing code (uppercase, unambiguous alphabet). */
  randomPairingCode(length: number): string;
  /**
   * Verify `signature` (base64url) over `message` (UTF-8) against
   * `publicKeyBase64Url` — a raw 32-byte Ed25519 public key in the same
   * base64url encoding a JWK's `x` field uses, which is what a device
   * registers at pairing time.
   *
   * Never throws: a malformed key or signature is a failed verification, not
   * an exception a route has to translate.
   */
  verifyEd25519(publicKeyBase64Url: string, message: string, signature: string): Promise<boolean>;
  /** HMAC-SHA-256 over `message`, base64url-encoded. Used for presigned blob URLs. */
  hmacSha256(secret: Uint8Array, message: string): Promise<string>;
  /** SHA-256 of `data`, in core's canonical `sha256:<64 lowercase hex>` form. */
  sha256(data: Uint8Array): Promise<string>;
  /**
   * Length-independent equality for two base64url strings. Signature
   * comparison must not leak a prefix through timing.
   */
  timingSafeEqual(left: string, right: string): boolean;
}
