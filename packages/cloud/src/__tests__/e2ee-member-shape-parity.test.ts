/**
 * Protocol repeats core's member shapes because protocol cannot depend on
 * core (#654 E2c). For a real core value and many mutations of it, protocol
 * accepts the shape exactly when core does. Core's verdict here is its shape
 * verdict: every mutation either breaks the shape or keeps the signed bytes.
 */
import {
  createMemberKeyBundle,
  generateScopeKey,
  openScopeKeyPackage,
  parseMemberKeyBundle,
  sealScopeKeyPackage,
  signMemberChainEntry,
  verifyMemberChainEntry,
  type MemberKeyBundleV1,
} from '@byok-sdk/core/sealed-payload';
import {
  E2eeMemberChainEntrySchema,
  E2eeMemberKeyBundleSchema,
  E2eeScopeKeyPackageSchema,
} from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';

type Jwk = MemberKeyBundleV1['signingPublicJwk'];
type Json = Record<string, unknown>;

async function keyPair(use: 'sign' | 'kem') {
  const pair = await crypto.subtle.generateKey(
    { name: use === 'sign' ? 'ECDSA' : 'ECDH', namedCurve: 'P-256' },
    true,
    use === 'sign' ? ['sign', 'verify'] : ['deriveBits'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! } as Jwk, privateKey: pair.privateKey };
}

/** Last characters whose unused low bits are not zero, by `bytes % 3`. */
const NON_CANONICAL_LAST = ['', 'B', 'B'];

function base64Variants(value: string, bytes: number): unknown[] {
  return [
    value.slice(0, -1),
    `${value}A`,
    `${value.slice(0, -1)}+`,
    `${value.slice(0, -1)}=`,
    ...(NON_CANONICAL_LAST[bytes % 3] ? [`${value.slice(0, -1)}${NON_CANONICAL_LAST[bytes % 3]}`] : []),
  ];
}

