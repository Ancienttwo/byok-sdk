/**
 * Runtime-neutral HPKE conformance checks, shared by the vitest suites (Node)
 * and `hpke-bun-probe.ts` (Bun). Every check throws on the first mismatch so a
 * caller can only report success after all of them ran.
 *
 * Oracles:
 * 1. RFC 9180 Appendix A.3.1 (base mode, P-256/SHA-256/AES-128-GCM) test
 *    vectors, transcribed into `../fixtures/rfc9180-a3-1-base.json`.
 * 2. `@hpke/core` — an independent HPKE implementation, a test-only
 *    devDependency — in both directions.
 */
import { Aes128Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';

import type { WebCryptoKey } from '../../webcrypto';
import vectors from '../fixtures/rfc9180-a3-1-base.json';
import {
  hpkeAeadOpen,
  hpkeAeadSeal,
  hpkeNonce,
  hpkeOpenBase,
  hpkeSealBase,
  setupBaseRecipient,
  setupBaseSender,
} from '../../hpke';
import { encodeBase64Url } from '../../sealed-provider-secret';

export function fromHex(value: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(value.length / 2);
  for (let index = 0; index < out.length; index += 1) out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function assertHex(label: string, actual: Uint8Array, expected: string): void {
  if (toHex(actual) !== expected) throw new Error(`${label} mismatch: ${toHex(actual)} != ${expected}`);
}

/** Import a raw P-256 scalar + its uncompressed public point as a WebCrypto ECDH private key. */
export async function importP256PrivateKey(skHex: string, pkHex: string, extractable = false): Promise<WebCryptoKey> {
  const pk = fromHex(pkHex);
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: encodeBase64Url(fromHex(skHex)),
      x: encodeBase64Url(pk.subarray(1, 33)),
      y: encodeBase64Url(pk.subarray(33, 65)),
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    extractable,
    ['deriveBits'],
  );
}

/** Runs every A.3.1 base-mode check; returns the number of encryptions verified. */
export async function runRfc9180A31Conformance(): Promise<number> {
  if (vectors.mode !== 0 || vectors.kem_id !== 16 || vectors.kdf_id !== 1 || vectors.aead_id !== 1) {
    throw new Error('fixture is not the A.3.1 base-mode suite');
  }
  const info = fromHex(vectors.info);
  const pkR = fromHex(vectors.pkRm);
  const sender = await setupBaseSender(pkR, info, {
    privateKey: await importP256PrivateKey(vectors.skEm, vectors.pkEm),
    publicKey: fromHex(vectors.pkEm),
  });
  assertHex('enc', sender.enc, vectors.enc);
  assertHex('shared_secret', sender.schedule.sharedSecret, vectors.shared_secret);
  assertHex('key', sender.schedule.key, vectors.key);
  assertHex('base_nonce', sender.schedule.baseNonce, vectors.base_nonce);
  assertHex('exporter_secret', sender.schedule.exporterSecret, vectors.exporter_secret);

  const recipient = await setupBaseRecipient(
    fromHex(vectors.enc),
    await importP256PrivateKey(vectors.skRm, vectors.pkRm),
    pkR,
    info,
  );
  assertHex('recipient shared_secret', recipient.sharedSecret, vectors.shared_secret);
  assertHex('recipient key', recipient.key, vectors.key);
  assertHex('recipient base_nonce', recipient.baseNonce, vectors.base_nonce);

  for (const encryption of vectors.encryptions) {
    assertHex(`nonce ${encryption.sequence}`, hpkeNonce(sender.schedule.baseNonce, encryption.sequence), encryption.nonce);
    const sealed = await hpkeAeadSeal(sender.schedule, encryption.sequence, fromHex(encryption.aad), fromHex(encryption.pt));
    assertHex(`ct ${encryption.sequence}`, sealed, encryption.ct);
    const opened = await hpkeAeadOpen(recipient, encryption.sequence, fromHex(encryption.aad), fromHex(encryption.ct));
    assertHex(`pt ${encryption.sequence}`, opened, encryption.pt);
  }
  return vectors.encryptions.length;
}

function independentSuite(): CipherSuite {
  return new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes128Gcm() });
}

/** Both directions against `@hpke/core`, with fresh keys and non-empty info/aad. */
export async function runIndependentInterop(): Promise<void> {
  const suite = independentSuite();
  const info = new TextEncoder().encode('byok-sdk interop info');
  const aad = new TextEncoder().encode('byok-sdk interop aad');
  const plaintext = new TextEncoder().encode('interop plaintext é中');

  // ours -> theirs
  const theirRecipient = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const theirPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', theirRecipient.publicKey));
  const ours = await hpkeSealBase({ recipientPublicKey: theirPublicRaw, info, aad, plaintext });
  const theirOpen = await suite.createRecipientContext({ recipientKey: theirRecipient.privateKey, enc: new Uint8Array(ours.enc).buffer, info: info.buffer });
  const theirPlain = new Uint8Array(await theirOpen.open(new Uint8Array(ours.ciphertext).buffer, aad.buffer));
  if (toHex(theirPlain) !== toHex(plaintext)) throw new Error('independent implementation could not open our ciphertext');

  // theirs -> ours
  const ourRecipient = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const ourPublicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ourRecipient.publicKey));
  const sender = await suite.createSenderContext({ recipientPublicKey: ourRecipient.publicKey, info: info.buffer });
  const theirCiphertext = new Uint8Array(await sender.seal(plaintext.buffer, aad.buffer));
  const ourPlain = await hpkeOpenBase({
    recipientPrivateKey: ourRecipient.privateKey,
    recipientPublicKey: ourPublicRaw,
    enc: new Uint8Array(sender.enc),
    info,
    aad,
    ciphertext: theirCiphertext,
  });
  if (toHex(ourPlain) !== toHex(plaintext)) throw new Error('we could not open the independent implementation ciphertext');
}
