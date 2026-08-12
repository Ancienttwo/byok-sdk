/**
 * The identity half, provable without a deployment.
 *
 * Everything that needs a live surface — the five primitives and the four
 * negative assertions — is proven in `@byok-sdk/conformance`'s
 * `pairing-simulator` suite against the real in-memory cloud composition. What
 * is left here is what a simulator can get wrong on its own: the public key
 * encoding a host copies onto the wire, and the guarantee that a nonce
 * signature is made over core's bytes rather than a local re-spelling of the
 * domain.
 */
import { NONCE_SIGNING_DOMAIN, nonceSigningBytes } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { DEVICE_PUBLIC_KEY_LENGTH, createDeviceIdentity } from '../identity';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '=')), (char) =>
    char.charCodeAt(0),
  );
}

describe('device identity', () => {
  it('exports the public key as an RFC 8037 JWK x member', async () => {
    const identity = await createDeviceIdentity();
    expect(identity.publicKeyBase64Url).toHaveLength(DEVICE_PUBLIC_KEY_LENGTH);
    expect(identity.publicKeyBase64Url).toMatch(BASE64URL);
    // 43 base64url characters is exactly the raw 32-byte Ed25519 key, unpadded.
    expect(decodeBase64Url(identity.publicKeyBase64Url)).toHaveLength(32);
  });

  it('mints a distinct keypair per call', async () => {
    const [first, second] = await Promise.all([createDeviceIdentity(), createDeviceIdentity()]);
    expect(first.publicKeyBase64Url).not.toBe(second.publicKeyBase64Url);
  });

  it('produces raw 64-byte Ed25519 signatures, base64url', async () => {
    const identity = await createDeviceIdentity();
    const signature = await identity.signNonce('n0nce');
    expect(signature).toMatch(BASE64URL);
    expect(decodeBase64Url(signature)).toHaveLength(64);
  });

  it('signs a nonce over core bytes, verifiably — not over the bare nonce', async () => {
    const identity = await createDeviceIdentity();
    const nonce = 'a-nonce';
    const key = await globalThis.crypto.subtle.importKey(
      'jwk',
      { kty: 'OKP', crv: 'Ed25519', x: identity.publicKeyBase64Url },
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    const verify = async (signature: string, message: Uint8Array): Promise<boolean> =>
      globalThis.crypto.subtle.verify(
        { name: 'Ed25519' },
        key,
        decodeBase64Url(signature).slice().buffer as ArrayBuffer,
        message.slice().buffer as ArrayBuffer,
      );

    const domained = await identity.signNonce(nonce);
    expect(await verify(domained, nonceSigningBytes(nonce))).toBe(true);
    // The same signature must NOT verify over the undomained bytes — that is
    // the whole content of the domain separation the negative assertion probes.
    expect(await verify(domained, new TextEncoder().encode(nonce))).toBe(false);
    expect(nonceSigningBytes(nonce)).toEqual(new TextEncoder().encode(NONCE_SIGNING_DOMAIN + nonce));
  });
});
