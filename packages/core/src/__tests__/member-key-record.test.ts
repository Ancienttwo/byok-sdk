/**
 * E2d-1 member key record (#654 design §7.1, §7.7; owner §50a D): the stored
 * form of a device member's two private keys, and its tamper proofs. E2d-5:
 * its KEM rotation (§7.5).
 */
import { describe, expect, it } from 'vitest';

import { canonicalizeJson, type JsonObject } from '../attestation';
import { createMemberKeyBundle } from '../sealed-payload/member-bundle';
import { deriveMemberId, signMemberChainEntry, verifyMemberChainEntry } from '../sealed-payload/member-chain';
import {
  beginMemberKemRotation,
  finishMemberKemRotation,
  generateMemberKeyRecord,
  openMemberKeyRecord,
  type MemberKemKey,
  type MemberKeys,
} from '../sealed-payload/member-key-record';
import { generateScopeKey, openScopeKeyPackage, sealScopeKeyPackage } from '../sealed-payload/scope-key';

const DEVICE = { tenantId: 'tenant-a', deviceId: 'device-1' };

function edit(text: string, change: (record: Record<string, unknown>) => void): string {
  const record = JSON.parse(text) as Record<string, unknown>;
  change(record);
  return canonicalizeJson(record as JsonObject);
}

