import { describe, expect, it } from 'vitest';
import { createMutableClock } from '@byok-sdk/core';
import { createHarness, TENANT_A, TENANT_B } from './support/harness';

describe('SDK-owned tenant readiness projection', () => {
  it('aggregates durable devices and live presence with revocation, expiry, and tenant isolation', async () => {
    const clock = createMutableClock();
    const harness = createHarness({ clock, presenceTtlMs: 60_000, presenceMinimumIntervalMs: 0 });
    const active = await harness.pairDevice(TENANT_A);
    const online = await harness.pairDevice(TENANT_A);
    const thinking = await harness.pairDevice(TENANT_A);
    const error = await harness.pairDevice(TENANT_A);
    const offline = await harness.pairDevice(TENANT_A);
    const residual = await harness.pairDevice(TENANT_A);
    const otherTenant = await harness.pairDevice(TENANT_B);

    const presenceResponse = await harness.request('/byok/presence', {
      method: 'PUT',
      headers: {
        ...active.authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        level: 'working',
        clientVersion: '0.4.2',
        protocolVersions: [1],
        runtimes: [{ id: 'pi', version: '1.0.0', authPresent: true }],
      }),
    });
    expect(presenceResponse.status).toBe(200);
    await expect(harness.core.presence.read(TENANT_A, active.deviceId)).resolves.toMatchObject({
      clientVersion: '0.4.2',
      protocolVersions: [1],
      runtimes: [{ id: 'pi', version: '1.0.0', authPresent: true }],
    });
    await harness.core.presence.publish(TENANT_A, {
      deviceId: residual.deviceId,
      level: 'online',
      ttlMs: 60_000,
      minimumIntervalMs: 0,
    });
    await Promise.all([
      harness.core.presence.publish(TENANT_A, {
        deviceId: online.deviceId,
        level: 'online',
        ttlMs: 60_000,
        minimumIntervalMs: 0,
      }),
      harness.core.presence.publish(TENANT_A, {
        deviceId: thinking.deviceId,
        level: 'thinking',
        ttlMs: 60_000,
        minimumIntervalMs: 0,
      }),
      harness.core.presence.publish(TENANT_A, {
        deviceId: error.deviceId,
        level: 'error',
        ttlMs: 60_000,
        minimumIntervalMs: 0,
      }),
      harness.core.presence.publish(TENANT_A, {
        deviceId: offline.deviceId,
        level: 'offline',
        ttlMs: 60_000,
        minimumIntervalMs: 0,
      }),
    ]);
    await harness.core.presence.publish(TENANT_B, {
      deviceId: otherTenant.deviceId,
      level: 'thinking',
      ttlMs: 60_000,
      minimumIntervalMs: 0,
    });
    await harness.cloud.revokeDevice(TENANT_A, residual.deviceId);

    expect(await harness.cloud.readTenantReadiness(TENANT_A)).toMatchObject({
      tenantId: TENANT_A,
      activePairedDeviceCount: 5,
      // Structurally zero: revocation deleted the row, so there is nothing
      // left to count as revoked and nothing left to project presence for.
      revokedDeviceCount: 0,
      observedPresenceCount: 5,
      observedPresenceByLevel: {
        online: 1,
        thinking: 1,
        working: 1,
        error: 1,
        offline: 1,
      },
    });
    expect((await harness.cloud.readTenantReadiness(TENANT_A)).devices).toEqual(
      expect.arrayContaining([
        {
          deviceId: active.deviceId,
          productId: 'test-product',
          deviceName: 'test-device',
          revoked: false,
          presence: {
            level: 'working',
            clientVersion: '0.4.2',
            protocolVersions: [1],
            runtimes: [{ id: 'pi', version: '1.0.0', authPresent: true }],
            observedAt: '2026-01-01T00:00:00.000Z',
            expiresAt: '2026-01-01T00:01:00.000Z',
          },
        },
      ]),
    );
    // The revoked device is not "listed as revoked" — it is not listed. Its
    // presence hint was published and is still unexpired, and it contributes
    // to nothing, because the durable row it hung off is gone.
    const afterRevoke = await harness.cloud.readTenantReadiness(TENANT_A);
    expect(afterRevoke.devices).toHaveLength(5);
    expect(afterRevoke.devices.map((device) => device.deviceId)).not.toContain(residual.deviceId);
    expect(afterRevoke.devices.every((device) => !device.revoked)).toBe(true);
    expect(await harness.stores.devices.get(TENANT_A, residual.deviceId)).toBeUndefined();
    expect(await harness.stores.devices.list(TENANT_A)).toHaveLength(5);
    const onlinePresence = (await harness.cloud.readTenantReadiness(TENANT_A)).devices.find(
      (device) => device.deviceId === online.deviceId,
    )?.presence;
    expect(onlinePresence).toMatchObject({ level: 'online' });
    expect(onlinePresence).not.toHaveProperty('clientVersion');
    expect(onlinePresence).not.toHaveProperty('protocolVersions');
    expect(onlinePresence).not.toHaveProperty('runtimes');
    expect(await harness.cloud.readTenantReadiness(TENANT_B)).toMatchObject({
      activePairedDeviceCount: 1,
      revokedDeviceCount: 0,
      observedPresenceCount: 1,
      observedPresenceByLevel: { thinking: 1 },
    });
    expect((await harness.cloud.readTenantReadiness(TENANT_B)).devices).toHaveLength(1);

    clock.advance(60_000);
    expect(await harness.cloud.readTenantReadiness(TENANT_A)).toMatchObject({
      activePairedDeviceCount: 5,
      revokedDeviceCount: 0,
      observedPresenceCount: 0,
    });
    const expired = await harness.cloud.readTenantReadiness(TENANT_A);
    expect(expired.devices).toHaveLength(5);
    const expiredActive = expired.devices.find((device) => device.deviceId === active.deviceId);
    expect(expiredActive).toMatchObject({ deviceId: active.deviceId, revoked: false });
    expect(expiredActive).not.toHaveProperty('presence');
    expect(expired.devices.find((device) => device.deviceId === residual.deviceId)).toBeUndefined();
    expect(await harness.cloud.readTenantReadiness(TENANT_B)).toMatchObject({
      activePairedDeviceCount: 1,
      revokedDeviceCount: 0,
      observedPresenceCount: 0,
      observedPresenceByLevel: { thinking: 0 },
    });
  });
});
