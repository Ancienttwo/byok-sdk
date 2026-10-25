/**
 * Sealed-payload v1 behavior that fixed vectors do not show (#654 E1a):
 * caller input errors, fresh randomness, padding properties, and receivers
 * that return typed failures instead of throwing for hostile input. The byte
 * rules themselves are pinned by `sealed-payload-vectors.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { canonicalizeJsonBytes } from '../attestation';
import { ByokCoreError } from '../errors';
import { hpkeSealBase } from '../hpke';
import {
  deriveMemberId,
  signMemberChainEntry,
  verifyMemberChainEntry,
  type UnsignedMemberChainEntryV1,
} from '../sealed-payload/member-chain';
import { concat, ecdsaSign, encodeBase64Url, p256PublicKeyBytes, utf8, type P256PublicJwk } from '../sealed-payload/primitives';
import {
  SCOPE_KEY_HPKE_INFO,
  SCOPE_KEY_PACKAGE_DOMAIN_PREFIX,
  deriveScopeKeyId,
  deriveSealedContentKey,
  generateScopeKey,
  openScopeKeyPackage,
  sealScopeKeyPackage,
  type ScopeKeyPackageV1,
} from '../sealed-payload/scope-key';
import {
  decodeSealedFrame,
  encodeSealedFrame,
  openSealedContent,
  sealContent,
  sealContentWithRandomness,
  sealedContentAad,
  sealedPaddedLength,
  type SealContentInput,
  type SealedBinding,
} from '../sealed-payload/sealed-content';
import type { WebCryptoKey } from '../webcrypto';

async function p256Pair(use: 'sign' | 'kem'): Promise<{ publicJwk: P256PublicJwk; privateKey: WebCryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: use === 'sign' ? 'ECDSA' : 'ECDH', namedCurve: 'P-256' },
    true,
    use === 'sign' ? ['sign', 'verify'] : ['deriveBits'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! }, privateKey: pair.privateKey };
}

const OFF_CURVE_JWK: P256PublicJwk = { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'A'.repeat(43) };

const BINDING: SealedBinding = {
  tenantId: 'tenant-1',
  family: 'task.offer_for_agent',
  direction: 'server-to-daemon',
  identity: { taskId: 'task-1' },
  deviceId: 'device-1',
  agentRef: null,
  categories: ['task-input', 'task-output'],
  notAfter: null,
};

/** The one family that binds no device: it binds an expiry instead. */
const TEMPLATE_BINDING: SealedBinding = {
  ...BINDING,
  family: 'routine.template',
  identity: { routineId: 'routine-1', definitionVersion: 1 },
  deviceId: null,
  notAfter: '2026-12-31T00:00:00.000Z',
};

const SEALING = { scopeId: 'scope-1', epoch: 1 } as const;

function sealInput(overrides: Partial<SealContentInput> = {}): SealContentInput {
  return {
    scopeKey: new Uint8Array(32).fill(3),
    scope: { id: 'scope-1', epoch: 1 },
    chainHead: { seq: 1, hash: `sha256:${'1'.repeat(64)}` },
    sender: 'M'.repeat(43),
    category: 'task-input',
    binding: BINDING,
    plaintext: { input: 'hello' },
    maxContentLength: 1024,
    ...overrides,
  };
}

async function expectInvalid(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => error instanceof ByokCoreError && error.code === 'sealed_secret_invalid');
}