const COMMON = [undefined, null, 0, 1.5, true, '', 'x', [], {}];
const NUMBER = [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1'];

/** Every variant replaces one field (or removes it, for `undefined`). */
function variants(base: Json, fields: Record<string, readonly unknown[]>): Array<{ readonly label: string; readonly value: Json }> {
  const out = [{ label: 'extra key', value: { ...base, extra: 1 } }];
  for (const [field, values] of Object.entries(fields)) {
    for (const value of [...COMMON, ...values]) {
      const copy: Json = { ...base };
      if (value === undefined) delete copy[field];
      else copy[field] = value;
      out.push({ label: `${field} = ${JSON.stringify(value)}`, value: copy });
    }
  }
  return out;
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe('protocol E2EE member shapes match core', () => {
  it('member key bundle', async () => {
    const signing = await keyPair('sign');
    const bundle = await createMemberKeyBundle({
      signingPublicJwk: signing.publicJwk,
      signingPrivateKey: signing.privateKey as never,
      kemPublicJwk: (await keyPair('kem')).publicJwk,
      kemEpoch: 1,
      deviceId: 'device-1',
    }) as unknown as Json;
    const jwk = bundle.kemPublicJwk as Json;
    const cases = [
      { label: 'original', value: bundle },
      // kemSig does not cover deviceId, so these keep the signed bytes.
      { label: 'client bundle', value: Object.fromEntries(Object.entries(bundle).filter(([key]) => key !== 'deviceId')) },
      { label: 'other deviceId', value: { ...bundle, deviceId: 'device-2' } },
      ...variants(bundle, {
        v: [2],
        // Same-length ids pass both shapes; core then refuses them on the derived id.
        memberId: base64Variants(bundle.memberId as string, 32).filter(value => typeof value === 'string' && value.length !== 43),
        kemEpoch: NUMBER,
        kemSig: base64Variants(bundle.kemSig as string, 64),
        deviceId: [],
      }).filter(entry => entry.label !== 'deviceId = undefined' && entry.label !== 'deviceId = "x"'),
      ...variants(jwk, { kty: ['RSA'], crv: ['P-384'], x: base64Variants(jwk.x as string, 32), y: base64Variants(jwk.y as string, 32) })
        .map(entry => ({ label: `kemPublicJwk.${entry.label}`, value: { ...bundle, kemPublicJwk: entry.value } })),
    ];
    for (const { label, value } of cases) {
      const core = (await parseMemberKeyBundle(json(value))) !== undefined;
      expect(E2eeMemberKeyBundleSchema.safeParse(json(value)).success, label).toBe(core);
    }
  });

  it('member chain entry', async () => {
    const signing = await keyPair('sign');
    const kem = await keyPair('kem');
    const bundle = await createMemberKeyBundle({ signingPublicJwk: signing.publicJwk, signingPrivateKey: signing.privateKey as never, kemPublicJwk: kem.publicJwk, kemEpoch: 1 });
    const entry = await signMemberChainEntry(
      { v: 1, tenantId: 'tenant-1', seq: 1, prev: null, op: 'add', subject: { member: bundle as never }, signer: bundle.memberId },
      { publicJwk: signing.publicJwk, privateKey: signing.privateKey as never },
    ) as unknown as Json;
    const otherSig = `${'A'.repeat(85)}Q`;
    const cases = [
      { label: 'original', value: entry },
      // Shape-valid changes: core reports a bad signature, not a bad shape.
      { label: 'other sig', value: { ...entry, sig: otherSig } },
      { label: 'empty subject', value: { ...entry, subject: {} } },
      { label: 'seq 2 with prev', value: { ...entry, seq: 2, prev: `sha256:${'0'.repeat(64)}` } },
      { label: 'op shred', value: { ...entry, op: 'shred' } },
      ...variants(entry, {
        v: [2],
        tenantId: [],
        seq: NUMBER,
        prev: [`sha256:${'0'.repeat(63)}`, `sha256:${'A'.repeat(64)}`, `sha256:${'0'.repeat(64)}`],
        op: ['join'],
        subject: [[1], 'subject'],
        signer: base64Variants(entry.signer as string, 32).filter(value => typeof value === 'string' && value.length !== 43),
        sig: base64Variants(entry.sig as string, 64),
      }).filter(entry => entry.label !== 'subject = {}' && entry.label !== 'tenantId = "x"'),
    ];
    for (const { label, value } of cases) {
      const verdict = await verifyMemberChainEntry(json(value), signing.publicJwk);
      const core = verdict.ok || verdict.reason !== 'member_chain_entry_invalid';
      expect(E2eeMemberChainEntrySchema.safeParse(json(value)).success, label).toBe(core);
    }
  });

  it('scope key package', async () => {
    const sender = await keyPair('sign');
    const kem = await keyPair('kem');
    const senderBundle = await createMemberKeyBundle({ signingPublicJwk: sender.publicJwk, signingPrivateKey: sender.privateKey as never, kemPublicJwk: (await keyPair('kem')).publicJwk, kemEpoch: 1 });
    const recipientSigning = await keyPair('sign');
    const recipient = await createMemberKeyBundle({ signingPublicJwk: recipientSigning.publicJwk, signingPrivateKey: recipientSigning.privateKey as never, kemPublicJwk: kem.publicJwk, kemEpoch: 1 });
    const pkg = await sealScopeKeyPackage({
      scopeKey: generateScopeKey(),
      tenantId: 'tenant-1',
      scopeId: 'scope-1',
      epoch: 1,
      recipient: { memberId: recipient.memberId, kemPublicJwk: kem.publicJwk },
      sender: { signingPublicJwk: sender.publicJwk, signingPrivateKey: sender.privateKey as never },
    }) as unknown as Json;
    const cases = [
      { label: 'original', value: pkg },
      { label: 'other keyId', value: { ...pkg, keyId: 'A'.repeat(22) } },
      { label: 'other sig', value: { ...pkg, sig: `${'A'.repeat(85)}Q` } },
      ...variants(pkg, {
        v: [2],
        tenantId: [],
        scopeId: [],
        epoch: NUMBER,
        keyId: ['A'.repeat(21), 'A'.repeat(23), `${'A'.repeat(21)}+`],
        recipient: base64Variants(pkg.recipient as string, 32).filter(value => typeof value === 'string' && value.length !== 43),
        sender: base64Variants(pkg.sender as string, 32).filter(value => typeof value === 'string' && value.length !== 43),
        enc: base64Variants(pkg.enc as string, 65),
        ciphertext: base64Variants(pkg.ciphertext as string, 48),
        sig: base64Variants(pkg.sig as string, 64),
      }).filter(entry => !['tenantId = "x"', 'scopeId = "x"'].includes(entry.label)),
    ];
    for (const { label, value } of cases) {
      const verdict = await openScopeKeyPackage({
        package: json(value),
        expected: { tenantId: 'tenant-1', scopeId: 'scope-1', epoch: 1 },
        recipient: { memberId: recipient.memberId, kemPublicJwk: kem.publicJwk, kemPrivateKey: kem.privateKey as never },
        senderSigningPublicJwk: senderBundle.signingPublicJwk,
      });
      const core = verdict.ok || verdict.reason !== 'key_package_invalid';
      expect(E2eeScopeKeyPackageSchema.safeParse(json(value)).success, label).toBe(core);
    }
  });
});
