/**
 * E2b member rules (#654 design §7.2–§7.5, §11.2): the member key bundle, the
 * two pairing MACs, and the forward member chain walk.
 */
import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { JsonObject } from '../attestation';
import { parseMemberKeyBundle, type MemberKeyBundleV1 } from '../sealed-payload/member-bundle';
import {
  deriveMemberId,
  memberChainEntryHash,
  signMemberChainEntry,
  type MemberChainEntryV1,
  type MemberChainOp,
} from '../sealed-payload/member-chain';
import {
  applyMemberChainEntries,
  memberChainScopeRecipients,
  type MemberChainState,
} from '../sealed-payload/member-chain-walk';
import {
  CLIENT_PAIRING_MAC_DOMAIN,
  DEVICE_PAIRING_MAC_DOMAIN,
  computeClientPairingMac,
  computeDevicePairingMac,
  generatePairingVerificationSecret,
  verifyClientPairingMac,
  verifyDevicePairingMac,
} from '../sealed-payload/pairing-verification';
import type { P256PublicJwk } from '../sealed-payload/primitives';
import type { WebCryptoKey } from '../webcrypto';

const TENANT = 'tenant-1';

interface Member {
  readonly bundle: MemberKeyBundleV1;
  readonly signingPrivateKey: WebCryptoKey;
}

async function p256Pair(use: 'sign' | 'kem'): Promise<{ publicJwk: P256PublicJwk; privateKey: WebCryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: use === 'sign' ? 'ECDSA' : 'ECDH', namedCurve: 'P-256' },
    true,
    use === 'sign' ? ['sign', 'verify'] : ['deriveBits'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y! }, privateKey: pair.privateKey };
}

async function kemJwk(): Promise<P256PublicJwk> {
  return (await p256Pair('kem')).publicJwk;
}

async function newMember(deviceId?: string): Promise<Member> {
  const signing = await p256Pair('sign');
  const bundle: MemberKeyBundleV1 = {
    v: 1,
    memberId: await deriveMemberId(signing.publicJwk),
    signingPublicJwk: signing.publicJwk,
    kemPublicJwk: await kemJwk(),
    kemEpoch: 1,
    ...(deviceId === undefined ? {} : { deviceId }),
  };
  return { bundle, signingPrivateKey: signing.privateKey };
}

/** The entry hash names the unsigned entry. */
async function entryHash(entry: MemberChainEntryV1): Promise<string> {
  const { sig: _sig, ...unsigned } = entry;
  return memberChainEntryHash(unsigned);
}

function bundleJson(bundle: MemberKeyBundleV1): JsonObject {
  return JSON.parse(JSON.stringify(bundle)) as JsonObject;
}

async function signEntry(
  signer: Member,
  fields: { seq: number; prev: string | null; op: MemberChainOp; subject: JsonObject; tenantId?: string },
): Promise<MemberChainEntryV1> {
  return signMemberChainEntry(
    { v: 1, tenantId: fields.tenantId ?? TENANT, seq: fields.seq, prev: fields.prev, op: fields.op, subject: fields.subject, signer: signer.bundle.memberId },
    { publicJwk: signer.bundle.signingPublicJwk, privateKey: signer.signingPrivateKey },
  );
}

/** A chain whose first entry the test trusts by construction: `client` adds itself. */
async function trustedStart(client: Member): Promise<MemberChainState> {
  const genesis = await signEntry(client, { seq: 1, prev: null, op: 'add', subject: { member: bundleJson(client.bundle) } });
  return {
    tenantId: TENANT,
    head: { seq: 1, hash: await entryHash(genesis) },
    members: new Map([[client.bundle.memberId, client.bundle]]),
    removed: new Set(),
    scopes: new Map(),
    shredded: new Set(),
  };
}

/** Sign the next entry after `state`'s head (or after `after`). */
async function next(
  state: MemberChainState,
  signer: Member,
  op: MemberChainOp,
  subject: JsonObject,
  after?: MemberChainEntryV1,
): Promise<MemberChainEntryV1> {
  const head = after === undefined ? state.head : { seq: after.seq, hash: await entryHash(after) };
  return signEntry(signer, { seq: head.seq + 1, prev: head.hash, op, subject });
}

