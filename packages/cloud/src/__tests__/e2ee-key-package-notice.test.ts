/**
 * The E2EE key package notice (#654 E2c-3): who gets `e2ee.key_package.available`
 * after a key package put, and the per-device enqueue it uses.
 */
import { createHash } from 'node:crypto';
import { canonicalizeJson, createMutableClock, type JsonValue, type TenantId } from '@byok-sdk/core';
import { generateScopeKey } from '@byok-sdk/core/sealed-payload';
import { SEALED_PAYLOAD_CAPABILITY, decodeEnvelope } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { createHmacTokenSigner } from '../auth/tokens';
import { fullCapabilityDeclaration } from '../capabilities';
import { createByokCloud, type ByokCloud } from '../cloud';
import { createInMemoryByokCloud } from '../composition/in-memory';
import { uuidFromSha256 } from '../offer-identity';
import { InMemoryE2eeMemberStore } from '../stores/in-memory/e2ee-member';
import { keyPackage, newMember, type Member } from './support/e2ee-members';
import { TENANT_A, TENANT_B } from './support/harness';

const MAC = 'A'.repeat(42) + 'E';
let requests = 0;
/** A device-proof binding with a requestId no other write has used. */
const freshRequest = () => ({ requestId: `request-${++requests}`, operation: 'e2ee-member-key.register', resource: '/byok/e2ee/member-key', bodySha256: 'sha256', bodySize: 1 });

function setup() {
  const clock = createMutableClock();
  const base = createInMemoryByokCloud({ clock });
  const store = new InMemoryE2eeMemberStore(base.stores.receipts);
  const cloud: ByokCloud = createByokCloud({
    proofReceiptRetention: base.proofReceiptRetention,
    core: base.core,
    cloud: base.stores,
    mailboxWake: base.mailboxWake,
    blobContentProxy: base.blobContentProxy,
    crypto: base.crypto,
    tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(7), clock),
    clock,
    capabilities: fullCapabilityDeclaration(1, { includeE2eeMember: true }),
    e2eeMemberStore: store,
  });

  /** A paired device with a registered member key, advertising `capabilities`. */
  async function device(tenant: TenantId, deviceId: string, capabilities: readonly string[]): Promise<Member> {
    if ((await base.core.quota.readEntitlement(tenant)) === undefined) {
      await base.core.quota.writeEntitlement(tenant, {
        version: 1n, hardLimitBytes: 1_000_000n, maxObjectBytes: 100_000n, maxInlineBytes: 10_000n, mailboxLimitBytes: 1_000_000n, retentionPolicyId: 'test',
      });
    }
    await base.stores.devices.register(tenant, {
      productId: 'product', deviceId, deviceName: deviceId, devicePublicKey: `${deviceId}-key`, proofKeyId: 'identity', proofKeyEpoch: 0,
    });
    await base.stores.devices.recordCapabilities(tenant, { deviceId, capabilities: [...capabilities] });
    const member = await newMember(deviceId);
    expect(await store.registerMember(tenant, {
      deviceId,
      memberId: member.bundle.memberId,
      bundle: canonicalizeJson(member.bundle as unknown as JsonValue),
      deviceMac: MAC,
      macExpiresAt: new Date(clock.now().getTime() + 60_000).toISOString(), request: freshRequest(),
    })).toBe('registered');
    return member;
  }

  async function notices(tenant: TenantId, deviceId: string) {
    const page = await base.core.mailbox.readAfter(tenant, { deviceId, afterSeq: 0, limit: 50 });
    return page.messages.map(row => ({ seq: row.seq, envelope: decodeEnvelope(row.body) }));
  }

  return { cloud, base, device, notices };
}

