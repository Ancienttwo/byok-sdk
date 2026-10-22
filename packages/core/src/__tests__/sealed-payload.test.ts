/**
 * Sealed-payload v1 behavior that fixed vectors do not show (#654 E1a):
 * caller input errors, fresh randomness, padding properties, and receivers
 * that return typed failures instead of throwing for hostile input. The byte
 * rules themselves are pinned by `sealed-payload-vectors.test.ts`.
 */
import { describe, expect, it } from 'vitest';

import { ByokCoreError } from '../errors';
import {
  deriveMemberId,
  signMemberChainEntry,
  verifyMemberChainEntry,
  type UnsignedMemberChainEntryV1,
} from '../sealed-payload/member-chain';
import type { P256PublicJwk } from '../sealed-payload/primitives';
import { generateScopeKey, openScopeKeyPackage, sealScopeKeyPackage } from '../sealed-payload/scope-key';
import {
  decodeSealedFrame,
  encodeSealedFrame,
  openSealedContent,
  sealContent,
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
      const opened = await openSealedContent({ ...sealed, scopeKey: sealInput().scopeKey, binding: BINDING, maxContentLength: 1024 });
      expect(opened).toEqual({ ok: true, plaintext: { input: 'hello' } });
    }
  });

  it('rejects caller input that has no v1 meaning', async () => {
    await expectInvalid(sealContent(sealInput({ category: 'agent-message' })));
    await expectInvalid(sealContent(sealInput({ plaintext: {} })));
    await expectInvalid(sealContent(sealInput({ plaintext: { value: 1.5 } })));
    await expectInvalid(sealContent(sealInput({ plaintext: new Map() as never })));
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
    await expectInvalid(sealContent(sealInput({ binding: { ...BINDING, deviceId: null, notAfter: '2026-12-31T00:00:00Z' } })));
  });

  it('rejects a fixed salt or nonce of the wrong length', async () => {
    await expectInvalid(sealContent(sealInput(), { salt: new Uint8Array(16), nonce: new Uint8Array(12) }));
    await expectInvalid(sealContent(sealInput(), { salt: new Uint8Array(32), nonce: new Uint8Array(16) }));
  });
});

describe('openSealedContent', () => {
  it('returns a typed failure for hostile headers and never throws', async () => {
    const sealed = await sealContent(sealInput());
    for (const header of [undefined, 'header', [], { ...sealed.header, salt: 'not base64url!' }, { ...sealed.header, paddedLength: 2 ** 60 }]) {
      const opened = await openSealedContent({ header, ciphertext: sealed.ciphertext, scopeKey: sealInput().scopeKey, binding: BINDING, maxContentLength: 1024 });
      expect(opened).toEqual({ ok: false, reason: 'sealed_open_failed' });
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
      recipient: { memberId: recipientId, kemPublicJwk: recipientKem.publicJwk },
      sender: { signingPublicJwk: senderSigning.publicJwk, signingPrivateKey: senderSigning.privateKey },
    });
    const opened = await openScopeKeyPackage({
      package: pkg,
      expected: { tenantId: 'tenant-1', scopeId: 'scope-1', epoch: 1 },
      recipient: { memberId: recipientId, kemPublicJwk: recipientKem.publicJwk, kemPrivateKey: recipientKem.privateKey },
      senderSigningPublicJwk: senderSigning.publicJwk,
    });
    expect(opened.ok && Array.from(opened.scopeKey)).toEqual(Array.from(scopeKey));
    expect(await openScopeKeyPackage({
      package: { ...pkg, extra: 1 },
      expected: { tenantId: 'tenant-1', scopeId: 'scope-1', epoch: 1 },
      recipient: { memberId: recipientId, kemPublicJwk: recipientKem.publicJwk, kemPrivateKey: recipientKem.privateKey },
      senderSigningPublicJwk: senderSigning.publicJwk,
    })).toEqual({ ok: false, reason: 'key_package_invalid' });
  });

  it('rejects package input that has no v1 meaning before it seals anything', async () => {
    const senderSigning = await p256Pair('sign');
    const recipientKem = await p256Pair('kem');
    const base = {
      scopeKey: generateScopeKey(),
      tenantId: 'tenant-1',
      scopeId: 'scope-1',
      epoch: 1,
      recipient: { memberId: 'M'.repeat(43), kemPublicJwk: recipientKem.publicJwk },
      sender: { signingPublicJwk: senderSigning.publicJwk, signingPrivateKey: senderSigning.privateKey },
    };
    await expectInvalid(sealScopeKeyPackage({ ...base, epoch: 0 }));
    await expectInvalid(sealScopeKeyPackage({ ...base, tenantId: '' }));
    await expectInvalid(sealScopeKeyPackage({ ...base, scopeKey: new Uint8Array(31) }));
    await expectInvalid(sealScopeKeyPackage({ ...base, recipient: { ...base.recipient, memberId: 'short' } }));
    await expectInvalid(sealScopeKeyPackage({ ...base, recipient: { ...base.recipient, kemPublicJwk: OFF_CURVE_JWK } }));
  });
});
