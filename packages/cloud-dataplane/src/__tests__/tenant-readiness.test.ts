import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { migrate } from '../migrate';
import { PostgresDeviceDirectory } from '../stores/devices';
import { createPostgresCoreStores } from '../stores/core/index';
import { createDataplaneScope, POSTGRES_URL, SKIP_REASON } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT_A = tenantId('tenant-readiness-a');
const TENANT_B = tenantId('tenant-readiness-b');

async function register(
  devices: PostgresDeviceDirectory,
  tenant: ReturnType<typeof tenantId>,
  deviceId: string,
): Promise<void> {
  await devices.register(tenant, {
    productId: 'test-product',
    deviceId,
    deviceName: deviceId,
    devicePublicKey: `${deviceId}-public-key`,
    proofKeyId: `${deviceId}-proof-key`,
    proofKeyEpoch: 0,
  });
}

if (POSTGRES_URL === undefined) {
  describe.skip(`Postgres tenant readiness — ${SKIP_REASON}`, () => {
    it('needs a real Postgres substrate', () => undefined);
  });
} else {
  describe('Postgres tenant readiness aggregate', () => {
    it('matches the in-memory expiry/revocation/tenant contract and persists probe facts', async () => {
      const scope = await createDataplaneScope(4);
      try {
        await migrate(scope.pool, DEPLOY_SQL);
        const clock = createMutableClock();
        const core = createPostgresCoreStores({ pool: scope.pool, clock });
        const devices = new PostgresDeviceDirectory(scope.pool, clock);
        await register(devices, TENANT_A, 'readiness-active');
        await register(devices, TENANT_A, 'readiness-online');
        await register(devices, TENANT_A, 'readiness-thinking');
        await register(devices, TENANT_A, 'readiness-error');
        await register(devices, TENANT_A, 'readiness-offline');
        await register(devices, TENANT_A, 'readiness-revoked');
        await register(devices, TENANT_B, 'readiness-other');

        await core.presence.publish(TENANT_A, {
          deviceId: 'readiness-active',
          level: 'working',
          clientVersion: '0.4.2',
          protocolVersions: [1],
          runtimes: [{ id: 'pi', version: '1.0.0', authPresent: true }],
          ttlMs: 60_000,
          minimumIntervalMs: 0,
        });
        await core.presence.publish(TENANT_A, {
          deviceId: 'readiness-revoked',
          level: 'online',
          ttlMs: 60_000,
          minimumIntervalMs: 0,
        });
        await Promise.all([
          core.presence.publish(TENANT_A, {
            deviceId: 'readiness-online',
            level: 'online',
            ttlMs: 60_000,
            minimumIntervalMs: 0,
          }),
          core.presence.publish(TENANT_A, {
            deviceId: 'readiness-thinking',
            level: 'thinking',
            ttlMs: 60_000,
            minimumIntervalMs: 0,
          }),
          core.presence.publish(TENANT_A, {
            deviceId: 'readiness-error',
            level: 'error',
            ttlMs: 60_000,
            minimumIntervalMs: 0,
          }),
          core.presence.publish(TENANT_A, {
            deviceId: 'readiness-offline',
            level: 'offline',
            ttlMs: 60_000,
            minimumIntervalMs: 0,
          }),
        ]);
        await core.presence.publish(TENANT_B, {
          deviceId: 'readiness-other',
          level: 'thinking',
          ttlMs: 60_000,
          minimumIntervalMs: 0,
        });
        await expect(core.presence.read(TENANT_A, 'readiness-revoked')).resolves.toBeDefined();
        await devices.revoke(TENANT_A, 'readiness-revoked');

        // Revocation deletes the registration AND the device-scoped state it
        // was the only reason to keep. Presence is the observable one; the
        // rest is asserted against the tables in `device-revocation.test.ts`.
        await expect(devices.get(TENANT_A, 'readiness-revoked')).resolves.toBeUndefined();
        await expect(core.presence.read(TENANT_A, 'readiness-revoked')).resolves.toBeUndefined();

        await expect(core.presence.read(TENANT_A, 'readiness-active')).resolves.toMatchObject({
          clientVersion: '0.4.2',
          protocolVersions: [1],
          runtimes: [{ id: 'pi', version: '1.0.0', authPresent: true }],
        });
        const readinessA = await devices.readiness(TENANT_A, core.presence);
        expect(readinessA).toMatchObject({
          tenantId: TENANT_A,
          activePairedDeviceCount: 5,
          // Structurally zero: a revoked device has no row left to count.
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
        expect(readinessA.devices).toEqual(expect.arrayContaining([
          {
            deviceId: 'readiness-active',
            productId: 'test-product',
            deviceName: 'readiness-active',
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
        ]));
        expect(readinessA.devices).toHaveLength(5);
        expect(readinessA.devices.map((device) => device.deviceId)).not.toContain('readiness-revoked');
        expect(readinessA.devices.every((device) => !device.revoked)).toBe(true);
        const readinessB = await devices.readiness(TENANT_B, core.presence);
        expect(readinessB).toMatchObject({
          activePairedDeviceCount: 1,
          revokedDeviceCount: 0,
          observedPresenceCount: 1,
          observedPresenceByLevel: { thinking: 1 },
        });
        expect(readinessB.devices[0]?.presence).toMatchObject({ level: 'thinking' });
        expect(readinessB.devices[0]?.presence).not.toHaveProperty('clientVersion');
        expect(readinessB.devices[0]?.presence).not.toHaveProperty('protocolVersions');
        expect(readinessB.devices[0]?.presence).not.toHaveProperty('runtimes');

        clock.advance(60_000);
        await expect(devices.readiness(TENANT_A, core.presence)).resolves.toMatchObject({
          observedPresenceCount: 0,
          observedPresenceByLevel: { working: 0 },
        });
        await expect(devices.readiness(tenantId('tenant-readiness-empty'), core.presence)).resolves.toEqual({
          tenantId: tenantId('tenant-readiness-empty'),
          activePairedDeviceCount: 0,
          revokedDeviceCount: 0,
          observedPresenceCount: 0,
          observedPresenceByLevel: {
            online: 0,
            thinking: 0,
            working: 0,
            error: 0,
            offline: 0,
          },
          devices: [],
        });
      } finally {
        await scope.dispose();
      }
    });
  });
}
