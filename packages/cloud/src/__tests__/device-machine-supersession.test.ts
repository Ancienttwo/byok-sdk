/**
 * "One physical machine = one active device row", asserted end to end through
 * the real `POST /byok/pair` route rather than against the store directly.
 *
 * The route is the right altitude here because the interesting part of the
 * design is what `PairRequest` is ALLOWED to say. `machineId` is the first
 * request-authored field that causes the server to mutate rows the request did
 * not name, so every case below pins down the boundary of that authority:
 * it supersedes only within the tenant and product the redeemed pairing code's
 * claims chose, only for an identical digest, and only when one was sent at
 * all. A device can still never name the tenant it lands in — so it can never
 * name the rows it revokes either.
 */
import { describe, expect, it } from 'vitest';
import { createHarness, PRODUCT_ID, TENANT_A, TENANT_B } from './support/harness';

const MACHINE_ONE = 'a'.repeat(64);
const MACHINE_TWO = 'b'.repeat(64);
const OTHER_PRODUCT = 'other-product';

describe('device machine supersession (protocol §6.1 `machineId`)', () => {
  it('leaves exactly one active row when the same machine pairs twice', async () => {
    const harness = createHarness();

    const first = await harness.pairDevice(TENANT_A, PRODUCT_ID, MACHINE_ONE);
    const second = await harness.pairDevice(TENANT_A, PRODUCT_ID, MACHINE_ONE);

    expect(second.deviceId).not.toBe(first.deviceId);
    const devices = await harness.stores.devices.list(TENANT_A);
    // Exactly one row, not one active row among two: the predecessor is gone.
    expect(devices).toHaveLength(1);
    expect(devices.map((device) => device.deviceId)).toEqual([second.deviceId]);
    expect(devices[0]?.machineId).toBe(MACHINE_ONE);
    expect(devices.every((device) => !device.revoked)).toBe(true);
    // Superseded means DELETED. A lingering row is a credential every read
    // path has to remember to exclude; absence needs no remembering.
    expect(await harness.stores.devices.get(TENANT_A, first.deviceId)).toBeUndefined();
    expect(await harness.stores.devices.resolveByDeviceId(first.deviceId)).toBeUndefined();
  });

  it('makes the superseded device immediately unusable on the pre-tenant resolve path', async () => {
    // A superseded row that could still mint a token is the whole failure this
    // supersession is supposed to prevent, so it is asserted at the route
    // rather than inferred from the store's shape.
    const harness = createHarness();

    const first = await harness.pairDevice(TENANT_A, PRODUCT_ID, MACHINE_ONE);
    await harness.pairDevice(TENANT_A, PRODUCT_ID, MACHINE_ONE);

    const challenge = await harness.json('/byok/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: first.deviceId }),
    });
    expect(challenge.status).toBe(401);
  });

  it('keeps two active rows for two different machines', async () => {
    const harness = createHarness();

    const one = await harness.pairDevice(TENANT_A, PRODUCT_ID, MACHINE_ONE);
    const two = await harness.pairDevice(TENANT_A, PRODUCT_ID, MACHINE_TWO);

    const rows = await harness.stores.devices.list(TENANT_A);
    expect(rows.map((device) => device.deviceId).sort()).toEqual([one.deviceId, two.deviceId].sort());
  });

  it('supersedes nothing when no machineId is sent', async () => {
    // Absence is not "one shared unidentified machine". Two devices that could
    // not identify themselves must both stay active, or a fleet of containers
    // would revoke each other on every pairing.
    const harness = createHarness();

    const first = await harness.pairDevice(TENANT_A);
    const second = await harness.pairDevice(TENANT_A);

    const devices = await harness.stores.devices.list(TENANT_A);
    expect(devices).toHaveLength(2);
    expect(devices.every((device) => !device.revoked)).toBe(true);
    expect(devices.every((device) => device.machineId === undefined)).toBe(true);
    expect([first.deviceId, second.deviceId].sort()).toEqual(
      devices.map((device) => device.deviceId).sort(),
    );
  });

  it('does not supersede a device carrying no machineId when a later pairing carries one', async () => {
    const harness = createHarness();

    const anonymous = await harness.pairDevice(TENANT_A);
    await harness.pairDevice(TENANT_A, PRODUCT_ID, MACHINE_ONE);

    expect(await harness.stores.devices.get(TENANT_A, anonymous.deviceId)).toBeDefined();
  });

  it('never reaches across tenants, even for an identical machine digest', async () => {
    // The same laptop legitimately pairs into two tenants. `machineId` carries
    // no tenant of its own, so it can only ever address rows under the tenant
    // the redeemed pairing code already chose.
    const harness = createHarness();

    const inA = await harness.pairDevice(TENANT_A, PRODUCT_ID, MACHINE_ONE);
    const inB = await harness.pairDevice(TENANT_B, PRODUCT_ID, MACHINE_ONE);
    await harness.pairDevice(TENANT_B, PRODUCT_ID, MACHINE_ONE);

    expect(await harness.stores.devices.get(TENANT_A, inA.deviceId)).toBeDefined();
    expect(await harness.stores.devices.get(TENANT_B, inB.deviceId)).toBeUndefined();
  });

  it('never reaches across products within one tenant', async () => {
    const harness = createHarness();

    const inDefaultProduct = await harness.pairDevice(TENANT_A, PRODUCT_ID, MACHINE_ONE);
    const inOtherProduct = await harness.pairDevice(TENANT_A, OTHER_PRODUCT, MACHINE_ONE);

    expect(await harness.stores.devices.get(TENANT_A, inDefaultProduct.deviceId)).toBeDefined();
    expect(await harness.stores.devices.get(TENANT_A, inOtherProduct.deviceId)).toBeDefined();
  });

  it('rejects a malformed machineId at the wire boundary instead of storing it', async () => {
    const harness = createHarness();
    const pairing = await harness.cloud.createPairingCode(TENANT_A, { productId: PRODUCT_ID });

    const response = await harness.json('/byok/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairingCode: pairing.code,
        deviceName: 'test-device',
        devicePublicKey: 'not-a-real-key',
        machineId: 'NOT-A-SHA256',
      }),
    });

    expect(response.status).toBe(400);
    expect(await harness.stores.devices.list(TENANT_A)).toHaveLength(0);
  });
});