describe('e2ee.key_package.available after a key package put', () => {
  it('notifies a recipient device with sealed-payload-v1 once per scope epoch, with only { scopeId, epoch }', async () => {
    const env = setup();
    const sender = await newMember();
    const sealed = await env.device(TENANT_A, 'device-sealed', [SEALED_PAYLOAD_CAPABILITY]);
    const packages = [
      await keyPackage(TENANT_A, sender, sealed, 1),
      await keyPackage(TENANT_A, sender, sealed, 2),
    ];

    expect(await env.cloud.putScopeKeyPackages(TENANT_A, { packages })).toEqual({ stored: 2, skippedDeviceIds: [] });
    const rows = await env.notices(TENANT_A, 'device-sealed');
    expect(rows.map(row => row.envelope.type)).toEqual(['e2ee.key_package.available', 'e2ee.key_package.available']);
    expect(rows.map(row => row.envelope.payload)).toEqual([{ scopeId: 'scope-1', epoch: 1 }, { scopeId: 'scope-1', epoch: 2 }]);
    expect(rows.every(row => row.envelope.task_id === undefined && row.envelope.seq === row.seq)).toBe(true);
  });

  it('stores the packages but skips and lists a recipient device without sealed-payload-v1', async () => {
    const env = setup();
    const sender = await newMember();
    const old = await env.device(TENANT_A, 'device-old', ['agent-home-contract']);
    const sealed = await env.device(TENANT_A, 'device-sealed', [SEALED_PAYLOAD_CAPABILITY]);
    const key = generateScopeKey();
    const packages = [await keyPackage(TENANT_A, sender, old, 1, key), await keyPackage(TENANT_A, sender, sealed, 1, key)];

    expect(await env.cloud.putScopeKeyPackages(TENANT_A, { packages })).toEqual({ stored: 2, skippedDeviceIds: ['device-old'] });
    expect(await env.notices(TENANT_A, 'device-old')).toEqual([]);
    expect((await env.notices(TENANT_A, 'device-sealed')).map(row => row.envelope.payload)).toEqual([{ scopeId: 'scope-1', epoch: 1 }]);
    expect((await env.cloud.readScopeKeyPackages(TENANT_A, { scopeId: 'scope-1', recipient: old.bundle.memberId })).packages)
      .toEqual([packages[0]]);
  });

  it('sends nothing and lists nothing for a recipient with no device registration, or a revoked device', async () => {
    const env = setup();
    const sender = await newMember();
    const browser = await newMember();
    const revoked = await env.device(TENANT_A, 'device-revoked', [SEALED_PAYLOAD_CAPABILITY]);
    await env.cloud.revokeDevice(TENANT_A, 'device-revoked');
    const key = generateScopeKey();
    const packages = [await keyPackage(TENANT_A, sender, browser, 1, key), await keyPackage(TENANT_A, sender, revoked, 1, key)];

    expect(await env.cloud.putScopeKeyPackages(TENANT_A, { packages })).toEqual({ stored: 2, skippedDeviceIds: [] });
    expect(await env.notices(TENANT_A, 'device-revoked')).toEqual([]);
  });

  it('enqueues again on a replayed put and gets the same mailbox row back', async () => {
    const env = setup();
    const sender = await newMember();
    const sealed = await env.device(TENANT_A, 'device-sealed', [SEALED_PAYLOAD_CAPABILITY]);
    const packages = [await keyPackage(TENANT_A, sender, sealed, 1)];

    await env.cloud.putScopeKeyPackages(TENANT_A, { packages });
    const first = await env.notices(TENANT_A, 'device-sealed');
    expect(await env.cloud.putScopeKeyPackages(TENANT_A, { packages })).toEqual({ stored: 1, skippedDeviceIds: [] });
    expect(await env.notices(TENANT_A, 'device-sealed')).toEqual(first);
    expect(first).toHaveLength(1);
  });

  it('notifies a device on a replayed put once it advertises sealed-payload-v1', async () => {
    const env = setup();
    const sender = await newMember();
    const upgraded = await env.device(TENANT_A, 'device-upgraded', ['agent-home-contract']);
    const packages = [await keyPackage(TENANT_A, sender, upgraded, 1)];

    expect(await env.cloud.putScopeKeyPackages(TENANT_A, { packages })).toEqual({ stored: 1, skippedDeviceIds: ['device-upgraded'] });
    expect(await env.notices(TENANT_A, 'device-upgraded')).toEqual([]);
    await env.base.stores.devices.recordCapabilities(TENANT_A, { deviceId: 'device-upgraded', capabilities: [SEALED_PAYLOAD_CAPABILITY] });
    expect(await env.cloud.putScopeKeyPackages(TENANT_A, { packages })).toEqual({ stored: 1, skippedDeviceIds: [] });
    expect((await env.notices(TENANT_A, 'device-upgraded')).map(row => row.envelope.payload)).toEqual([{ scopeId: 'scope-1', epoch: 1 }]);
  });

  it('notifies only the devices of the put tenant', async () => {
    const env = setup();
    const sender = await newMember();
    const sealed = await env.device(TENANT_A, 'device-a', [SEALED_PAYLOAD_CAPABILITY]);
    await env.device(TENANT_B, 'device-b', [SEALED_PAYLOAD_CAPABILITY]);

    await env.cloud.putScopeKeyPackages(TENANT_A, { packages: [await keyPackage(TENANT_A, sender, sealed, 1)] });
    expect(await env.notices(TENANT_A, 'device-a')).toHaveLength(1);
    expect(await env.notices(TENANT_B, 'device-b')).toEqual([]);
  });
});

describe('enqueueScopeKeyPackageNotice', () => {
  it('derives the message id from the domain, tenant, device, scopeId and epoch, and is idempotent', async () => {
    const env = setup();
    await env.device(TENANT_A, 'device-sealed', [SEALED_PAYLOAD_CAPABILITY]);
    const first = await env.cloud.enqueueScopeKeyPackageNotice(TENANT_A, 'device-sealed', { scopeId: 'scope-1', epoch: 3 });
    const expected = uuidFromSha256(`sha256:${createHash('sha256').update(JSON.stringify({
      domain: 'byok:e2ee-key-package-notice', tenant: TENANT_A, deviceId: 'device-sealed', scopeId: 'scope-1', epoch: 3,
    })).digest('hex')}`);
    expect(first.envelope).toMatchObject({ id: expected, type: 'e2ee.key_package.available', payload: { scopeId: 'scope-1', epoch: 3 } });
    expect(await env.cloud.enqueueScopeKeyPackageNotice(TENANT_A, 'device-sealed', { scopeId: 'scope-1', epoch: 3 })).toEqual(first);
    expect(await env.notices(TENANT_A, 'device-sealed')).toHaveLength(1);
  });

  it('refuses an extra payload field or a scopeId over 512 characters before admission, and a device without the capability before the mailbox', async () => {
    const env = setup();
    await env.device(TENANT_A, 'device-old', []);
    const extra = env.cloud.enqueueScopeKeyPackageNotice(TENANT_A, 'device-old', { scopeId: 'scope-1', epoch: 1, keyId: 'x' } as never);
    await expect(extra).rejects.toBeInstanceOf(ZodError);
    await expect(env.cloud.enqueueScopeKeyPackageNotice(TENANT_A, 'device-old', { scopeId: 'x'.repeat(513), epoch: 1 }))
      .rejects.toBeInstanceOf(ZodError);
    await expect(env.cloud.enqueueScopeKeyPackageNotice(TENANT_A, 'device-old', { scopeId: 'scope-1', epoch: 1 }))
      .rejects.toMatchObject({ code: 'agent_capability_missing', message: expect.stringContaining(SEALED_PAYLOAD_CAPABILITY) });
    expect(await env.notices(TENANT_A, 'device-old')).toEqual([]);
  });
});