async function apply(state: MemberChainState, ...entries: unknown[]) {
  return applyMemberChainEntries(state, entries);
}

async function applied(state: MemberChainState, ...entries: unknown[]): Promise<MemberChainState> {
  const result = await apply(state, ...entries);
  if (!result.ok) throw new Error(`expected the entries to apply, got ${result.reason} at ${result.index}`);
  return result.state;
}

function sorted(...members: Member[]): string[] {
  return members.map((member) => member.bundle.memberId).sort();
}

describe('member key bundle', () => {
  it('parses a device bundle and a client bundle', async () => {
    const device = await newMember('device-1');
    const client = await newMember();
    await expect(parseMemberKeyBundle(bundleJson(device.bundle))).resolves.toEqual(device.bundle);
    await expect(parseMemberKeyBundle(bundleJson(client.bundle))).resolves.toEqual(client.bundle);
  });

  it('rejects a bundle whose id, keys or shape is wrong', async () => {
    const { bundle } = await newMember('device-1');
    const other = await newMember();
    for (const bad of [
      { ...bundle, memberId: other.bundle.memberId },
      { ...bundle, kemPublicJwk: bundle.signingPublicJwk },
      { ...bundle, kemPublicJwk: { ...bundle.kemPublicJwk, x: 'A'.repeat(43), y: 'A'.repeat(43) } },
      { ...bundle, v: 2 },
      { ...bundle, kemEpoch: 0 },
      { ...bundle, deviceId: '' },
      { ...bundle, extra: true },
      'not an object',
    ]) {
      await expect(parseMemberKeyBundle(bad)).resolves.toBeUndefined();
    }
  });
});

