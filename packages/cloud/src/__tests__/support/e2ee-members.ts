/** Core-signed E2EE members, chain entries and key packages for the cloud E2EE tests. */
import type { JsonValue, TenantId } from '@byok-sdk/core';
import {
  createMemberKeyBundle,
  generateScopeKey,
  memberChainEntryHash,
  sealScopeKeyPackage,
  signMemberChainEntry,
  type MemberChainEntryV1,
  type MemberKeyBundleV1,
} from '@byok-sdk/core/sealed-payload';

type Jwk = MemberKeyBundleV1['signingPublicJwk'];
type CryptoKey = Parameters<typeof createMemberKeyBundle>[0]['signingPrivateKey'];

export interface Member {
  readonly bundle: MemberKeyBundleV1;
  readonly signer: { readonly publicJwk: Jwk; readonly privateKey: CryptoKey };
}

async function keyPair(use: 'sign' | 'kem'): Promise<{ publicJwk: Jwk; privateKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: use === 'sign' ? 'ECDSA' : 'ECDH', namedCurve: 'P-256' },
    true,
    use === 'sign' ? ['sign', 'verify'] : ['deriveBits'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! }, privateKey: pair.privateKey as CryptoKey };
}

export async function newMember(deviceId?: string): Promise<Member> {
  const signing = await keyPair('sign');
  const bundle = await createMemberKeyBundle({
    signingPublicJwk: signing.publicJwk,
    signingPrivateKey: signing.privateKey,
    kemPublicJwk: (await keyPair('kem')).publicJwk,
    kemEpoch: 1,
    ...(deviceId === undefined ? {} : { deviceId }),
  });
  return { bundle, signer: signing };
}

export async function chain(tenant: TenantId, signer: Member, length: number): Promise<MemberChainEntryV1[]> {
  const entries: MemberChainEntryV1[] = [];
  let prev: string | null = null;
  for (let seq = 1; seq <= length; seq += 1) {
    const unsigned = { v: 1 as const, tenantId: tenant, seq, prev, op: 'add' as const, subject: { member: signer.bundle as unknown as JsonValue, seq }, signer: signer.bundle.memberId };
    entries.push(await signMemberChainEntry(unsigned, signer.signer));
    prev = await memberChainEntryHash(unsigned);
  }
  return entries;
}

/** Signed entries from seq 1, all by `signer`. The first must add `signer`. */
export async function signedChain(
  tenant: TenantId,
  signer: Member,
  ops: readonly Pick<MemberChainEntryV1, 'op' | 'subject'>[],
): Promise<MemberChainEntryV1[]> {
  const entries: MemberChainEntryV1[] = [];
  let prev: string | null = null;
  for (const [index, { op, subject }] of ops.entries()) {
    const unsigned = { v: 1 as const, tenantId: tenant, seq: index + 1, prev, op, subject, signer: signer.bundle.memberId };
    entries.push(await signMemberChainEntry(unsigned, signer.signer));
    prev = await memberChainEntryHash(unsigned);
  }
  return entries;
}

export async function keyPackage(
  tenant: TenantId,
  sender: Member,
  recipient: Member,
  epoch: number,
  scopeKey: ReturnType<typeof generateScopeKey> = generateScopeKey(),
) {
  return sealScopeKeyPackage({
    scopeKey,
    tenantId: tenant,
    scopeId: 'scope-1',
    epoch,
    recipient: { memberId: recipient.bundle.memberId, kemPublicJwk: recipient.bundle.kemPublicJwk, kemEpoch: recipient.bundle.kemEpoch },
    sender: { signingPublicJwk: sender.signer.publicJwk, signingPrivateKey: sender.signer.privateKey },
  });
}