describe('padding', () => {
  it('gives every frame length one legal padded length, within the design overhead', () => {
    for (let frameLength = 4; frameLength <= 300_000; frameLength += frameLength < 20_000 ? 1 : 97) {
      const padded = sealedPaddedLength(frameLength);
      expect(padded).toBeGreaterThanOrEqual(frameLength);
      expect(sealedPaddedLength(padded)).toBe(padded);
      if (frameLength <= 16_384) expect(padded - frameLength).toBeLessThan(256);
      else expect((padded - frameLength) / frameLength).toBeLessThan(0.0625);
    }
  });

  it('rejects a frame length below the 4-byte length prefix', () => {
    for (const frameLength of [3, -1, 4.5, Number.NaN]) {
      expect(() => sealedPaddedLength(frameLength)).toThrow(ByokCoreError);
    }
  });

  it('applies each of the five frame checks', () => {
    const content = new TextEncoder().encode('{"a":1}');
    const frame = encodeSealedFrame(content);
    expect(decodeSealedFrame(frame, frame.byteLength, 7)).toEqual(content);
    expect(decodeSealedFrame(frame, 512, 7)).toBeUndefined();
    expect(decodeSealedFrame(frame, frame.byteLength, 6)).toBeUndefined();
    const nonZero = new Uint8Array(frame);
    nonZero[255] = 1;
    expect(decodeSealedFrame(nonZero, frame.byteLength, 7)).toBeUndefined();
    const overflow = new Uint8Array(frame);
    new DataView(overflow.buffer).setUint32(0, 253, false);
    expect(decodeSealedFrame(overflow, frame.byteLength, 1024)).toBeUndefined();
    const nonMinimal = new Uint8Array(512);
    nonMinimal.set(frame);
    expect(decodeSealedFrame(nonMinimal, 512, 7)).toBeUndefined();
  });
});