describe('member key record', () => {
  it('creates a new member at KEM epoch 1, as one canonical line, and opens it non-extractable', async () => {
    const text = await generateMemberKeyRecord(DEVICE);
    expect(text).not.toContain('\n');
    expect(canonicalizeJson(JSON.parse(text) as JsonObject)).toBe(text);
    const keys = await openMemberKeyRecord(text);
    expect(keys?.binding).toEqual(DEVICE);
    expect(keys?.kem.epoch).toBe(1);
    expect(keys?.signing.privateKey.extractable).toBe(false);
    expect(keys?.kem.privateKey.extractable).toBe(false);
    expect(Object.keys(keys!.signing.publicJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(keys?.kem.publicJwk).not.toEqual(keys?.signing.publicJwk);
    // A second open of the same text gives the same member.
    const again = await openMemberKeyRecord(text);
    expect(again?.signing.publicJwk).toEqual(keys?.signing.publicJwk);
    expect(again?.kem.publicJwk).toEqual(keys?.kem.publicJwk);
  });

  it('binds a client member with no device id, and gives each record its own member', async () => {
    const client = await openMemberKeyRecord(await generateMemberKeyRecord({ tenantId: 'tenant-a' }));
    expect(client?.binding).toEqual({ tenantId: 'tenant-a' });
    const other = await openMemberKeyRecord(await generateMemberKeyRecord(DEVICE));
    const first = await openMemberKeyRecord(await generateMemberKeyRecord(DEVICE));
    expect(await deriveMemberId(first!.signing.publicJwk)).not.toBe(await deriveMemberId(other!.signing.publicJwk));
  });

  it('refuses a binding with no tenant', async () => {
    await expect(generateMemberKeyRecord({ tenantId: '' })).rejects.toMatchObject({ code: 'sealed_secret_invalid' });
  });

  it('signs chain entries and opens key packages sealed to its KEM key', async () => {
    const keys = (await openMemberKeyRecord(await generateMemberKeyRecord(DEVICE)))!;
    const member = await createMemberKeyBundle({
      signingPublicJwk: keys.signing.publicJwk,
      signingPrivateKey: keys.signing.privateKey,
      kemPublicJwk: keys.kem.publicJwk,
      kemEpoch: keys.kem.epoch,
      deviceId: DEVICE.deviceId,
    });
    const entry = await signMemberChainEntry(
      { v: 1, tenantId: DEVICE.tenantId, seq: 1, prev: null, op: 'add', subject: { member: member as unknown as JsonObject }, signer: member.memberId },
      keys.signing,
    );
    expect((await verifyMemberChainEntry(entry, keys.signing.publicJwk)).ok).toBe(true);
    const scopeKey = generateScopeKey();
    const pkg = await sealScopeKeyPackage({
      scopeKey, tenantId: DEVICE.tenantId, scopeId: 'scope-a', epoch: 1,
      recipient: { memberId: member.memberId, kemPublicJwk: keys.kem.publicJwk, kemEpoch: keys.kem.epoch },
      sender: { signingPublicJwk: keys.signing.publicJwk, signingPrivateKey: keys.signing.privateKey },
    });
    const opened = await openScopeKeyPackage({
      package: pkg,
      expected: { tenantId: DEVICE.tenantId, scopeId: 'scope-a', epoch: 1 },
      recipient: { memberId: member.memberId, kemPublicJwk: keys.kem.publicJwk, kemPrivateKey: keys.kem.privateKey, kemEpoch: keys.kem.epoch },
      senderSigningPublicJwk: keys.signing.publicJwk,
    });
    expect(opened.ok && Buffer.from(opened.scopeKey).equals(Buffer.from(scopeKey))).toBe(true);
  });

  it('opens nothing when a private scalar does not match its public point', async () => {
    const text = await generateMemberKeyRecord(DEVICE);
    const other = JSON.parse(await generateMemberKeyRecord(DEVICE)) as { signingJwk: { d: string }; kemJwk: { d: string } };
    expect(await openMemberKeyRecord(edit(text, (record) => { (record.signingJwk as { d: string }).d = other.signingJwk.d; }))).toBeUndefined();
    expect(await openMemberKeyRecord(edit(text, (record) => { (record.kemJwk as { d: string }).d = other.kemJwk.d; }))).toBeUndefined();
  });

  it('opens nothing for a record that is not canonical v1 text', async () => {
    const text = await generateMemberKeyRecord(DEVICE);
    const record = JSON.parse(text) as Record<string, unknown>;
    expect(await openMemberKeyRecord(JSON.stringify(record, null, 1))).toBeUndefined();
    expect(await openMemberKeyRecord(edit(text, (value) => { value.v = 2; }))).toBeUndefined();
    expect(await openMemberKeyRecord(edit(text, (value) => { value.extra = true; }))).toBeUndefined();
    expect(await openMemberKeyRecord(edit(text, (value) => { value.kemEpoch = 0; }))).toBeUndefined();
    expect(await openMemberKeyRecord(edit(text, (value) => { (value.kemJwk as { d: string }).d = 'AAAA'; }))).toBeUndefined();
    expect(await openMemberKeyRecord('not json')).toBeUndefined();
    expect(await openMemberKeyRecord(undefined)).toBeUndefined();
  });
});

/** A package of `scopeKey` from the member `keys` to itself, wrapped to `kem`. */
async function selfPackage(keys: MemberKeys, kem: MemberKemKey, scopeKey: Uint8Array) {
  return sealScopeKeyPackage({
    scopeKey, tenantId: DEVICE.tenantId, scopeId: 'scope-a', epoch: 1,
    recipient: { memberId: await deriveMemberId(keys.signing.publicJwk), kemPublicJwk: kem.publicJwk, kemEpoch: kem.epoch },
    sender: { signingPublicJwk: keys.signing.publicJwk, signingPrivateKey: keys.signing.privateKey },
  });
}

async function openSelf(keys: MemberKeys, kem: MemberKemKey, pkg: unknown) {
  return openScopeKeyPackage({
    package: pkg, expected: { tenantId: DEVICE.tenantId, scopeId: 'scope-a', epoch: 1 },
    recipient: { memberId: await deriveMemberId(keys.signing.publicJwk), kemPublicJwk: kem.publicJwk, kemPrivateKey: kem.privateKey, kemEpoch: kem.epoch },
    senderSigningPublicJwk: keys.signing.publicJwk,
  });
}

describe('member key record KEM rotation (E2d-5)', () => {
  it('begins a rotation beside the current key, keeps the member, and resumes it unchanged', async () => {
    const text = await generateMemberKeyRecord(DEVICE);
    const before = (await openMemberKeyRecord(text))!;
    expect(before.nextKem).toBeUndefined();
    const begun = await beginMemberKemRotation(text);
    expect(canonicalizeJson(JSON.parse(begun) as JsonObject)).toBe(begun);
    const keys = (await openMemberKeyRecord(begun))!;
    expect(keys.signing.publicJwk).toEqual(before.signing.publicJwk);
    expect(keys.kem).toMatchObject({ epoch: 1, publicJwk: before.kem.publicJwk });
    expect(keys.nextKem?.epoch).toBe(2);
    expect(keys.nextKem?.publicJwk).not.toEqual(before.kem.publicJwk);
    expect(keys.nextKem?.privateKey.extractable).toBe(false);
    expect(await beginMemberKemRotation(begun)).toBe(begun);
  });

  it('opens a package of the old key until the rotation finishes, then only one of the new key', async () => {
    const begun = await beginMemberKemRotation(await generateMemberKeyRecord(DEVICE));
    const keys = (await openMemberKeyRecord(begun))!;
    const scopeKey = generateScopeKey();
    const old = await selfPackage(keys, keys.kem, scopeKey);
    const next = await selfPackage(keys, keys.nextKem!, scopeKey);
    expect((await openSelf(keys, keys.kem, old)).ok).toBe(true);
    expect((await openSelf(keys, keys.nextKem!, next)).ok).toBe(true);

    const finished = finishMemberKemRotation(begun, 2)!;
    const after = (await openMemberKeyRecord(finished))!;
    expect(after.nextKem).toBeUndefined();
    expect(after.kem).toMatchObject({ epoch: 2, publicJwk: keys.nextKem!.publicJwk });
    expect(finished).not.toContain((JSON.parse(begun) as { kemJwk: { d: string } }).kemJwk.d);
    expect((await openSelf(after, after.kem, next)).ok).toBe(true);
    expect((await openSelf(after, after.kem, old)).ok).toBe(false);
    // A repeat finish changes nothing, and the next rotation goes from 2 to 3.
    expect(finishMemberKemRotation(finished, 2)).toBe(finished);
    expect((await openMemberKeyRecord(await beginMemberKemRotation(finished)))?.nextKem?.epoch).toBe(3);
  });

  it('refuses to finish a rotation that is not pending, and any record that is not canonical v1 text', async () => {
    const text = await generateMemberKeyRecord(DEVICE);
    expect(finishMemberKemRotation(text, 2)).toBeUndefined();
    const begun = await beginMemberKemRotation(text);
    expect(finishMemberKemRotation(begun, 1)).toBeUndefined();
    expect(finishMemberKemRotation(begun, 3)).toBeUndefined();
    expect(() => finishMemberKemRotation('not json', 2)).toThrow(expect.objectContaining({ code: 'sealed_secret_invalid' }));
    await expect(beginMemberKemRotation(`${text} `)).rejects.toMatchObject({ code: 'sealed_secret_invalid' });
  });

  it('opens nothing for a pending key at another epoch, or whose scalar does not match its public point', async () => {
    const begun = await beginMemberKemRotation(await generateMemberKeyRecord(DEVICE));
    const other = JSON.parse(await generateMemberKeyRecord(DEVICE)) as { kemJwk: { d: string } };
    expect(await openMemberKeyRecord(edit(begun, (record) => { (record.nextKem as { epoch: number }).epoch = 3; }))).toBeUndefined();
    expect(await openMemberKeyRecord(edit(begun, (record) => { ((record.nextKem as { jwk: { d: string } }).jwk).d = other.kemJwk.d; }))).toBeUndefined();
    expect(await openMemberKeyRecord(edit(begun, (record) => { (record.nextKem as Record<string, unknown>).extra = 1; }))).toBeUndefined();
  });
});
