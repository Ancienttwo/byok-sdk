/**
 * Real Postgres evidence for pairing enrollment's all-or-nothing boundary.
 *
 * The trigger is test-local DDL, not a product fault hook: it raises after the
 * guarded code update has selected a valid row but before device insertion can
 * finish. A retry proves the enclosing transaction rolled the code update back.
 */
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { migrate } from '../migrate';
import { PostgresDeviceDirectory } from '../stores/devices';
import { PostgresPairingCodeStore } from '../stores/pairing-codes';
import { createDataplaneScope, SKIP_DATAPLANE } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('tenant-pairing-transaction');
const MACHINE_ID = '11'.repeat(32);

function enrollment(pairingCode: string, deviceId: string, machineId?: string) {
  return {
    pairingCode,
    deviceId,
    deviceName: `name-${deviceId}`,
    devicePublicKey: `pk-${deviceId}`,
    proofKeyId: 'identity',
    proofKeyEpoch: 0,
    ...(machineId === undefined ? {} : { machineId }),
  };
}

describe.skipIf(SKIP_DATAPLANE)('Postgres pairing enrollment transaction', () => {
  it('rolls back code consumption when the device insert fails, then permits retry', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const pairing = new PostgresPairingCodeStore(scope.pool, clock);
      const devices = new PostgresDeviceDirectory(scope.pool, clock);
      await pairing.issue(TENANT, {
        code: 'retry-after-device-failure',
        productId: 'product-transaction',
        expiresAt: new Date(clock.now().getTime() + 600_000).toISOString(),
      });
      await devices.register(TENANT, {
        productId: 'product-transaction',
        deviceId: 'device-predecessor',
        deviceName: 'predecessor',
        devicePublicKey: 'pk-predecessor',
        proofKeyId: 'identity',
        proofKeyEpoch: 0,
        machineId: MACHINE_ID,
      });

      await scope.pool.query(`
        CREATE FUNCTION fail_pairing_device_insert() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'injected pairing device insert failure';
        END;
        $$;
      `);
      await scope.pool.query(`
        CREATE TRIGGER fail_pairing_device_insert
        BEFORE INSERT ON device
        FOR EACH ROW EXECUTE FUNCTION fail_pairing_device_insert();
      `);

      await expect(
        pairing.redeemAndRegister(
          enrollment('retry-after-device-failure', 'device-failed', MACHINE_ID),
        ),
      ).rejects.toThrow('injected pairing device insert failure');
      expect(await devices.get(TENANT, 'device-failed')).toBeUndefined();
      expect(await devices.get(TENANT, 'device-predecessor')).toBeDefined();
      expect(await devices.list(TENANT)).toHaveLength(1);
      await expect(
        scope.pool.query<{ redeemed_at: string | null }>(
          'SELECT redeemed_at FROM pairing_code WHERE code = $1',
          ['retry-after-device-failure'],
        ),
      ).resolves.toMatchObject({ rows: [{ redeemed_at: null }] });

      await scope.pool.query('DROP TRIGGER fail_pairing_device_insert ON device');
      await expect(
        pairing.redeemAndRegister(
          enrollment('retry-after-device-failure', 'device-retry', MACHINE_ID),
        ),
      ).resolves.toMatchObject({
        tenantId: TENANT,
        productId: 'product-transaction',
        deviceId: 'device-retry',
      });
      expect(await devices.get(TENANT, 'device-predecessor')).toBeUndefined();
      expect(await devices.list(TENANT)).toHaveLength(1);
    } finally {
      await scope.dispose();
    }
  });

  it('allows only one concurrent enrollment of one code', async () => {
    const scope = await createDataplaneScope();
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const clock = createMutableClock();
      const pairing = new PostgresPairingCodeStore(scope.pool, clock);
      const devices = new PostgresDeviceDirectory(scope.pool, clock);
      await pairing.issue(TENANT, {
        code: 'concurrent-enrollment',
        productId: 'product-transaction',
        expiresAt: new Date(clock.now().getTime() + 600_000).toISOString(),
      });

      const results = await Promise.all([
        pairing.redeemAndRegister(enrollment('concurrent-enrollment', 'device-a')),
        pairing.redeemAndRegister(enrollment('concurrent-enrollment', 'device-b')),
      ]);
      const enrolled = results.filter((device) => device !== undefined);
      expect(enrolled).toHaveLength(1);
      expect(await devices.list(TENANT)).toHaveLength(1);
      expect(await pairing.redeemAndRegister(enrollment('concurrent-enrollment', 'device-c'))).toBeUndefined();
    } finally {
      await scope.dispose();
    }
  });
});