describe('sealContent', () => {
  it('draws a fresh salt and nonce for every content', async () => {
    const first = await sealContent(sealInput());
    const second = await sealContent(sealInput());
    expect(first.header.salt).not.toBe(second.header.salt);
    expect(first.header.nonce).not.toBe(second.header.nonce);
    expect(first.header.contentMac).toBe(second.header.contentMac);
    for (const sealed of [first, second]) {
      const opened = await openSealedContent({ ...sealed, scopeKey: sealInput().scopeKey, binding: BINDING, sealing: SEALING, maxContentLength: 1024 });
      expect(opened).toEqual({ ok: true, plaintext: { input: 'hello' }, header: sealed.header });
    }
  });

  it('seals and opens any finite number by the RFC 8785 number rule (#786)', async () => {
    const plaintext = { ratio: 0.1, cost: -1.5e-7, large: 2 ** 53, huge: 1e21, tiny: 5e-324, zero: -0, parts: [1.25, 3] };
    const sealed = await sealContent(sealInput({ plaintext }));
    const opened = await openSealedContent({ ...sealed, scopeKey: sealInput().scopeKey, binding: BINDING, sealing: SEALING, maxContentLength: 1024 });
    expect(opened).toEqual({ ok: true, plaintext: { ...plaintext, zero: 0 }, header: sealed.header });
    expect(opened.ok && Object.is(opened.plaintext['zero'], 0)).toBe(true);
  });

  it('refuses a frame whose number text is not the canonical form', async () => {
    const salt = new Uint8Array(32).fill(5);
    const nonce = new Uint8Array(12).fill(6);
    const { header } = await sealContentWithRandomness(sealInput({ plaintext: { n: 1 } }), { salt, nonce });
    const contentKey = await crypto.subtle.importKey('raw', await deriveSealedContentKey(sealInput().scopeKey, salt), 'AES-GCM', false, ['encrypt']);
    const openText = async (text: string) => {
      const frame = encodeSealedFrame(new TextEncoder().encode(text));
      const params = { name: 'AES-GCM', iv: nonce, additionalData: new Uint8Array(sealedContentAad(header, BINDING)) };
      const ciphertext = new Uint8Array(await crypto.subtle.encrypt(params, contentKey, frame));
      return openSealedContent({ header, ciphertext, scopeKey: sealInput().scopeKey, binding: BINDING, sealing: SEALING, maxContentLength: 1024 });
    };
    expect(await openText('{"n":1}')).toEqual({ ok: true, plaintext: { n: 1 }, header });
    for (const text of ['{"n":1.0}', '{"n":1e0}', '{"n":1E0}', '{"n":-0}', '{"n":10e-1}', '{"n":1.000000000000000000001}']) {
      expect(await openText(text)).toEqual({ ok: false, reason: 'sealed_open_failed' });
    }
  });

  it('rejects caller input that has no v1 meaning', async () => {
    await expectInvalid(sealContent(sealInput({ category: 'agent-message' })));
    await expectInvalid(sealContent(sealInput({ plaintext: {} })));
    await expectInvalid(sealContent(sealInput({ plaintext: { value: Number.NaN } })));
    await expectInvalid(sealContent(sealInput({ plaintext: { value: Number.POSITIVE_INFINITY } })));
    await expectInvalid(sealContent(sealInput({ plaintext: { value: [1, Number.NEGATIVE_INFINITY] } })));
    await expectInvalid(sealContent(sealInput({ plaintext: { value: [1, , 3] as never } })));
    await expectInvalid(sealContent(sealInput({ plaintext: new Map() as never })));
    const throwingGetter = { get value(): string { throw new TypeError('getter'); } };
    await expectInvalid(sealContent(sealInput({ plaintext: throwingGetter as never })));
    await expectInvalid(sealContent(sealInput({ plaintext: { nested: throwingGetter } as never })));
    const trap = () => { throw new TypeError('trap'); };
    for (const handler of [{ getPrototypeOf: trap }, { ownKeys: trap }, { getOwnPropertyDescriptor: trap }]) {
      await expectInvalid(sealContent(sealInput({ plaintext: new Proxy({ input: 'hello' }, handler) as never })));
    }
    const revoked = Proxy.revocable({ input: 'hello' }, {});
    revoked.revoke();
    await expectInvalid(sealContent(sealInput({ plaintext: revoked.proxy as never })));
    await expectInvalid(sealContent(sealInput({ maxContentLength: 4 })));
    await expectInvalid(sealContent(sealInput({ maxContentLength: -1 })));
    await expectInvalid(sealContent(sealInput({ scopeKey: new Uint8Array(16) })));
    await expectInvalid(sealContent(sealInput({ sender: 'not-a-member-id' })));
    await expectInvalid(sealContent(sealInput({ chainHead: { seq: 0, hash: `sha256:${'1'.repeat(64)}` } })));
    await expectInvalid(sealContent(sealInput({ binding: { ...BINDING, categories: ['task-output', 'task-input'] } })));
    await expectInvalid(sealContent(sealInput({ binding: { ...BINDING, categories: ['task-input', 'task-input'] } })));
    await expectInvalid(sealContent(sealInput({ binding: { ...BINDING, identity: {} } })));
    await expectInvalid(sealContent(sealInput({ binding: { ...BINDING, identity: { task_id: 'x' } } })));
    await expectInvalid(sealContent(sealInput({ binding: { ...BINDING, family: 'task' } })));
    await expectInvalid(sealContent(sealInput({ binding: { ...BINDING, notAfter: '2026-12-31T00:00:00.000Z' } })));
    await expectInvalid(sealContent(sealInput({ binding: { ...BINDING, deviceId: null } })));
    await expectInvalid(sealContent(sealInput({ binding: { ...TEMPLATE_BINDING, notAfter: '2026-12-31T00:00:00Z' } })));
  });

  it('binds a device for every family except routine.template', async () => {
    const template = TEMPLATE_BINDING;
    const expiry = template.notAfter;
    await expect(sealContent(sealInput({ binding: template }))).resolves.toHaveProperty('header');
    await expectInvalid(sealContent(sealInput({ binding: { ...BINDING, deviceId: null, notAfter: expiry } })));
    await expectInvalid(sealContent(sealInput({ binding: { ...BINDING, family: 'task.result', direction: 'daemon-to-server', deviceId: null, notAfter: expiry } })));
    await expectInvalid(sealContent(sealInput({ binding: { ...template, deviceId: 'device-1', notAfter: null } })));
    await expectInvalid(sealContent(sealInput({ binding: { ...template, deviceId: 'device-1' } })));
    await expectInvalid(sealContent(sealInput({ binding: { ...template, notAfter: null } })));
  });

  it('rejects a fixed salt or nonce of the wrong length', async () => {
    await expectInvalid(sealContentWithRandomness(sealInput(), { salt: new Uint8Array(16), nonce: new Uint8Array(12) }));
    await expectInvalid(sealContentWithRandomness(sealInput(), { salt: new Uint8Array(32), nonce: new Uint8Array(16) }));
  });
});

