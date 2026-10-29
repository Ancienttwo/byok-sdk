/**
 * The E2EE member control plane (#654 E2c): shape and tenant checks, the
 * first-writer rules as Host errors, and fail-closed behavior without a store.
 */
import { canonicalizeJson, createMutableClock, type JsonValue, type TenantId } from '@byok-sdk/core';
import { generateScopeKey, type MemberChainEntryV1 } from '@byok-sdk/core/sealed-payload';
import { E2EE_MEMBER_CHAIN_APPEND_MAX_ENTRIES, E2EE_SCOPE_ID_MAX_LENGTH } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { PAIRING_CODE_TTL_MS } from '../auth/plane';
import { createHmacTokenSigner } from '../auth/tokens';
import { fullCapabilityDeclaration } from '../capabilities';
import { createByokCloud, type ByokCloud } from '../cloud';
import { createInMemoryByokCloud } from '../composition/in-memory';
import { E2EE_SCOPE_SHRED_RECEIPT_PREFIX } from '../e2ee-member';
import { isCloudError } from '../errors';
import { RECEIPT_RETENTION } from '../receipt-retention';
import { InMemoryE2eeMemberStore } from '../stores/in-memory/e2ee-member';
import type { RequestReceiptStore } from '../stores/ports';
import { chain, keyPackage, newMember, signedChain } from './support/e2ee-members';
import { applyMemberChainEntries, emptyMemberChainState } from '@byok-sdk/core/sealed-payload';
import { TENANT_A, TENANT_B, createHarness } from './support/harness';

function setup(withStore = true, makeStore = (receipts: RequestReceiptStore) => new InMemoryE2eeMemberStore(receipts)) {
  const clock = createMutableClock();
  const base = createInMemoryByokCloud({ clock });
  const store = makeStore(base.stores.receipts);
  const cloud: ByokCloud = createByokCloud({
    core: base.core,
    cloud: base.stores,
    mailboxWake: base.mailboxWake,
    blobContentProxy: base.blobContentProxy,
    crypto: base.crypto,
    tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(7), clock),
    clock,
    capabilities: fullCapabilityDeclaration(1, { includeE2eeMember: withStore }),
    ...(withStore ? { e2eeMemberStore: store } : {}),
  });
  const registerDevice = (tenant: TenantId, deviceId: string, machineId?: string) => base.stores.devices.register(tenant, {
    productId: 'product', deviceId, deviceName: deviceId, devicePublicKey: `${deviceId}-key`, proofKeyId: 'identity', proofKeyEpoch: 0,
    ...(machineId === undefined ? {} : { machineId }),
  });
  return { cloud, store, clock, base, registerDevice };
}

