/**
 * E2d-1 member key record (#654 design §7.1, §7.7; owner §50a D): the stored
 * form of a device member's two private keys, and its tamper proofs.
 */
import { describe, expect, it } from 'vitest';

import { canonicalizeJson, type JsonObject } from '../attestation';
import { createMemberKeyBundle } from '../sealed-payload/member-bundle';
import { deriveMemberId, signMemberChainEntry, verifyMemberChainEntry } from '../sealed-payload/member-chain';
import { generateMemberKeyRecord, openMemberKeyRecord } from '../sealed-payload/member-key-record';
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
      recipient: { memberId: member.memberId, kemPublicJwk: keys.kem.publicJwk },
      sender: { signingPublicJwk: keys.signing.publicJwk, signingPrivateKey: keys.signing.privateKey },
    });
    const opened = await openScopeKeyPackage({
      package: pkg,
      expected: { tenantId: DEVICE.tenantId, scopeId: 'scope-a', epoch: 1 },
      recipient: { memberId: member.memberId, kemPublicJwk: keys.kem.publicJwk, kemPrivateKey: keys.kem.privateKey },
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