describe('openSealedContent', () => {
  it('returns a typed failure for hostile headers and never throws', async () => {
    const sealed = await sealContent(sealInput());
    for (const header of [undefined, 'header', [], { ...sealed.header, salt: 'not base64url!' }, { ...sealed.header, paddedLength: 2 ** 60 }]) {
      const opened = await openSealedContent({ header, ciphertext: sealed.ciphertext, scopeKey: sealInput().scopeKey, binding: BINDING, sealing: SEALING, maxContentLength: 1024 });
      expect(opened).toEqual({ ok: false, reason: 'sealed_open_failed' });
    }
  });

  it('returns sealing_policy_mismatch for a hostile binding or task scope and never throws', async () => {
    const sealed = await sealContent(sealInput());
    const open = (binding: unknown, sealing: unknown) => openSealedContent({
      ...sealed,
      scopeKey: sealInput().scopeKey,
      binding: binding as SealedBinding,
      sealing: sealing as typeof SEALING,
      maxContentLength: 1024,
    });
    for (const binding of [
      null,
      { ...BINDING, categories: ['task-output', 'task-input'] },
      { ...TEMPLATE_BINDING, notAfter: '2026-12-31T00:00:00Z' },
      { ...BINDING, deviceId: null, notAfter: '2026-12-31T00:00:00.000Z' },
    ]) {
      expect(await open(binding, SEALING)).toEqual({ ok: false, reason: 'sealing_policy_mismatch' });
    }
    for (const sealing of [null, { scopeId: '', epoch: 1 }, { scopeId: 'scope-1', epoch: 0 }, { scopeId: 'scope-2', epoch: 1 }, { scopeId: 'scope-1', epoch: 2 }]) {
      expect(await open(BINDING, sealing)).toEqual({ ok: false, reason: 'sealing_policy_mismatch' });
    }
  });
});

describe('member chain entries', () => {
  it('signs only under the signer key that matches the entry signer', async () => {
    const signer = await p256Pair('sign');
    const other = await p256Pair('sign');
    const entry: UnsignedMemberChainEntryV1 = {
      v: 1, tenantId: 'tenant-1', seq: 1, prev: null, op: 'add', subject: { member: 'x' }, signer: await deriveMemberId(signer.publicJwk),
    };
    const signed = await signMemberChainEntry(entry, signer);
    expect(await verifyMemberChainEntry(signed, signer.publicJwk)).toMatchObject({ ok: true });
    await expectInvalid(signMemberChainEntry(entry, { publicJwk: other.publicJwk, privateKey: signer.privateKey }));
    await expectInvalid(signMemberChainEntry({ ...entry, prev: `sha256:${'0'.repeat(64)}` }, signer));
    await expectInvalid(signMemberChainEntry({ ...entry, subject: { value: 0.5 } }, signer));
  });

  it('refuses a private key that does not pair with the signer public key', async () => {
    const signer = await p256Pair('sign');
    const other = await p256Pair('sign');
    const entry: UnsignedMemberChainEntryV1 = {
      v: 1, tenantId: 'tenant-1', seq: 1, prev: null, op: 'add', subject: { member: 'x' }, signer: await deriveMemberId(signer.publicJwk),
    };
    await expectInvalid(signMemberChainEntry(entry, { publicJwk: signer.publicJwk, privateKey: other.privateKey }));
    await expectInvalid(signMemberChainEntry(entry, { publicJwk: signer.publicJwk, privateKey: (await p256Pair('kem')).privateKey }));
  });

  it('rejects hostile entries without throwing', async () => {
    const signer = await p256Pair('sign');
    for (const entry of [null, 'entry', { v: 1 }, { v: 1, tenantId: 't', seq: 1, prev: null, op: 'grant', subject: {}, signer: 'M'.repeat(43), sig: 'A'.repeat(86) }]) {
      expect(await verifyMemberChainEntry(entry, signer.publicJwk)).toEqual({ ok: false, reason: 'member_chain_entry_invalid' });
    }
  });

  it('refuses a member id for a key that is not on the curve', async () => {
    await expectInvalid(deriveMemberId(OFF_CURVE_JWK));
  });
});

