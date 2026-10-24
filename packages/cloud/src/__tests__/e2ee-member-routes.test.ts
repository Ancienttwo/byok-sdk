/**
 * The E2EE member device routes (#654 E2c-2): mounting under the declaration,
 * device proof on the three writes, the byte cap, and device-scoped reads.
 */
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import {
  DEVICE_PROOF_SCHEMA_ID,
  createMutableClock,
  deviceProofSigningInput,
  type DeviceProofProtectedClaims,
  type JsonValue,
  type TenantId,
} from '@byok-sdk/core';
import { generateScopeKey } from '@byok-sdk/core/sealed-payload';
import {
  E2EE_MEMBER_CHAIN_APPEND_OPERATION,
  E2EE_MEMBER_KEY_REGISTER_OPERATION,
  E2EE_SCOPE_KEY_PACKAGE_PUT_OPERATION,
  SEALED_PAYLOAD_CAPABILITY,
  decodeEnvelope,
  type PairResponse,
} from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { createHmacTokenSigner } from '../auth/tokens';
import { CLOUD_CAPABILITIES, fullCapabilityDeclaration } from '../capabilities';
import { createByokCloud, type ByokCloudOptions } from '../cloud';
import { createInMemoryByokCloud } from '../composition/in-memory';
import { InMemoryE2eeMemberStore } from '../stores/in-memory/e2ee-member';
import { TRUTH_REQUEST_ID_MAX_LENGTH } from '../truth/contract';
import { chain, keyPackage, newMember, signedChain } from './support/e2ee-members';
import { TENANT_A, TENANT_B } from './support/harness';

const ORIGIN = 'http://cloud.test';
const PRODUCT = 'product-e2ee';
const MAC = 'A'.repeat(42) + 'E';
const E2EE_ROUTES = {
  'POST /byok/e2ee/member-key': 'proof',
  'POST /byok/e2ee/chain': 'proof',
  'POST /byok/e2ee/key-packages': 'proof',
  'GET /byok/e2ee/chain': 'device',
  'GET /byok/e2ee/key-packages': 'device',
  'GET /byok/e2ee/pairing-mac': 'device',
};

interface Device {
  readonly tenant: TenantId;
  readonly deviceId: string;
  readonly bearer: string;
  readonly privateKey: KeyObject;
  readonly keyId: string;
  readonly keyEpoch: number;
}

function setup(overrides: Partial<ByokCloudOptions> = {}) {
  const clock = createMutableClock(new Date('2026-10-24T00:00:00.000Z'));
  const base = createInMemoryByokCloud({ clock });
  const store = new InMemoryE2eeMemberStore(base.stores.receipts);
  const cloud = createByokCloud({
    core: base.core,
    cloud: base.stores,
    mailboxWake: base.mailboxWake,
    blobContentProxy: base.blobContentProxy,
    crypto: base.crypto,
    tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(7), clock),
    clock,
    capabilities: fullCapabilityDeclaration(1, { includeE2eeMember: true }),
    e2eeMemberStore: store,
    ...overrides,
  });
  const fetch = (path: string, init: RequestInit = {}) => Promise.resolve(cloud.fetch(new Request(`${ORIGIN}${path}`, init)));

  async function pair(tenant: TenantId): Promise<Device> {
    if ((await base.core.quota.readEntitlement(tenant)) === undefined) {
      await base.core.quota.writeEntitlement(tenant, {
        version: 1n, hardLimitBytes: 1_000_000n, maxObjectBytes: 100_000n, maxInlineBytes: 10_000n, mailboxLimitBytes: 1_000_000n, retentionPolicyId: 'test',
      });
    }
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const x = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
    const pairing = await cloud.createPairingCode(tenant, { productId: PRODUCT });
    const response = await fetch('/byok/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: pairing.code, deviceName: 'device', devicePublicKey: x }),
    });
    const body = (await response.json()) as PairResponse;
    const row = (await base.stores.devices.get(tenant, body.deviceId))!;
    return { tenant, deviceId: body.deviceId, bearer: `Bearer ${body.accessToken}`, privateKey, keyId: row.proofKeyId, keyEpoch: row.proofKeyEpoch };
  }

  /** A proof write. `signedBody` lets a test sign other bytes than it sends; `requestId` lets it reuse one. */
  async function write(device: Device, path: string, operation: string, value: unknown, signedBody?: Uint8Array, requestId: string = randomUUID()) {
    const body = new TextEncoder().encode(JSON.stringify(value));
    const signed = signedBody ?? body;
    const claims: DeviceProofProtectedClaims = {
      version: 1,
      tenantId: device.tenant,
      productId: PRODUCT,
      deviceId: device.deviceId,
      keyId: device.keyId,
      keyEpoch: device.keyEpoch,
      requestId,
      operation,
      resource: path,
      method: 'POST',
      path,
      bodySha256: await base.crypto.sha256(signed),
      bodySize: signed.byteLength,
      issuedAt: clock.now().toISOString(),
    };
    const envelope = {
      schema: DEVICE_PROOF_SCHEMA_ID,
      algorithm: 'ed25519' as const,
      protected: claims,
      signature: sign(null, deviceProofSigningInput(claims), device.privateKey).toString('base64url'),
    };
    return fetch(path, {
      method: 'POST',
      headers: { 'x-byok-device-proof': Buffer.from(JSON.stringify(envelope)).toString('base64url'), 'content-type': 'application/json' },
      body,
    });
  }

  const read = (device: Device, path: string) => fetch(path, { headers: { authorization: device.bearer } });
  return { cloud, base, store, clock, fetch, pair, write, read };
}

