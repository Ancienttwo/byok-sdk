/**
 * A simulated device's identity key (docs/protocol.md §6.1).
 *
 * Ed25519 through WebCrypto rather than `node:crypto`, for the same reason
 * `@byok-sdk/core` holds no `node:` import: a simulator that only runs on Node
 * cannot smoke-test a Workers deployment from inside a Worker. Node ≥22.19
 * (this workspace's floor) exposes Ed25519 on `globalThis.crypto.subtle`, so
 * there is no polyfill seam and no second code path.
 *
 * The public key crosses the wire as the JWK `x` member: RFC 8037 defines it as
 * the raw 32-byte key, base64url with no padding (43 characters), which is
 * exactly the encoding `PairRequest.devicePublicKey` is specified in and the
 * form both the reference server and the hosted surface hand to their verifier
 * without an ASN.1/SPKI unwrap. Signatures are the raw 64-byte Ed25519
 * signature, base64url.
 */
import { nonceSigningBytes } from '@byok-sdk/core';

/** Length of a base64url-encoded raw 32-byte Ed25519 public key, unpadded. */
export const DEVICE_PUBLIC_KEY_LENGTH = 43;

export interface DeviceIdentity {
  /** JWK `x` — raw 32-byte Ed25519 public key, base64url, 43 characters. */
  readonly publicKeyBase64Url: string;
  /** Raw 64-byte Ed25519 signature over `message`, base64url. */
  sign(message: Uint8Array): Promise<string>;
  /**
   * Signature over the domain-separated challenge bytes — core's
   * {@link nonceSigningBytes}, never a local re-spelling of the domain. This is
   * the only signing shape any real device produces.
   */
  signNonce(nonce: string): Promise<string>;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Generate a fresh device keypair. The private key stays a non-extractable
 * `CryptoKey` inside this object — a simulator has no reason to hand one out,
 * and a test that cannot leak a key cannot accidentally assert on one.
 */
export async function createDeviceIdentity(): Promise<DeviceIdentity> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    throw new Error(
      '@byok-sdk/testkit needs WebCrypto: globalThis.crypto.subtle is unavailable in this runtime (Node >=22.19 or a Worker provides it).',
    );
  }

  const generated = await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  // `generateKey` is typed as "a key or a key pair" because the algorithm decides
  // which; Ed25519 is asymmetric, so narrow rather than assert.
  if (!('privateKey' in generated)) {
    throw new Error('WebCrypto returned a single key for Ed25519, expected a keypair');
  }

  const jwk = await subtle.exportKey('jwk', generated.publicKey);
  const x = jwk.x;
  if (typeof x !== 'string' || x.length !== DEVICE_PUBLIC_KEY_LENGTH) {
    throw new Error(
      `Ed25519 public key JWK 'x' must be ${DEVICE_PUBLIC_KEY_LENGTH} base64url characters, got ${String(x)}`,
    );
  }

  const sign = async (message: Uint8Array): Promise<string> => {
    // `BufferSource` in the DOM lib is `ArrayBufferView<ArrayBuffer>`; a
    // Uint8Array over a SharedArrayBuffer is not one, so hand `subtle` the
    // backing bytes explicitly rather than widening the parameter type.
    const signature = await subtle.sign(
      { name: 'Ed25519' },
      generated.privateKey,
      message.slice().buffer as ArrayBuffer,
    );
    return base64url(new Uint8Array(signature));
  };

  return {
    publicKeyBase64Url: x,
    sign,
    signNonce: (nonce) => sign(nonceSigningBytes(nonce)),
  };
}