describe('pairing MACs', () => {
  it('pins the MAC input bytes: a domain tag and the canonical JSON of the named fields', async () => {
    const pv = generatePairingVerificationSecret();
    const device = await newMember('device-1');
    const client = await newMember();
    const head = { seq: 2, hash: `sha256:${'ab'.repeat(32)}` };
    const jwk = (key: P256PublicJwk) => `{"crv":"P-256","kty":"EC","x":"${key.x}","y":"${key.y}"}`;
    const bundleText = (b: MemberKeyBundleV1) =>
      `{${b.deviceId === undefined ? '' : `"deviceId":"${b.deviceId}",`}"kemEpoch":${b.kemEpoch},"kemPublicJwk":${jwk(b.kemPublicJwk)},`
      + `"memberId":"${b.memberId}","signingPublicJwk":${jwk(b.signingPublicJwk)},"v":1}`;
    const hmac = (text: string) => createHmac('sha256', pv).update(text, 'utf8').digest('base64url');

    await expect(computeDevicePairingMac(pv, { tenantId: TENANT, deviceId: 'device-1', member: device.bundle })).resolves.toBe(
      hmac(`${DEVICE_PAIRING_MAC_DOMAIN}{"deviceId":"device-1","member":${bundleText(device.bundle)},"tenantId":"${TENANT}"}`),
    );
    await expect(computeClientPairingMac(pv, { member: client.bundle, chainHead: head })).resolves.toBe(
      hmac(`${CLIENT_PAIRING_MAC_DOMAIN}{"chainHead":{"hash":"${head.hash}","seq":2},"member":${bundleText(client.bundle)}}`),
    );
  });

  it('verifies the device MAC only for the same pv, tenant, device and bundle', async () => {
    const pv = generatePairingVerificationSecret();
    const device = await newMember('device-1');
    const input = { tenantId: TENANT, deviceId: 'device-1', member: device.bundle };
    const mac = await computeDevicePairingMac(pv, input);
    await expect(verifyDevicePairingMac(pv, input, mac)).resolves.toBe(true);

    const swapped = await newMember('device-1');
    for (const [key, changed] of [
      ['pv', [generatePairingVerificationSecret(), input]],
      ['tenant', [pv, { ...input, tenantId: 'tenant-2' }]],
      ['bundle', [pv, { ...input, member: swapped.bundle }]],
      ['kem', [pv, { ...input, member: { ...device.bundle, kemPublicJwk: swapped.bundle.kemPublicJwk } }]],
      ['device id', [pv, { ...input, deviceId: 'device-2', member: { ...device.bundle, deviceId: 'device-2' } }]],
      ['mismatched device id', [pv, { ...input, deviceId: 'device-2' }]],
    ] as const) {
      await expect(verifyDevicePairingMac(changed[0], changed[1], mac), key).resolves.toBe(false);
    }
    for (const bad of [undefined, 42, '', mac.slice(1), `${mac}A`, mac.replace(/.$/u, mac.endsWith('A') ? 'B' : 'A')]) {
      await expect(verifyDevicePairingMac(pv, input, bad)).resolves.toBe(false);
    }
    await expect(computeDevicePairingMac(pv, { ...input, deviceId: 'device-2' })).rejects.toMatchObject({ code: 'sealed_secret_invalid' });
  });

  it('verifies the client MAC only for the same pv, bundle and chain head, and never as a device MAC', async () => {
    const pv = generatePairingVerificationSecret();
    const client = await newMember();
    const head = { seq: 2, hash: `sha256:${'ab'.repeat(32)}` };
    const mac = await computeClientPairingMac(pv, { member: client.bundle, chainHead: head });
    await expect(verifyClientPairingMac(pv, { member: client.bundle, chainHead: head }, mac)).resolves.toBe(true);
    await expect(verifyClientPairingMac(pv, { member: client.bundle, chainHead: { ...head, seq: 3 } }, mac)).resolves.toBe(false);
    await expect(verifyClientPairingMac(pv, { member: client.bundle, chainHead: { ...head, hash: `sha256:${'cd'.repeat(32)}` } }, mac))
      .resolves.toBe(false);
    await expect(verifyClientPairingMac(pv, { member: client.bundle, chainHead: { seq: 0, hash: 'x' } }, mac)).resolves.toBe(false);
    await expect(verifyClientPairingMac(pv, { member: { ...client.bundle, deviceId: 'device-1' }, chainHead: head }, mac))
      .resolves.toBe(false);

    // Domain separation: a device MAC over a bundle never verifies as a client MAC, and back.
    const device = await newMember('device-1');
    const deviceMac = await computeDevicePairingMac(pv, { tenantId: TENANT, deviceId: 'device-1', member: device.bundle });
    await expect(verifyClientPairingMac(pv, { member: client.bundle, chainHead: head }, deviceMac)).resolves.toBe(false);
    await expect(verifyDevicePairingMac(pv, { tenantId: TENANT, deviceId: 'device-1', member: device.bundle }, mac)).resolves.toBe(false);
  });
});

