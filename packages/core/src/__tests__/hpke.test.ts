import type { WebCryptoKey } from '../webcrypto';
import { describe, expect, it } from 'vitest';

import {
  hpkeOpenBase,
  hpkeSealBase,
  importP256PublicKey,
  setupBaseSender,
} from '../hpke';
import { SealingPublicJwkSchema, encodeBase64Url } from '../sealed-provider-secret';
import vectors from './fixtures/rfc9180-a3-1-base.json';
import { fromHex, importP256PrivateKey, runIndependentInterop, runRfc9180A31Conformance } from './support/hpke-conformance';

const info = new TextEncoder().encode('info');
const aad = new TextEncoder().encode('aad');
const plaintext = new TextEncoder().encode('plaintext');

async function recipient(): Promise<{ privateKey: WebCryptoKey; publicKey: Uint8Array }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}

describe('RFC 9180 Appendix A.3.1 oracle (DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-128-GCM, base)', () => {
  it('reproduces enc, shared secret, key schedule and every listed encryption', async () => {
    await expect(runRfc9180A31Conformance()).resolves.toBe(6);
  });

  it('opens the vector ciphertext for sequence 0 through the one-shot API', async () => {
    const first = vectors.encryptions[0]!;
    const opened = await hpkeOpenBase({
      recipientPrivateKey: await importP256PrivateKey(vectors.skRm, vectors.pkRm),
      recipientPublicKey: fromHex(vectors.pkRm),
      enc: fromHex(vectors.enc),
      info: fromHex(vectors.info),
      aad: fromHex(first.aad),
      ciphertext: fromHex(first.ct),
    });
    expect(Buffer.from(opened).toString('hex')).toBe(first.pt);
  });
});

describe('independent implementation interop (@hpke/core, test-only)', () => {
  it('opens each other\'s ciphertext in both directions', async () => {
    await expect(runIndependentInterop()).resolves.toBeUndefined();
  });
});

describe('HPKE negative controls', () => {
  it('rejects encapsulations of the wrong length or point format', async () => {
    const r = await recipient();
    const { enc, ciphertext } = await hpkeSealBase({ recipientPublicKey: r.publicKey, info, aad, plaintext });
    for (const bad of [enc.subarray(0, 64), new Uint8Array([...enc, 0]), Uint8Array.of(0x02, ...enc.subarray(1))]) {
      await expect(hpkeOpenBase({ recipientPrivateKey: r.privateKey, recipientPublicKey: r.publicKey, enc: bad, info, aad, ciphertext }))
        .rejects.toMatchObject({ code: 'sealed_secret_invalid' });
    }
  });

  it('rejects a point that is not on P-256', async () => {
    const offCurve = new Uint8Array(65);
    offCurve[0] = 0x04;
    offCurve.fill(1, 1);
    await expect(importP256PublicKey(offCurve)).rejects.toMatchObject({ code: 'sealed_secret_invalid' });
    await expect(hpkeSealBase({ recipientPublicKey: offCurve, info, aad, plaintext }))
      .rejects.toMatchObject({ code: 'sealed_secret_invalid' });
  });

  it('rejects a truncated or corrupted tag, a wrong key, and a different info', async () => {
    const r = await recipient();
    const other = await recipient();
    const { enc, ciphertext } = await hpkeSealBase({ recipientPublicKey: r.publicKey, info, aad, plaintext });
    const open = (overrides: Partial<Parameters<typeof hpkeOpenBase>[0]>) => hpkeOpenBase({
      recipientPrivateKey: r.privateKey, recipientPublicKey: r.publicKey, enc, info, aad, ciphertext, ...overrides,
    });
    await expect(open({})).resolves.toEqual(plaintext);
    await expect(open({ ciphertext: ciphertext.subarray(0, ciphertext.length - 1) })).rejects.toMatchObject({ code: 'sealed_secret_open_failed' });
    await expect(open({ ciphertext: ciphertext.subarray(0, 15) })).rejects.toMatchObject({ code: 'sealed_secret_invalid' });
    const flipped = new Uint8Array(ciphertext);
    flipped[flipped.length - 1]! ^= 1;
    await expect(open({ ciphertext: flipped })).rejects.toMatchObject({ code: 'sealed_secret_open_failed' });
    await expect(open({ aad: new TextEncoder().encode('aae') })).rejects.toMatchObject({ code: 'sealed_secret_open_failed' });
    await expect(open({ info: new TextEncoder().encode('byok-sdk.provider-secret.v2') })).rejects.toMatchObject({ code: 'sealed_secret_open_failed' });
    await expect(open({ recipientPrivateKey: other.privateKey })).rejects.toMatchObject({ code: 'sealed_secret_open_failed' });
  });

  it('rejects a recipient public key of the wrong length', async () => {
    const r = await recipient();
    await expect(setupBaseSender(r.publicKey.subarray(1), info)).rejects.toMatchObject({ code: 'sealed_secret_invalid' });
  });

  it('never reuses an ephemeral key across one-shot seals', async () => {
    const r = await recipient();
    const first = await hpkeSealBase({ recipientPublicKey: r.publicKey, info, aad, plaintext });
    const second = await hpkeSealBase({ recipientPublicKey: r.publicKey, info, aad, plaintext });
    expect(Buffer.from(first.enc).equals(Buffer.from(second.enc))).toBe(false);
    expect(Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext))).toBe(false);
  });
});

describe('sealing public JWK strictness', () => {
  const pk = fromHex(vectors.pkRm);
  const good = { kty: 'EC', crv: 'P-256', x: encodeBase64Url(pk.subarray(1, 33)), y: encodeBase64Url(pk.subarray(33)) };

  it('accepts exactly the four public members', () => {
    expect(SealingPublicJwkSchema.safeParse(good).success).toBe(true);
  });

  it.each([
    ['a private member', { ...good, d: encodeBase64Url(fromHex(vectors.skRm)) }],
    ['an extra alg member', { ...good, alg: 'ECDH-ES' }],
    ['key_ops', { ...good, key_ops: ['deriveBits'] }],
    ['the wrong curve', { ...good, crv: 'P-384' }],
    ['the wrong key type', { ...good, kty: 'OKP' }],
    ['a short x', { ...good, x: good.x.slice(0, 42) }],
    ['padded base64', { ...good, x: `${good.x}=` }],
    ['standard base64 characters', { ...good, y: good.y.replace(/[-_]/gu, '+').replace(/^./u, '+') }],
  ])('rejects %s', (_label, jwk) => {
    expect(SealingPublicJwkSchema.safeParse(jwk).success).toBe(false);
  });
});
