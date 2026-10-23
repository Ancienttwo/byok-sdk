/**
 * The E2EE member control plane (#654 E2c): shape and tenant checks, the
 * first-writer rules as Host errors, and fail-closed behavior without a store.
 */
import { canonicalizeJson, createMutableClock, type JsonValue, type TenantId } from '@byok-sdk/core';
import {
  createMemberKeyBundle,
  generateScopeKey,
  memberChainEntryHash,
  sealScopeKeyPackage,
  signMemberChainEntry,
  type MemberChainEntryV1,
  type MemberKeyBundleV1,
} from '@byok-sdk/core/sealed-payload';
import { E2EE_MEMBER_CHAIN_APPEND_MAX_ENTRIES } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { PAIRING_CODE_TTL_MS } from '../auth/plane';
import { createHmacTokenSigner } from '../auth/tokens';
import { fullCapabilityDeclaration } from '../capabilities';
import { createByokCloud, type ByokCloud } from '../cloud';
import { createInMemoryByokCloud } from '../composition/in-memory';
import { isCloudError } from '../errors';
import { InMemoryE2eeMemberStore } from '../stores/in-memory/e2ee-member';
import { TENANT_A, TENANT_B } from './support/harness';

type Jwk = MemberKeyBundleV1['signingPublicJwk'];
type CryptoKey = Parameters<typeof createMemberKeyBundle>[0]['signingPrivateKey'];

interface Member {
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

async function newMember(deviceId?: string): Promise<Member> {
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

async function chain(tenant: TenantId, signer: Member, length: number): Promise<MemberChainEntryV1[]> {
  const entries: MemberChainEntryV1[] = [];
  let prev: string | null = null;
  for (let seq = 1; seq <= length; seq += 1) {
    const unsigned = { v: 1 as const, tenantId: tenant, seq, prev, op: 'add' as const, subject: { member: signer.bundle as unknown as JsonValue, seq }, signer: signer.bundle.memberId };
    entries.push(await signMemberChainEntry(unsigned, signer.signer));
    prev = await memberChainEntryHash(unsigned);
  }
  return entries;
}

async function keyPackage(tenant: TenantId, sender: Member, recipient: Member, epoch: number, scopeKey = generateScopeKey()) {
  return sealScopeKeyPackage({
    scopeKey,
    tenantId: tenant,
    scopeId: 'scope-1',
    epoch,
    recipient: { memberId: recipient.bundle.memberId, kemPublicJwk: recipient.bundle.kemPublicJwk },
    sender: { signingPublicJwk: sender.signer.publicJwk, signingPrivateKey: sender.signer.privateKey },
  });
}

function setup(withStore = true) {
  const clock = createMutableClock();
  const base = createInMemoryByokCloud({ clock });
  const store = new InMemoryE2eeMemberStore();
  const cloud: ByokCloud = createByokCloud({
    core: base.core,
    cloud: base.stores,
    mailboxWake: base.mailboxWake,
    blobContentProxy: base.blobContentProxy,
    crypto: base.crypto,
    tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(7), clock),
    clock,
    capabilities: fullCapabilityDeclaration(),
    ...(withStore ? { e2eeMemberStore: store } : {}),
  });
  const registerDevice = (tenant: TenantId, deviceId: string) => base.stores.devices.register(tenant, {
    productId: 'product', deviceId, deviceName: deviceId, devicePublicKey: `${deviceId}-key`, proofKeyId: 'identity', proofKeyEpoch: 0,
  });
  return { cloud, store, clock, base, registerDevice };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isCloudError(error)) return error.code;
    throw error;
  }
  throw new Error('expected a cloud error');
}