describe('member chain walk', () => {
  it('applies add, scope-policy, rotate and remove after a trusted state', async () => {
    const client = await newMember();
    const device = await newMember('device-1');
    const start = await trustedStart(client);

    const add = await next(start, client, 'add', { member: bundleJson(device.bundle) });
    const policy = await next(start, client, 'scope-policy', {
      scopeId: 'scope-device-1',
      categories: ['task-input', 'task-output'],
      members: sorted(client, device),
    }, add);
    const newKem = await kemJwk();
    const rotate = await next(start, device, 'rotate', { memberId: device.bundle.memberId, kemPublicJwk: { ...newKem }, kemEpoch: 2 }, policy);
    const state = await applied(start, add, policy, rotate);

    expect(state.head).toEqual({ seq: 4, hash: await entryHash(rotate) });
    expect(state.members.get(device.bundle.memberId)).toMatchObject({ kemEpoch: 2, kemPublicJwk: newKem, deviceId: 'device-1' });
    expect(state.scopes.get('scope-device-1')).toEqual({ categories: ['task-input', 'task-output'], members: sorted(client, device), policySeq: 3 });
    expect(memberChainScopeRecipients(state, 'scope-device-1').map((member) => member.memberId).sort()).toEqual(sorted(client, device));
    expect(start.members.size).toBe(1);

    const removed = await applied(state, await next(state, client, 'remove', { memberId: device.bundle.memberId }));
    expect(removed.members.has(device.bundle.memberId)).toBe(false);
    expect(removed.removed.has(device.bundle.memberId)).toBe(true);
    // The policy still lists the removed member, but it gets no key package.
    expect(removed.scopes.get('scope-device-1')?.members).toEqual(sorted(client, device));
    expect(memberChainScopeRecipients(removed, 'scope-device-1').map((member) => member.memberId)).toEqual([client.bundle.memberId]);
  });

  it('starts nowhere from an empty member set, because the genesis rule is not decided', async () => {
    const client = await newMember();
    const genesis = await signEntry(client, { seq: 1, prev: null, op: 'add', subject: { member: bundleJson(client.bundle) } });
    const empty: MemberChainState = {
      tenantId: TENANT,
      head: { seq: 0, hash: `sha256:${'0'.repeat(64)}` },
      members: new Map(),
      removed: new Set(),
      scopes: new Map(),
      shredded: new Set(),
    };
    await expect(apply(empty, genesis)).resolves.toEqual({ ok: false, reason: 'member_chain_signer_invalid', index: 0 });
  });

  it('rejects an entry that is not the next link', async () => {
    const client = await newMember();
    const device = await newMember('device-1');
    const start = await trustedStart(client);
    const subject = { member: bundleJson(device.bundle) };
    for (const entry of [
      await signEntry(client, { seq: 2, prev: start.head.hash, op: 'add', subject, tenantId: 'tenant-2' }),
      await signEntry(client, { seq: 3, prev: start.head.hash, op: 'add', subject }),
      await signEntry(client, { seq: 2, prev: `sha256:${'0'.repeat(64)}`, op: 'add', subject }),
    ]) {
      await expect(apply(start, entry)).resolves.toEqual({ ok: false, reason: 'member_chain_link_invalid', index: 0 });
    }
  });

  it('rejects a malformed entry, an unknown or removed signer, and a bad signature', async () => {
    const client = await newMember();
    const device = await newMember('device-1');
    const outsider = await newMember();
    const start = await trustedStart(client);
    const add = await next(start, client, 'add', { member: bundleJson(device.bundle) });

    for (const bad of [null, 'entry', { ...add, signer: 'short' }, { ...add, sig: undefined }]) {
      await expect(apply(start, bad)).resolves.toMatchObject({ ok: false, reason: 'member_chain_entry_invalid', index: 0 });
    }
    await expect(apply(start, await next(start, outsider, 'add', { member: bundleJson(device.bundle) })))
      .resolves.toEqual({ ok: false, reason: 'member_chain_signer_invalid', index: 0 });
    await expect(apply(start, { ...add, subject: { member: bundleJson(outsider.bundle) } }))
      .resolves.toEqual({ ok: false, reason: 'member_chain_signature_invalid', index: 0 });

    // A removed member can no longer sign.
    const withDevice = await applied(start, add);
    const removeDevice = await next(withDevice, client, 'remove', { memberId: device.bundle.memberId });
    const afterRemove = await applied(withDevice, removeDevice);
    await expect(apply(afterRemove, await next(afterRemove, device, 'add', { member: bundleJson(outsider.bundle) })))
      .resolves.toEqual({ ok: false, reason: 'member_chain_signer_invalid', index: 0 });
  });

  it('enforces the add, remove and rotate rules', async () => {
    const client = await newMember();
    const device = await newMember('device-1');
    const start = await trustedStart(client);
    const withDevice = await applied(start, await next(start, client, 'add', { member: bundleJson(device.bundle) }));
    const removedDevice = await applied(withDevice, await next(withDevice, client, 'remove', { memberId: device.bundle.memberId }));
    const kem = await kemJwk();
    const rejected = async (state: MemberChainState, signer: Member, op: MemberChainOp, subject: JsonObject) =>
      expect(apply(state, await next(state, signer, op, subject))).resolves.toEqual({ ok: false, reason: 'member_chain_subject_invalid', index: 0 });

    await rejected(withDevice, client, 'add', { member: bundleJson(device.bundle) });
    await rejected(removedDevice, client, 'add', { member: bundleJson(device.bundle) });
    await rejected(start, client, 'add', { member: bundleJson({ ...device.bundle, kemPublicJwk: device.bundle.signingPublicJwk }) });
    await rejected(start, client, 'add', { member: bundleJson(device.bundle), extra: true });
    await rejected(start, client, 'remove', { memberId: device.bundle.memberId });
    await rejected(removedDevice, client, 'remove', { memberId: device.bundle.memberId });
    // Only the member itself rotates its KEM key, to exactly the next epoch.
    await rejected(withDevice, client, 'rotate', { memberId: device.bundle.memberId, kemPublicJwk: { ...kem }, kemEpoch: 2 });
    await rejected(withDevice, device, 'rotate', { memberId: device.bundle.memberId, kemPublicJwk: { ...kem }, kemEpoch: 3 });
    await rejected(withDevice, device, 'rotate', { memberId: device.bundle.memberId, kemPublicJwk: { ...kem }, kemEpoch: 1 });
    await rejected(withDevice, device, 'rotate', {
      memberId: device.bundle.memberId,
      kemPublicJwk: { ...device.bundle.signingPublicJwk },
      kemEpoch: 2,
    });
  });

  it('enforces the scope-policy and shred rules', async () => {
    const client = await newMember();
    const device = await newMember('device-1');
    const outsider = await newMember();
    const start = await trustedStart(client);
    const state = await applied(start, await next(start, client, 'add', { member: bundleJson(device.bundle) }));
    const members = sorted(client, device);
    const policy = (overrides: JsonObject) => ({ scopeId: 'scope-1', categories: ['task-input'], members, ...overrides });
    const rejected = async (from: MemberChainState, op: MemberChainOp, subject: JsonObject) =>
      expect(apply(from, await next(from, client, op, subject))).resolves.toEqual({ ok: false, reason: 'member_chain_subject_invalid', index: 0 });

    await rejected(state, 'scope-policy', policy({ members: [...members].reverse() }));
    await rejected(state, 'scope-policy', policy({ members: [members[0]!, members[0]!] }));
    await rejected(state, 'scope-policy', policy({ members: [] }));
    await rejected(state, 'scope-policy', policy({ members: [...members, outsider.bundle.memberId].sort() }));
    await rejected(state, 'scope-policy', policy({ categories: ['task-output', 'task-input'] }));
    await rejected(state, 'scope-policy', policy({ categories: ['task-input', 'task-input'] }));
    await rejected(state, 'scope-policy', policy({ categories: [] }));
    await rejected(state, 'scope-policy', policy({ categories: ['drafts'] }));
    await rejected(state, 'scope-policy', policy({ scopeId: '' }));
    await rejected(state, 'shred', { scopeId: 'scope-1' });

    const withScope = await applied(state, await next(state, client, 'scope-policy', policy({})));
    // A later policy replaces the earlier one.
    const narrowed = await applied(withScope, await next(withScope, client, 'scope-policy', policy({ members: [client.bundle.memberId] })));
    expect(narrowed.scopes.get('scope-1')).toEqual({ categories: ['task-input'], members: [client.bundle.memberId], policySeq: 4 });

    const shredded = await applied(narrowed, await next(narrowed, client, 'shred', { scopeId: 'scope-1' }));
    expect(shredded.scopes.has('scope-1')).toBe(false);
    expect(shredded.shredded.has('scope-1')).toBe(true);
    expect(memberChainScopeRecipients(shredded, 'scope-1')).toEqual([]);
    await rejected(shredded, 'scope-policy', policy({}));
    await rejected(shredded, 'shred', { scopeId: 'scope-1' });
  });

  it('rejects the whole batch when one entry fails, and names its index', async () => {
    const client = await newMember();
    const device = await newMember('device-1');
    const start = await trustedStart(client);
    const add = await next(start, client, 'add', { member: bundleJson(device.bundle) });
    const badRemove = await next(start, client, 'remove', { memberId: (await newMember()).bundle.memberId }, add);
    await expect(apply(start, add, badRemove)).resolves.toEqual({ ok: false, reason: 'member_chain_subject_invalid', index: 1 });
    expect(start.members.size).toBe(1);
    expect(start.head.seq).toBe(1);
  });
});