/** A sender, a recipient whose KEM key has `kemEpoch`, and a version 2 package of a fresh scope key between them. */
async function packageParties(kemEpoch: number) {
  const senderSigning = await p256Pair('sign');
  const recipientKem = await p256Pair('kem');
  const recipientId = await deriveMemberId((await p256Pair('sign')).publicJwk);
  const scopeKey = generateScopeKey();
  const pkg = await sealScopeKeyPackage({
    scopeKey,
    tenantId: 'tenant-1',
    scopeId: 'scope-1',
    epoch: 1,
    recipient: { memberId: recipientId, kemPublicJwk: recipientKem.publicJwk, kemEpoch },
    sender: { signingPublicJwk: senderSigning.publicJwk, signingPrivateKey: senderSigning.privateKey },
  });
  const open = (candidate: unknown, openerKemEpoch: number) => openScopeKeyPackage({
    package: candidate,
    expected: { tenantId: 'tenant-1', scopeId: 'scope-1', epoch: 1 },
    recipient: { memberId: recipientId, kemPublicJwk: recipientKem.publicJwk, kemPrivateKey: recipientKem.privateKey, kemEpoch: openerKemEpoch },
    senderSigningPublicJwk: senderSigning.publicJwk,
  });
  return { senderSigning, recipientKem, recipientId, scopeKey, pkg, open };
}

/** A version 1 package as members sealed it before #654 E5b-2: v1 info, v1 AAD and the v1 signing prefix. */
async function sealV1Package({ senderSigning, recipientKem, recipientId, scopeKey }: Awaited<ReturnType<typeof packageParties>>): Promise<ScopeKeyPackageV1> {
  const identity = {
    v: 1 as const,
    tenantId: 'tenant-1',
    scopeId: 'scope-1',
    epoch: 1,
    keyId: await deriveScopeKeyId(scopeKey),
    recipient: recipientId,
    sender: await deriveMemberId(senderSigning.publicJwk),
  };
  const { enc, ciphertext } = await hpkeSealBase({
    recipientPublicKey: await p256PublicKeyBytes(recipientKem.publicJwk),
    info: utf8(SCOPE_KEY_HPKE_INFO),
    aad: canonicalizeJsonBytes(identity),
    plaintext: scopeKey,
  });
  const unsigned = { ...identity, enc: encodeBase64Url(enc), ciphertext: encodeBase64Url(ciphertext) };
  const signingInput = concat(utf8(SCOPE_KEY_PACKAGE_DOMAIN_PREFIX), canonicalizeJsonBytes(unsigned));
  return { ...unsigned, sig: await ecdsaSign(senderSigning.publicJwk, senderSigning.privateKey, signingInput) };
}