async function answer(response: Response): Promise<{ readonly status: number; readonly body: unknown }> {
  return { status: response.status, body: await response.json() };
}

describe('E2EE member device routes', () => {
  it('mounts the six routes only when e2ee.member is declared and a store is supplied', () => {
    const e2eeRoutes = (cloud: { readonly routes: readonly { method: string; path: string; class: string }[] }) =>
      Object.fromEntries(cloud.routes.filter(route => route.path.startsWith('/byok/e2ee/')).map(route => [`${route.method} ${route.path}`, route.class]));
    expect(e2eeRoutes(setup().cloud)).toEqual(E2EE_ROUTES);
    expect(e2eeRoutes(setup({ capabilities: fullCapabilityDeclaration() }).cloud)).toEqual({});
    expect(fullCapabilityDeclaration().capabilities).not.toContain(CLOUD_CAPABILITIES.e2eeMember);
    expect(() => setup({ e2eeMemberStore: undefined })).toThrowError(expect.objectContaining({ code: 'capability_over_declared' }));
  });

  it('declares e2ee.member.kem-epoch exactly with e2ee.member', async () => {
    expect(CLOUD_CAPABILITIES.e2eeMemberKemEpoch).toBe('e2ee.member.kem-epoch');
    expect(fullCapabilityDeclaration().capabilities).not.toContain(CLOUD_CAPABILITIES.e2eeMemberKemEpoch);
    const declared = (await answer(await setup().fetch('/byok/capabilities'))).body as { capabilities: string[] };
    expect(declared.capabilities).toEqual(expect.arrayContaining(['e2ee.member', 'e2ee.member.kem-epoch']));
  });

  it('registers the device bundle and MAC under device proof, and refuses another bundle or device', async () => {
    const env = setup();
    const device = await env.pair(TENANT_A);
    const member = await newMember(device.deviceId);
    const register = (value: unknown) => env.write(device, '/byok/e2ee/member-key', E2EE_MEMBER_KEY_REGISTER_OPERATION, value);

    expect(await answer(await register({ member: member.bundle, mac: MAC }))).toEqual({ status: 200, body: { memberId: member.bundle.memberId } });
    expect(await answer(await register({ member: member.bundle, mac: MAC }))).toEqual({ status: 200, body: { memberId: member.bundle.memberId } });
    expect(await env.cloud.readMemberKeyRegistration(TENANT_A, device.deviceId)).toEqual({ member: member.bundle, deviceMac: MAC });

    const other = await newMember(device.deviceId);
    expect(await answer(await register({ member: other.bundle, mac: MAC }))).toEqual({ status: 409, body: { error: 'e2ee_member_key_conflict' } });
    const elsewhere = await newMember('another-device');
    expect(await answer(await register({ member: elsewhere.bundle, mac: MAC }))).toEqual({ status: 400, body: { error: 'coordination_input_invalid' } });
    expect(await answer(await register({ member: { ...member.bundle, deviceId: undefined }, mac: MAC }))).toEqual({ status: 400, body: { error: 'coordination_input_invalid' } });
    expect(await answer(await register({ member: member.bundle, mac: MAC, extra: 1 }))).toEqual({ status: 400, body: { error: 'coordination_input_invalid' } });
  });

  it('refuses a missing, mismatched or wrong-operation proof with 401, and an oversized body with 413', async () => {
    const env = setup({ maxE2eeRequestBytes: 4096 });
    const device = await env.pair(TENANT_A);
    const member = await newMember(device.deviceId);
    const body = { member: member.bundle, mac: MAC };

    const unsigned = await env.fetch('/byok/e2ee/member-key', { method: 'POST', body: JSON.stringify(body), headers: { authorization: device.bearer } });
    expect(await answer(unsigned)).toEqual({ status: 401, body: { error: 'unauthorized' } });
    expect((await env.write(device, '/byok/e2ee/member-key', E2EE_MEMBER_CHAIN_APPEND_OPERATION, body)).status).toBe(401);
    expect((await env.write(device, '/byok/e2ee/member-key', E2EE_MEMBER_KEY_REGISTER_OPERATION, body, new TextEncoder().encode('{}'))).status).toBe(401);
    expect((await env.write(device, '/byok/e2ee/chain', E2EE_MEMBER_CHAIN_APPEND_OPERATION, { entries: [], pad: 'x'.repeat(4096) })).status).toBe(413);
    expect(await env.cloud.readMemberKeyRegistration(TENANT_A, device.deviceId)).toBeUndefined();
  });

  it('appends and reads the chain through the device routes with the control-plane checks', async () => {
    const env = setup();
    const device = await env.pair(TENANT_A);
    const signer = await newMember();
    const entries = await chain(TENANT_A, signer, 3);
    const append = (value: unknown) => env.write(device, '/byok/e2ee/chain', E2EE_MEMBER_CHAIN_APPEND_OPERATION, value);

    expect(await answer(await append({ entries: entries.slice(0, 2) }))).toEqual({ status: 200, body: { appended: 2, replayed: 0 } });
    expect(await answer(await append({ entries }))).toEqual({ status: 200, body: { appended: 1, replayed: 2 } });
    expect(await answer(await append({ entries: [{ ...entries[1]!, sig: entries[0]!.sig }] }))).toEqual({ status: 409, body: { error: 'e2ee_member_chain_conflict' } });
    expect(await answer(await append({ entries: await chain(TENANT_B, signer, 1) }))).toEqual({ status: 400, body: { error: 'coordination_input_invalid' } });
    expect(await answer(await append([]))).toEqual({ status: 400, body: { error: 'coordination_input_invalid' } });

    expect(await answer(await env.read(device, '/byok/e2ee/chain'))).toEqual({ status: 200, body: { entries } });
    expect(await answer(await env.read(device, '/byok/e2ee/chain?afterSeq=2&limit=1'))).toEqual({ status: 200, body: { entries: [entries[2]] } });
    for (const query of ['?afterSeq=x', '?afterSeq=1&afterSeq=2', '?limit=0', '?limit=257', '?scopeId=s']) {
      expect(await answer(await env.read(device, `/byok/e2ee/chain${query}`))).toEqual({ status: 400, body: { error: 'coordination_input_invalid' } });
    }
  });

  it('shreds a scope on a device append, records the device in the receipt, and refuses later puts with 409', async () => {
    const env = setup();
    const device = await env.pair(TENANT_A);
    const client = await newMember();
    const member = client.bundle.memberId;
    const entries = await signedChain(TENANT_A, client, [
      { op: 'add', subject: { member: client.bundle as unknown as JsonValue } },
      { op: 'scope-policy', subject: { scopeId: 'scope-1', categories: ['task-input'], members: [member] } },
      { op: 'shred', subject: { scopeId: 'scope-1' } },
    ]);
    const put = (packages: unknown) => env.write(device, '/byok/e2ee/key-packages', E2EE_SCOPE_KEY_PACKAGE_PUT_OPERATION, { packages });
    expect((await put([await keyPackage(TENANT_A, client, client, 1)])).status).toBe(200);

    expect(await answer(await env.write(device, '/byok/e2ee/chain', E2EE_MEMBER_CHAIN_APPEND_OPERATION, { entries })))
      .toEqual({ status: 200, body: { appended: 3, replayed: 0 } });
    expect(await env.cloud.readScopeKeyPackages(TENANT_A, { scopeId: 'scope-1' })).toEqual({ packages: [] });
    expect(JSON.parse((await env.base.stores.receipts.get(TENANT_A, 'e2ee-scope-shred:scope-1'))!.body))
      .toEqual({ chainSeq: 3, shreddedAt: env.clock.now().toISOString(), writer: { kind: 'device', deviceId: device.deviceId } });
    expect(await answer(await put([await keyPackage(TENANT_A, client, client, 2)]))).toEqual({ status: 409, body: { error: 'e2ee_scope_shredded' } });
  });

  it('makes the proof requestId single-use on the three writes', async () => {
    const env = setup();
    const device = await env.pair(TENANT_A);
    const member = await newMember(device.deviceId);
    const sender = await newMember();
    const once = (path: string, operation: string, value: unknown, requestId: string) => env.write(device, path, operation, value, undefined, requestId);

    // Registration: a replay returns the first result and keeps the newer MAC.
    const register = (mac: string, requestId: string) => once('/byok/e2ee/member-key', E2EE_MEMBER_KEY_REGISTER_OPERATION, { member: member.bundle, mac }, requestId);
    const otherMac = 'B'.repeat(42) + 'E';
    expect(await answer(await register(MAC, 'register-1'))).toEqual({ status: 200, body: { memberId: member.bundle.memberId } });
    expect((await register(otherMac, 'register-2')).status).toBe(200);
    expect(await answer(await register(MAC, 'register-1'))).toEqual({ status: 200, body: { memberId: member.bundle.memberId } });
    expect(await env.cloud.readMemberKeyRegistration(TENANT_A, device.deviceId)).toEqual({ member: member.bundle, deviceMac: otherMac });
    expect(await answer(await register(otherMac, 'register-1'))).toEqual({ status: 409, body: { error: 'proof_request_conflict' } });

    // Package put: a replay of an older wrap does not overwrite the newer one.
    const key = generateScopeKey();
    const older = await keyPackage(TENANT_A, sender, member, 1, key);
    const newer = await keyPackage(TENANT_A, sender, member, 1, key);
    const put = (packages: unknown, requestId: string) => once('/byok/e2ee/key-packages', E2EE_SCOPE_KEY_PACKAGE_PUT_OPERATION, { packages }, requestId);
    expect(await answer(await put([older], 'put-1'))).toEqual({ status: 200, body: { stored: 1, skippedDeviceIds: [device.deviceId] } });
    expect((await put([newer], 'put-2')).status).toBe(200);
    expect(await answer(await put([older], 'put-1'))).toEqual({ status: 200, body: { stored: 1, skippedDeviceIds: [device.deviceId] } });
    expect(await env.cloud.readScopeKeyPackages(TENANT_A, { scopeId: 'scope-1' })).toEqual({ packages: [newer] });
    expect(await answer(await put([newer], 'put-1'))).toEqual({ status: 409, body: { error: 'proof_request_conflict' } });

    // Chain append: a replay returns the first counts.
    const entries = await chain(TENANT_A, sender, 2);
    const append = (value: unknown, requestId: string) => once('/byok/e2ee/chain', E2EE_MEMBER_CHAIN_APPEND_OPERATION, value, requestId);
    expect(await answer(await append({ entries: entries.slice(0, 1) }, 'append-1'))).toEqual({ status: 200, body: { appended: 1, replayed: 0 } });
    expect(await answer(await append({ entries: entries.slice(0, 1) }, 'append-1'))).toEqual({ status: 200, body: { appended: 1, replayed: 0 } });
    expect(await answer(await append({ entries }, 'append-1'))).toEqual({ status: 409, body: { error: 'proof_request_conflict' } });
    expect((await env.cloud.readMemberChain(TENANT_A)).entries).toEqual(entries.slice(0, 1));
  });

  it('refuses a proof requestId over the truth put cap before any store call, and accepts one at the cap', async () => {
    const env = setup();
    const device = await env.pair(TENANT_A);
    const member = await newMember(device.deviceId);
    const register = (requestId: string) =>
      env.write(device, '/byok/e2ee/member-key', E2EE_MEMBER_KEY_REGISTER_OPERATION, { member: member.bundle, mac: MAC }, undefined, requestId);

    expect(await answer(await register('r'.repeat(TRUTH_REQUEST_ID_MAX_LENGTH + 1)))).toEqual({ status: 409, body: { error: 'proof_request_conflict' } });
    expect(await env.cloud.readMemberKeyRegistration(TENANT_A, device.deviceId)).toBeUndefined();
    expect(await answer(await register('r'.repeat(TRUTH_REQUEST_ID_MAX_LENGTH)))).toEqual({ status: 200, body: { memberId: member.bundle.memberId } });
    expect(await env.cloud.readMemberKeyRegistration(TENANT_A, device.deviceId)).toEqual({ member: member.bundle, deviceMac: MAC });
  });

  it('puts packages under device proof and returns only the packages addressed to the reading device', async () => {
    const env = setup();
    const device = await env.pair(TENANT_A);
    const unregistered = await env.pair(TENANT_A);
    const member = await newMember(device.deviceId);
    const other = await newMember();
    expect((await env.write(device, '/byok/e2ee/member-key', E2EE_MEMBER_KEY_REGISTER_OPERATION, { member: member.bundle, mac: MAC })).status).toBe(200);
    const key = generateScopeKey();
    const mine = await keyPackage(TENANT_A, other, member, 1, key);
    const theirs = await keyPackage(TENANT_A, other, other, 1, key);
    const put = (value: unknown) => env.write(device, '/byok/e2ee/key-packages', E2EE_SCOPE_KEY_PACKAGE_PUT_OPERATION, value);

    expect(await answer(await put({ packages: [mine, theirs] }))).toEqual({ status: 200, body: { stored: 2, skippedDeviceIds: [device.deviceId] } });
    expect(await answer(await put({ packages: [await keyPackage(TENANT_A, other, member, 1)] }))).toEqual({ status: 409, body: { error: 'e2ee_scope_key_conflict' } });
    expect(await answer(await put({ packages: [await keyPackage(TENANT_B, other, member, 1)] }))).toEqual({ status: 400, body: { error: 'coordination_input_invalid' } });

    expect(await answer(await env.read(device, '/byok/e2ee/key-packages?scopeId=scope-1&epoch=1'))).toEqual({ status: 200, body: { packages: [mine] } });
    expect(await answer(await env.read(device, '/byok/e2ee/key-packages?scopeId=scope-1'))).toEqual({ status: 400, body: { error: 'coordination_input_invalid' } });
    expect(await answer(await env.read(device, '/byok/e2ee/key-packages?scopeId=scope-1&epoch=2'))).toEqual({ status: 200, body: { packages: [] } });
    expect(await answer(await env.read(device, `/byok/e2ee/key-packages?scopeId=scope-1&recipient=${other.bundle.memberId}`)))
      .toEqual({ status: 400, body: { error: 'coordination_input_invalid' } });
    expect(await answer(await env.read(device, '/byok/e2ee/key-packages'))).toEqual({ status: 400, body: { error: 'coordination_input_invalid' } });
    expect(await answer(await env.read(unregistered, '/byok/e2ee/key-packages?scopeId=scope-1&epoch=1')))
      .toEqual({ status: 409, body: { error: 'e2ee_member_not_registered' } });
    expect(await answer(await env.read(unregistered, '/byok/e2ee/key-packages'))).toEqual({ status: 400, body: { error: 'coordination_input_invalid' } });
  });

  it('sends the key package notice from the device put route to a recipient device with sealed-payload-v1', async () => {
    const env = setup();
    const device = await env.pair(TENANT_A);
    const member = await newMember(device.deviceId);
    const sender = await newMember();
    expect((await env.write(device, '/byok/e2ee/member-key', E2EE_MEMBER_KEY_REGISTER_OPERATION, { member: member.bundle, mac: MAC })).status).toBe(200);
    await env.base.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: [SEALED_PAYLOAD_CAPABILITY] });
    const put = { packages: [await keyPackage(TENANT_A, sender, member, 1)] };

    expect(await answer(await env.write(device, '/byok/e2ee/key-packages', E2EE_SCOPE_KEY_PACKAGE_PUT_OPERATION, put)))
      .toEqual({ status: 200, body: { stored: 1, skippedDeviceIds: [] } });
    const page = await env.base.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 });
    expect(page.messages.map(row => decodeEnvelope(row.body)).filter(envelope => envelope.type === 'e2ee.key_package.available').map(envelope => envelope.payload))
      .toEqual([{ scopeId: 'scope-1', epoch: 1 }]);
  });

  it('refuses an unknown top-level field on the chain append and the package put, and stores nothing', async () => {
    const env = setup();
    const device = await env.pair(TENANT_A);
    const member = await newMember(device.deviceId);
    const other = await newMember();
    const entries = await chain(TENANT_A, other, 1);
    const pkg = await keyPackage(TENANT_A, other, member, 1);
    expect((await env.write(device, '/byok/e2ee/member-key', E2EE_MEMBER_KEY_REGISTER_OPERATION, { member: member.bundle, mac: MAC })).status).toBe(200);

    expect(await answer(await env.write(device, '/byok/e2ee/chain', E2EE_MEMBER_CHAIN_APPEND_OPERATION, { entries, extra: 1 })))
      .toEqual({ status: 400, body: { error: 'coordination_input_invalid' } });
    expect(await answer(await env.write(device, '/byok/e2ee/key-packages', E2EE_SCOPE_KEY_PACKAGE_PUT_OPERATION, { packages: [pkg], extra: 1 })))
      .toEqual({ status: 400, body: { error: 'coordination_input_invalid' } });
    expect(await answer(await env.read(device, '/byok/e2ee/chain'))).toEqual({ status: 200, body: { entries: [] } });
    expect(await answer(await env.read(device, '/byok/e2ee/key-packages?scopeId=scope-1&afterEpoch=0')))
      .toEqual({ status: 200, body: { packages: [], scopeHeadEpoch: null } });
  });

  it('pages the device member own packages by epoch, with the scope head epoch', async () => {
    const env = setup();
    const device = await env.pair(TENANT_A);
    const member = await newMember(device.deviceId);
    const other = await newMember();
    expect((await env.write(device, '/byok/e2ee/member-key', E2EE_MEMBER_KEY_REGISTER_OPERATION, { member: member.bundle, mac: MAC })).status).toBe(200);
    const mine = await Promise.all(Array.from({ length: 17 }, (_, index) => keyPackage(TENANT_A, other, member, index + 1)));
    // The scope head epoch 18 holds no package of this member.
    const packages = [...mine, await keyPackage(TENANT_A, other, other, 18)];
    expect((await env.write(device, '/byok/e2ee/key-packages', E2EE_SCOPE_KEY_PACKAGE_PUT_OPERATION, { packages })).status).toBe(200);
    const page = (query: string) => env.read(device, `/byok/e2ee/key-packages?scopeId=scope-1&${query}`);

    expect(await answer(await page('afterEpoch=0'))).toEqual({ status: 200, body: { packages: mine.slice(0, 16), scopeHeadEpoch: 18 } });
    expect(await answer(await page('afterEpoch=16'))).toEqual({ status: 200, body: { packages: mine.slice(16), scopeHeadEpoch: 18 } });
    expect(await answer(await page('afterEpoch=17'))).toEqual({ status: 200, body: { packages: [], scopeHeadEpoch: 18 } });
    expect(await answer(await env.read(device, '/byok/e2ee/key-packages?scopeId=scope-2&afterEpoch=0')))
      .toEqual({ status: 200, body: { packages: [], scopeHeadEpoch: null } });
    for (const query of ['epoch=1&afterEpoch=0', 'afterEpoch=-1', 'afterEpoch=x', `afterEpoch=${Number.MAX_SAFE_INTEGER + 1}`, 'afterEpoch=0&afterEpoch=1']) {
      expect(await answer(await page(query)), query).toEqual({ status: 400, body: { error: 'coordination_input_invalid' } });
    }
    expect(await answer(await env.read(device, '/byok/e2ee/key-packages?afterEpoch=0'))).toEqual({ status: 400, body: { error: 'coordination_input_invalid' } });
  });

  it('refuses a version 1 package put with 400 and a package below its recipient KEM floor with 409', async () => {
    const env = setup();
    const device = await env.pair(TENANT_A);
    const client = await newMember();
    const put = (packages: unknown) => env.write(device, '/byok/e2ee/key-packages', E2EE_SCOPE_KEY_PACKAGE_PUT_OPERATION, { packages });
    const sealed = await keyPackage(TENANT_A, client, client, 1);
    const { recipientKemEpoch: _, ...v1 } = { ...sealed, v: 1 };
    expect(await answer(await put([v1]))).toEqual({ status: 400, body: { error: 'coordination_input_invalid' } });

    const entries = await signedChain(TENANT_A, client, [
      { op: 'add', subject: { member: client.bundle as unknown as JsonValue } },
      { op: 'rotate', subject: { memberId: client.bundle.memberId, kemPublicJwk: client.bundle.kemPublicJwk, kemEpoch: 2, kemSig: client.bundle.kemSig } as never },
    ]);
    expect((await env.write(device, '/byok/e2ee/chain', E2EE_MEMBER_CHAIN_APPEND_OPERATION, { entries })).status).toBe(200);
    expect(await answer(await put([sealed]))).toEqual({ status: 409, body: { error: 'e2ee_scope_key_package_stale' } });
    expect(await env.cloud.readScopeKeyPackages(TENANT_A, { scopeId: 'scope-1' })).toEqual({ packages: [] });
  });

  it('reads the relayed client MAC, and refuses every read once the device is revoked', async () => {
    const env = setup();
    const device = await env.pair(TENANT_A);
    const member = await newMember(device.deviceId);
    const client = await newMember();
    expect(await answer(await env.read(device, '/byok/e2ee/pairing-mac'))).toEqual({ status: 404, body: { error: 'e2ee_pairing_mac_not_found' } });
    expect((await env.write(device, '/byok/e2ee/member-key', E2EE_MEMBER_KEY_REGISTER_OPERATION, { member: member.bundle, mac: MAC })).status).toBe(200);
    const relay = { mac: MAC, member: client.bundle, chainHead: { seq: 2, hash: `sha256:${'0'.repeat(64)}` } };
    await env.cloud.relayClientPairingMac(TENANT_A, device.deviceId, relay);
    expect(await answer(await env.read(device, '/byok/e2ee/pairing-mac'))).toEqual({ status: 200, body: relay });
    expect((await env.read(device, '/byok/e2ee/pairing-mac?x=1')).status).toBe(400);

    await env.cloud.revokeDevice(TENANT_A, device.deviceId);
    for (const path of ['/byok/e2ee/pairing-mac', '/byok/e2ee/chain', '/byok/e2ee/key-packages?scopeId=scope-1']) {
      expect(await answer(await env.read(device, path))).toEqual({ status: 401, body: { error: 'unauthorized' } });
    }
    expect((await env.write(device, '/byok/e2ee/member-key', E2EE_MEMBER_KEY_REGISTER_OPERATION, { member: member.bundle, mac: MAC })).status).toBe(401);
  });
});