describe('E2EE member control plane', () => {
  it('fails closed on every call when the deployment has no store', async () => {
    const { cloud } = setup(false);
    const calls: Promise<unknown>[] = [
      cloud.appendMemberChainEntries(TENANT_A, { entries: [] }),
      cloud.readMemberChain(TENANT_A),
      cloud.putScopeKeyPackages(TENANT_A, { packages: [] }),
      cloud.readScopeKeyPackages(TENANT_A, { scopeId: 'scope-1' }),
      cloud.readMemberKeyRegistration(TENANT_A, 'device-1'),
      cloud.relayClientPairingMac(TENANT_A, 'device-1', {} as never),
    ];
    for (const call of calls) expect(await code(call)).toBe('e2ee_member_store_unavailable');
  });

  it('appends signed entries, replays them, and returns the same values', async () => {
    const { cloud } = setup();
    const client = await newMember();
    const entries = await chain(TENANT_A, client, 3);
    expect(await cloud.appendMemberChainEntries(TENANT_A, { entries: entries.slice(0, 2) })).toEqual({ appended: 2, replayed: 0 });
    expect(await cloud.appendMemberChainEntries(TENANT_A, { entries })).toEqual({ appended: 1, replayed: 2 });
    expect(await cloud.readMemberChain(TENANT_A)).toEqual({ entries });
    expect(await cloud.readMemberChain(TENANT_A, { afterSeq: 1, limit: 1 })).toEqual({ entries: [entries[1]] });
    expect(await cloud.readMemberChain(TENANT_B)).toEqual({ entries: [] });
  });

  it('turns a taken seq and a gap into one chain conflict code', async () => {
    const { cloud } = setup();
    const client = await newMember();
    const other = await newMember();
    const entries = await chain(TENANT_A, client, 3);
    await cloud.appendMemberChainEntries(TENANT_A, { entries: entries.slice(0, 1) });
    expect(await code(cloud.appendMemberChainEntries(TENANT_A, { entries: (await chain(TENANT_A, other, 1)) }))).toBe('e2ee_member_chain_conflict');
    expect(await code(cloud.appendMemberChainEntries(TENANT_A, { entries: entries.slice(2) }))).toBe('e2ee_member_chain_conflict');
    expect((await cloud.readMemberChain(TENANT_A)).entries).toEqual(entries.slice(0, 1));
  });

  it('refuses malformed, foreign-tenant, unordered, empty and oversized appends', async () => {
    const { cloud } = setup();
    const client = await newMember();
    const entries = await chain(TENANT_A, client, 3);
    const refused = [
      [],
      [{ ...entries[0]!, sig: 'not-base64url' }],
      [{ ...entries[0]!, extra: true }],
      await chain(TENANT_B, client, 1),
      [entries[0]!, entries[2]!],
      [entries[1]!, entries[0]!],
      Array.from({ length: E2EE_MEMBER_CHAIN_APPEND_MAX_ENTRIES + 1 }, () => entries[0]!),
      [{ ...entries[0]!, subject: { padding: 'x'.repeat(65_536) } }],
      [{ ...entries[0]!, subject: { value: Number.NaN } }],
    ];
    for (const input of refused) {
      expect(await code(cloud.appendMemberChainEntries(TENANT_A, { entries: input as MemberChainEntryV1[] }))).toBe('coordination_input_invalid');
    }
    expect((await cloud.readMemberChain(TENANT_A)).entries).toEqual([]);
  });

  it('reads caller data once and refuses data that throws', async () => {
    const { cloud } = setup();
    const [genesis] = await chain(TENANT_A, await newMember(), 1);
    const throwing = { ...genesis!, get subject(): never { throw new Error('hostile getter'); } };
    let reads = 0;
    const changing = { ...genesis!, get op() { reads += 1; return reads === 1 ? 'add' : 'shred'; } };
    expect(await code(cloud.appendMemberChainEntries(TENANT_A, { entries: [throwing as never] }))).toBe('coordination_input_invalid');
    expect(await code(cloud.appendMemberChainEntries(TENANT_A, { entries: [new Proxy(genesis!, { get() { throw new Error('trap'); } })] })))
      .toBe('coordination_input_invalid');
    // The second read would see another op. The stored entry is the first read.
    expect(await cloud.appendMemberChainEntries(TENANT_A, { entries: [changing as never] })).toEqual({ appended: 1, replayed: 0 });
    expect(reads).toBe(1);
    expect((await cloud.readMemberChain(TENANT_A)).entries).toEqual([genesis]);
  });

  it('stores key packages under one keyId per scope epoch and returns them unchanged', async () => {
    const { cloud } = setup();
    const sender = await newMember();
    const device = await newMember('device-1');
    const key = generateScopeKey();
    const first = await keyPackage(TENANT_A, sender, sender, 1, key);
    const second = await keyPackage(TENANT_A, sender, device, 1, key);
    expect(await cloud.putScopeKeyPackages(TENANT_A, { packages: [first, second] })).toEqual({ stored: 2 });
    expect(await code(cloud.putScopeKeyPackages(TENANT_A, { packages: [await keyPackage(TENANT_A, sender, device, 1)] })))
      .toBe('e2ee_scope_key_conflict');
    // A re-wrap of the same scope key replaces the recipient's package.
    const rewrapped = await keyPackage(TENANT_A, sender, device, 1, key);
    expect(await cloud.putScopeKeyPackages(TENANT_A, { packages: [rewrapped] })).toEqual({ stored: 1 });
    const stored = await cloud.readScopeKeyPackages(TENANT_A, { scopeId: 'scope-1' });
    expect(stored.packages).toHaveLength(2);
    expect(stored.packages).toContainEqual(first);
    expect(stored.packages).toContainEqual(rewrapped);
    expect(await cloud.readScopeKeyPackages(TENANT_A, { scopeId: 'scope-1', recipient: device.bundle.memberId })).toEqual({ packages: [rewrapped] });
    expect(await cloud.readScopeKeyPackages(TENANT_B, { scopeId: 'scope-1' })).toEqual({ packages: [] });
  });

  it('refuses malformed, foreign-tenant and self-contradicting package puts', async () => {
    const { cloud } = setup();
    const sender = await newMember();
    const device = await newMember('device-1');
    const one = await keyPackage(TENANT_A, sender, device, 1);
    const refused = [
      [],
      [{ ...one, epoch: 0 }],
      [{ ...one, keyId: 'short' }],
      [await keyPackage(TENANT_B, sender, device, 1)],
      [one, await keyPackage(TENANT_A, sender, sender, 1)],
      [one, one],
    ];
    for (const input of refused) {
      expect(await code(cloud.putScopeKeyPackages(TENANT_A, { packages: input as never }))).toBe('coordination_input_invalid');
    }
    expect(await code(cloud.readScopeKeyPackages(TENANT_A, { scopeId: '' }))).toBe('coordination_input_invalid');
    expect(await code(cloud.readScopeKeyPackages(TENANT_A, { scopeId: 'scope-1', epoch: 0 }))).toBe('coordination_input_invalid');
    expect(await cloud.readScopeKeyPackages(TENANT_A, { scopeId: 'scope-1' })).toEqual({ packages: [] });
  });

  it('returns a registration only for an active device, with its MAC inside the pairing window', async () => {
    const { cloud, store, clock, registerDevice, base } = setup();
    const device = await newMember('device-1');
    await registerDevice(TENANT_A, 'device-1');
    expect(await cloud.readMemberKeyRegistration(TENANT_A, 'device-1')).toBeUndefined();
    await store.registerMember(TENANT_A, {
      deviceId: 'device-1', memberId: device.bundle.memberId, bundle: canonicalizeJson(device.bundle as unknown as JsonValue),
      deviceMac: 'device-mac', macExpiresAt: new Date(clock.now().getTime() + PAIRING_CODE_TTL_MS).toISOString(),
    });
    expect(await cloud.readMemberKeyRegistration(TENANT_A, 'device-1')).toEqual({ member: device.bundle, deviceMac: 'device-mac' });
    clock.advance(PAIRING_CODE_TTL_MS);
    expect(await cloud.readMemberKeyRegistration(TENANT_A, 'device-1')).toEqual({ member: device.bundle });
    expect(await cloud.readMemberKeyRegistration(TENANT_B, 'device-1')).toBeUndefined();
    await base.stores.devices.revoke(TENANT_A, 'device-1');
    expect(await cloud.readMemberKeyRegistration(TENANT_A, 'device-1')).toBeUndefined();
  });

  it('relays a client MAC only to a registered active device, for one pairing window', async () => {
    const { cloud, store, clock, registerDevice } = setup();
    const client = await newMember();
    const device = await newMember('device-1');
    const relay = { mac: 'A'.repeat(42) + 'E', member: client.bundle, chainHead: { seq: 2, hash: `sha256:${'0'.repeat(64)}` } };
    expect(await code(cloud.relayClientPairingMac(TENANT_A, 'device-1', relay))).toBe('device_not_found');
    await registerDevice(TENANT_A, 'device-1');
    expect(await code(cloud.relayClientPairingMac(TENANT_A, 'device-1', relay))).toBe('e2ee_member_not_registered');
    await store.registerMember(TENANT_A, {
      deviceId: 'device-1', memberId: device.bundle.memberId, bundle: canonicalizeJson(device.bundle as unknown as JsonValue),
      deviceMac: 'device-mac', macExpiresAt: clock.now().toISOString(),
    });
    expect(await code(cloud.relayClientPairingMac(TENANT_A, 'device-1', { ...relay, member: device.bundle }))).toBe('coordination_input_invalid');
    expect(await code(cloud.relayClientPairingMac(TENANT_A, 'device-1', { ...relay, mac: 'A'.repeat(42) + 'B' }))).toBe('coordination_input_invalid');
    await cloud.relayClientPairingMac(TENANT_A, 'device-1', relay);
    const now = () => clock.now().toISOString();
    expect(await store.readClientPairingMac(TENANT_A, { deviceId: 'device-1', now: now() })).toBe(canonicalizeJson(relay as unknown as JsonValue));
    clock.advance(PAIRING_CODE_TTL_MS);
    expect(await store.readClientPairingMac(TENANT_A, { deviceId: 'device-1', now: now() })).toBeUndefined();
  });
});