describe('scope key packages', () => {
  it('round-trips a fresh scope key between fresh members', async () => {
    const senderSigning = await p256Pair('sign');
    const recipientKem = await p256Pair('kem');
    const recipientId = await deriveMemberId((await p256Pair('sign')).publicJwk);
    const scopeKey = generateScopeKey();
    const pkg = await sealScopeKeyPackage({
      scopeKey,
      tenantId: 'tenant-1',
      scopeId: 'scope-1',
      epoch: 1,
      recipient: { memberId: recipientId, kemPublicJwk: recipientKem.publicJwk, kemEpoch: 1 },
      sender: { signingPublicJwk: senderSigning.publicJwk, signingPrivateKey: senderSigning.privateKey },
    });
    const opened = await openScopeKeyPackage({
      package: pkg,
      expected: { tenantId: 'tenant-1', scopeId: 'scope-1', epoch: 1 },
      recipient: { memberId: recipientId, kemPublicJwk: recipientKem.publicJwk, kemPrivateKey: recipientKem.privateKey, kemEpoch: 1 },
      senderSigningPublicJwk: senderSigning.publicJwk,
    });
    expect(opened.ok && Array.from(opened.scopeKey)).toEqual(Array.from(scopeKey));
    expect(await openScopeKeyPackage({
      package: { ...pkg, extra: 1 },
      expected: { tenantId: 'tenant-1', scopeId: 'scope-1', epoch: 1 },
      recipient: { memberId: recipientId, kemPublicJwk: recipientKem.publicJwk, kemPrivateKey: recipientKem.privateKey, kemEpoch: 1 },
      senderSigningPublicJwk: senderSigning.publicJwk,
    })).toEqual({ ok: false, reason: 'key_package_invalid' });
  });

  it('seals version 2 packages that name the recipient KEM epoch, signed and bound into the AAD', async () => {
    const { pkg, open } = await packageParties(3);
    expect(pkg.v).toBe(2);
    expect(pkg.recipientKemEpoch).toBe(3);
    expect((await open(pkg, 3)).ok).toBe(true);
    expect(await open(pkg, 2)).toEqual({ ok: false, reason: 'key_package_invalid' });
    // The epoch is under the sender signature: an edited epoch that matches the opener still fails.
    expect(await open({ ...pkg, recipientKemEpoch: 2 }, 2)).toEqual({ ok: false, reason: 'key_package_signature_invalid' });
  });

  it('still opens a version 1 package, which names no KEM epoch', async () => {
    const parties = await packageParties(1);
    const v1 = await sealV1Package(parties);
    expect(v1.v).toBe(1);
    for (const kemEpoch of [1, 2]) {
      const opened = await parties.open(v1, kemEpoch);
      expect(opened.ok && Array.from(opened.scopeKey)).toEqual(Array.from(parties.scopeKey));
    }
  });

  it('refuses a package whose KEM epoch field does not match its version', async () => {
    const parties = await packageParties(1);
    const { recipientKemEpoch: _recipientKemEpoch, ...noEpoch } = parties.pkg;
    expect(await parties.open(noEpoch, 1)).toEqual({ ok: false, reason: 'key_package_invalid' });
    expect(await parties.open({ ...parties.pkg, v: 1 }, 1)).toEqual({ ok: false, reason: 'key_package_invalid' });
    expect(await parties.open({ ...(await sealV1Package(parties)), recipientKemEpoch: 1 }, 1)).toEqual({ ok: false, reason: 'key_package_invalid' });
  });

  it('rejects package input that has no v1 meaning before it seals anything', async () => {
    const senderSigning = await p256Pair('sign');
    const recipientKem = await p256Pair('kem');
    const base = {
      scopeKey: generateScopeKey(),
      tenantId: 'tenant-1',
      scopeId: 'scope-1',
      epoch: 1,
      recipient: { memberId: 'M'.repeat(43), kemPublicJwk: recipientKem.publicJwk, kemEpoch: 1 },
      sender: { signingPublicJwk: senderSigning.publicJwk, signingPrivateKey: senderSigning.privateKey },
    };
    await expectInvalid(sealScopeKeyPackage({ ...base, epoch: 0 }));
    await expectInvalid(sealScopeKeyPackage({ ...base, tenantId: '' }));
    await expectInvalid(sealScopeKeyPackage({ ...base, scopeKey: new Uint8Array(31) }));
    await expectInvalid(sealScopeKeyPackage({ ...base, recipient: { ...base.recipient, memberId: 'short' } }));
    await expectInvalid(sealScopeKeyPackage({ ...base, recipient: { ...base.recipient, kemPublicJwk: OFF_CURVE_JWK } }));
    await expectInvalid(sealScopeKeyPackage({ ...base, recipient: { ...base.recipient, kemEpoch: 0 } }));
  });

  it('refuses a signing private key that does not pair with the sender public key', async () => {
    const senderSigning = await p256Pair('sign');
    const recipientKem = await p256Pair('kem');
    const base = {
      scopeKey: generateScopeKey(),
      tenantId: 'tenant-1',
      scopeId: 'scope-1',
      epoch: 1,
      recipient: { memberId: 'M'.repeat(43), kemPublicJwk: recipientKem.publicJwk, kemEpoch: 1 },
    };
    const otherPrivateKey = (await p256Pair('sign')).privateKey;
    await expectInvalid(sealScopeKeyPackage({ ...base, sender: { signingPublicJwk: senderSigning.publicJwk, signingPrivateKey: otherPrivateKey } }));
    await expectInvalid(sealScopeKeyPackage({ ...base, sender: { signingPublicJwk: senderSigning.publicJwk, signingPrivateKey: recipientKem.privateKey } }));
  });
});