let requests = 0;
/** A device-proof binding with a requestId no other write has used. */
const freshRequest = () => ({ requestId: `request-${++requests}`, operation: 'e2ee-member-key.register', resource: '/byok/e2ee/member-key', bodySha256: 'sha256', bodySize: 1 });
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

  it('shreds a scope on append: deletes its packages, writes the receipt, refuses later puts', async () => {
    const { cloud, base, clock } = setup();
    const client = await newMember();
    const member = client.bundle.memberId;
    const entries = await signedChain(TENANT_A, client, [
      { op: 'add', subject: { member: client.bundle as unknown as JsonValue } },
      { op: 'scope-policy', subject: { scopeId: 'scope-1', categories: ['task-input'], members: [member] } },
      { op: 'shred', subject: { scopeId: 'scope-1' } },
    ]);
    // Core walks the same entries: the shape the Host reads is the one members sign.
    const walked = await applyMemberChainEntries(emptyMemberChainState(TENANT_A), entries);
    expect(walked.ok && walked.state.shredded.has('scope-1')).toBe(true);
    await cloud.putScopeKeyPackages(TENANT_A, { packages: [await keyPackage(TENANT_A, client, client, 1)] });
    await cloud.putScopeKeyPackages(TENANT_B, { packages: [await keyPackage(TENANT_B, client, client, 1)] });

    expect(await cloud.appendMemberChainEntries(TENANT_A, { entries: entries.slice(0, 2) })).toEqual({ appended: 2, replayed: 0 });
    expect((await cloud.readScopeKeyPackages(TENANT_A, { scopeId: 'scope-1' })).packages).toHaveLength(1);
    expect(await cloud.appendMemberChainEntries(TENANT_A, { entries })).toEqual({ appended: 1, replayed: 2 });

    expect(await cloud.readScopeKeyPackages(TENANT_A, { scopeId: 'scope-1' })).toEqual({ packages: [] });
    expect(JSON.parse((await base.stores.receipts.get(TENANT_A, 'e2ee-scope-shred:scope-1'))!.body))
      .toEqual({ chainSeq: 3, shreddedAt: clock.now().toISOString(), writer: { kind: 'host' } });
    expect(await code(cloud.putScopeKeyPackages(TENANT_A, { packages: [await keyPackage(TENANT_A, client, client, 2)] })))
      .toBe('e2ee_scope_shredded');
    expect((await cloud.readScopeKeyPackages(TENANT_B, { scopeId: 'scope-1' })).packages).toHaveLength(1);
  });

  it('stores a shred of a scope id over the Host limit and records nothing for it', async () => {
    const { cloud, base, store } = setup();
    const client = await newMember();
    const scopeId = 's'.repeat(E2EE_SCOPE_ID_MAX_LENGTH + 1);
    const entries = await signedChain(TENANT_A, client, [
      { op: 'add', subject: { member: client.bundle as unknown as JsonValue } },
      { op: 'shred', subject: { scopeId } },
    ]);
    const appends: Parameters<typeof store.appendChainEntries>[1][] = [];
    const append = store.appendChainEntries.bind(store);
    store.appendChainEntries = async (tenant, input) => {
      appends.push(input);
      return append(tenant, input);
    };
    expect(await cloud.appendMemberChainEntries(TENANT_A, { entries })).toEqual({ appended: 2, replayed: 0 });
    expect(appends.map((input) => input.shreds)).toEqual([[]]);
    expect(await base.stores.receipts.get(TENANT_A, `${E2EE_SCOPE_SHRED_RECEIPT_PREFIX}${scopeId}`)).toBeUndefined();
    expect((await cloud.readMemberChain(TENANT_A)).entries).toEqual(entries);
  });

  it('raises the member KEM floor on a rotate and refuses a package wrapped below it', async () => {
    const { cloud, store } = setup();
    const client = await newMember();
    const member = client.bundle.memberId;
    const rotate = { memberId: member, kemPublicJwk: client.bundle.kemPublicJwk, kemEpoch: 2, kemSig: client.bundle.kemSig };
    const entries = await signedChain(TENANT_A, client, [
      { op: 'add', subject: { member: client.bundle as unknown as JsonValue } },
      { op: 'rotate', subject: rotate as never },
    ]);
    const appends: Parameters<typeof store.appendChainEntries>[1][] = [];
    const append = store.appendChainEntries.bind(store);
    store.appendChainEntries = async (tenant, input) => {
      appends.push(input);
      return append(tenant, input);
    };
    for (const subject of [{ ...rotate, extra: true }, { ...rotate, kemEpoch: 0 }, { memberId: member, kemEpoch: 2 }]) {
      const refused = await signedChain(TENANT_A, client, [entries[0]!, { op: 'rotate', subject: subject as never }]);
      expect(await code(cloud.appendMemberChainEntries(TENANT_A, { entries: refused }))).toBe('coordination_input_invalid');
    }
    expect(await cloud.appendMemberChainEntries(TENANT_A, { entries })).toEqual({ appended: 2, replayed: 0 });
    expect(appends.map(input => input.rotations)).toEqual([[{ seq: 2, memberId: member, kemEpoch: 2 }]]);
    const stale = await keyPackage(TENANT_A, client, client, 1);
    expect(stale.recipientKemEpoch).toBe(1);
    expect(await code(cloud.putScopeKeyPackages(TENANT_A, { packages: [stale] }))).toBe('e2ee_scope_key_package_stale');
    expect(await cloud.readScopeKeyPackages(TENANT_A, { scopeId: 'scope-1' })).toEqual({ packages: [] });
    // Another tenant's member of the same id has no floor.
    expect(await cloud.putScopeKeyPackages(TENANT_B, { packages: [await keyPackage(TENANT_B, client, client, 1)] }))
      .toEqual({ stored: 1, skippedDeviceIds: [] });
  });

  it('refuses a version 1 package put as invalid input', async () => {
    const { cloud } = setup();
    const sender = await newMember();
    const { recipientKemEpoch: _, ...v1 } = { ...(await keyPackage(TENANT_A, sender, sender, 1)), v: 1 };
    expect(await code(cloud.putScopeKeyPackages(TENANT_A, { packages: [v1 as never] }))).toBe('coordination_input_invalid');
    expect(await cloud.readScopeKeyPackages(TENANT_A, { scopeId: 'scope-1' })).toEqual({ packages: [] });
  });

  it('files the shred receipt as an identity receipt that never expires', () => {
    expect(RECEIPT_RETENTION).toContainEqual({ prefix: E2EE_SCOPE_SHRED_RECEIPT_PREFIX, class: 'identity' });
  });

  it('refuses a shred whose subject is not exactly { scopeId }', async () => {
    const { cloud } = setup();
    const client = await newMember();
    for (const subject of [{}, { scopeId: '' }, { scopeId: 1 }, { scopeId: 'scope-1', extra: true }, { member: client.bundle as unknown as JsonValue }]) {
      const entries = await signedChain(TENANT_A, client, [
        { op: 'add', subject: { member: client.bundle as unknown as JsonValue } },
        { op: 'shred', subject: subject as never },
      ]);
      expect(await code(cloud.appendMemberChainEntries(TENANT_A, { entries }))).toBe('coordination_input_invalid');
    }
    expect((await cloud.readMemberChain(TENANT_A)).entries).toEqual([]);
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
    // A hostile list, a hostile field getter and a hostile query object fail as input, not as a raw throw.
    const trap = <T extends object>(target: T) => new Proxy(target, { get() { throw new Error('trap'); } });
    expect(await code(cloud.appendMemberChainEntries(TENANT_A, { entries: trap([genesis!]) }))).toBe('coordination_input_invalid');
    expect(await code(cloud.appendMemberChainEntries(TENANT_A, { get entries(): never { throw new Error('getter'); } })))
      .toBe('coordination_input_invalid');
    expect(await code(cloud.putScopeKeyPackages(TENANT_A, { packages: trap([]) }))).toBe('coordination_input_invalid');
    expect(await code(cloud.readMemberChain(TENANT_A, { get afterSeq(): never { throw new Error('getter'); } }))).toBe('coordination_input_invalid');
    expect(await code(cloud.readScopeKeyPackages(TENANT_A, trap({ scopeId: 'scope-1' })))).toBe('coordination_input_invalid');
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
    expect(await cloud.putScopeKeyPackages(TENANT_A, { packages: [first, second] })).toEqual({ stored: 2, skippedDeviceIds: [] });
    expect(await code(cloud.putScopeKeyPackages(TENANT_A, { packages: [await keyPackage(TENANT_A, sender, device, 1)] })))
      .toBe('e2ee_scope_key_conflict');
    // A re-wrap of the same scope key replaces the recipient's package.
    const rewrapped = await keyPackage(TENANT_A, sender, device, 1, key);
    expect(await cloud.putScopeKeyPackages(TENANT_A, { packages: [rewrapped] })).toEqual({ stored: 1, skippedDeviceIds: [] });
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

  it('bounds scopeId at 512 characters on put and read', async () => {
    const { cloud } = setup();
    const sender = await newMember();
    const one = await keyPackage(TENANT_A, sender, sender, 1);
    const longest = 'x'.repeat(512);
    expect(await code(cloud.putScopeKeyPackages(TENANT_A, { packages: [{ ...one, scopeId: `${longest}x` }] }))).toBe('coordination_input_invalid');
    expect(await code(cloud.readScopeKeyPackages(TENANT_A, { scopeId: `${longest}x` }))).toBe('coordination_input_invalid');
    expect(await cloud.putScopeKeyPackages(TENANT_A, { packages: [{ ...one, scopeId: longest }] })).toEqual({ stored: 1, skippedDeviceIds: [] });
    expect(await cloud.readScopeKeyPackages(TENANT_A, { scopeId: longest })).toEqual({ packages: [{ ...one, scopeId: longest }] });
  });

  it('hands the store package rows in one lock order: scope and recipient by code point, then epoch', async () => {
    const received: Array<readonly [string, number, string]> = [];
    class OrderSpy extends InMemoryE2eeMemberStore {
      override async putScopeKeyPackages(tenant: TenantId, input: Parameters<InMemoryE2eeMemberStore['putScopeKeyPackages']>[1]) {
        received.push(...input.rows.map(row => [row.scopeId, row.epoch, row.recipient] as const));
        return super.putScopeKeyPackages(tenant, input);
      }
    }
    const { cloud } = setup(true, receipts => new OrderSpy(receipts));
    const sender = await newMember();
    const other = await newMember();
    const [low, high] = [sender.bundle.memberId, other.bundle.memberId].sort();
    const base = await keyPackage(TENANT_A, sender, sender, 1);
    // UTF-16 order puts the surrogate pair of U+1F600 before U+FF61; code point
    // order, which Postgres COLLATE "C" uses, puts it after.
    const packages = [
      ['\u{1F600}', 1, high], ['b', 2, low], ['\uFF61', 1, low], ['b', 1, high], ['a', 1, high], ['b', 1, low],
    ].map(([scopeId, epoch, recipient]) => ({ ...base, scopeId: scopeId as string, epoch: epoch as number, recipient: recipient as string }));
    expect(await cloud.putScopeKeyPackages(TENANT_A, { packages })).toEqual({ stored: 6, skippedDeviceIds: [] });
    expect(received).toEqual([
      ['a', 1, high], ['b', 1, low], ['b', 1, high], ['b', 2, low], ['\uFF61', 1, low], ['\u{1F600}', 1, high],
    ]);
  });

  it('fails a stored row that is not a valid value with a typed error', async () => {
    const { cloud, store, clock, registerDevice } = setup();
    await store.appendChainEntries(TENANT_A, { rows: [{ seq: 1, entry: '{"seq":1}' }], rotations: [], shreds: [] });
    expect(await code(cloud.readMemberChain(TENANT_A))).toBe('e2ee_member_state_unreadable');
    await store.putScopeKeyPackages(TENANT_A, { rows: [{ scopeId: 'scope-1', epoch: 1, recipient: 'r', keyId: 'k', sender: 's', package: 'not json', recipientKemEpoch: 1 }] });
    expect(await code(cloud.readScopeKeyPackages(TENANT_A, { scopeId: 'scope-1' }))).toBe('e2ee_member_state_unreadable');
    await registerDevice(TENANT_A, 'device-1');
    await store.registerMember(TENANT_A, { deviceId: 'device-1', memberId: 'm', bundle: '{}', deviceMac: 'mac', macExpiresAt: clock.now().toISOString(), request: freshRequest() });
    expect(await code(cloud.readMemberKeyRegistration(TENANT_A, 'device-1'))).toBe('e2ee_member_state_unreadable');
  });

  it('returns a registration only for an active device, with its MAC inside the pairing window', async () => {
    const { cloud, store, clock, registerDevice, base } = setup();
    const device = await newMember('device-1');
    await registerDevice(TENANT_A, 'device-1');
    expect(await cloud.readMemberKeyRegistration(TENANT_A, 'device-1')).toBeUndefined();
    await store.registerMember(TENANT_A, {
      deviceId: 'device-1', memberId: device.bundle.memberId, bundle: canonicalizeJson(device.bundle as unknown as JsonValue),
      deviceMac: 'device-mac', macExpiresAt: new Date(clock.now().getTime() + PAIRING_CODE_TTL_MS).toISOString(), request: freshRequest(),
    });
    expect(await cloud.readMemberKeyRegistration(TENANT_A, 'device-1')).toEqual({ member: device.bundle, deviceMac: 'device-mac' });
    clock.advance(PAIRING_CODE_TTL_MS);
    expect(await cloud.readMemberKeyRegistration(TENANT_A, 'device-1')).toEqual({ member: device.bundle });
    expect(await cloud.readMemberKeyRegistration(TENANT_B, 'device-1')).toBeUndefined();
    await base.stores.devices.revoke(TENANT_A, 'device-1');
    expect(await cloud.readMemberKeyRegistration(TENANT_A, 'device-1')).toBeUndefined();
  });

  it('gives a re-paired machine a new device id, so an old registration cannot block its new bundle', async () => {
    const harness = createHarness();
    const machineId = 'd'.repeat(64);
    const first = await harness.pairDevice(TENANT_A, undefined, machineId);
    const second = await harness.pairDevice(TENANT_A, undefined, machineId);
    expect(second.deviceId).not.toBe(first.deviceId);
    expect(await harness.stores.devices.get(TENANT_A, first.deviceId)).toBeUndefined();
  });

  // The in-memory device directory deletes no E2EE state. Its revoke and its
  // machine supersession both delete the device row, so the active-device
  // guard alone keeps the old device's registration and MACs unreachable.
  const machineId = 'e'.repeat(64);
  const removals: ReadonlyArray<readonly [string, (env: ReturnType<typeof setup>) => Promise<unknown>]> = [
    ['revoke', env => env.base.stores.devices.revoke(TENANT_A, 'device-1')],
    ['machine supersession', env => env.registerDevice(TENANT_A, 'device-2', machineId)],
  ];
  for (const [event, remove] of removals) {
    it(`serves and writes no member state for a device removed by ${event} on the memory backend`, async () => {
      const env = setup();
      const { cloud, store, clock, registerDevice } = env;
      const client = await newMember();
      const device = await newMember('device-1');
      await registerDevice(TENANT_A, 'device-1', machineId);
      await store.registerMember(TENANT_A, {
        deviceId: 'device-1', memberId: device.bundle.memberId, bundle: canonicalizeJson(device.bundle as unknown as JsonValue),
        deviceMac: 'device-mac', macExpiresAt: new Date(clock.now().getTime() + PAIRING_CODE_TTL_MS).toISOString(), request: freshRequest(),
      });
      const relay = { mac: 'A'.repeat(42) + 'E', member: client.bundle, chainHead: { seq: 2, hash: `sha256:${'0'.repeat(64)}` } };
      await cloud.relayClientPairingMac(TENANT_A, 'device-1', relay);
      expect(await cloud.readMemberKeyRegistration(TENANT_A, 'device-1')).toEqual({ member: device.bundle, deviceMac: 'device-mac' });

      await remove(env);

      expect(await env.base.stores.devices.get(TENANT_A, 'device-1')).toBeUndefined();
      expect(await cloud.readMemberKeyRegistration(TENANT_A, 'device-1')).toBeUndefined();
      expect(await code(cloud.relayClientPairingMac(TENANT_A, 'device-1', { ...relay, mac: 'A'.repeat(42) + 'I' }))).toBe('device_not_found');
      expect(await store.readClientPairingMac(TENANT_A, { deviceId: 'device-1', now: clock.now().toISOString() }))
        .toBe(canonicalizeJson(relay as unknown as JsonValue));
    });
  }

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
      deviceMac: 'device-mac', macExpiresAt: clock.now().toISOString(), request: freshRequest(),
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
