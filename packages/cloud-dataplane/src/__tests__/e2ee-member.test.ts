/**
 * The Postgres E2EE member store (#654 E2c): the shared store contract, and
 * the device cleanup that only Postgres runs inside the device transaction.
 */
import { fileURLToPath } from 'node:url';
import { createMutableClock, tenantId, type TenantId } from '@byok-sdk/core';
import { runE2eeMemberStoreConformance } from '@byok-sdk/conformance';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { migrate } from '../migrate';
import { PostgresDeviceDirectory } from '../stores/devices';
import { PostgresE2eeMemberStore } from '../stores/e2ee-member';
import { createDataplaneScope, SKIP_DATAPLANE, SKIP_REASON } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT_A = tenantId('e2ee-cleanup-a');
const TENANT_B = tenantId('e2ee-cleanup-b');
const EXPIRES = '2099-01-01T00:00:00.000Z';
const MACHINE = 'b'.repeat(64);

if (SKIP_DATAPLANE) {
  describe.skip(`E2EE member store [postgres] — ${SKIP_REASON}`, () => { it('needs a dataplane substrate', () => undefined); });
} else {
  runE2eeMemberStoreConformance('postgres', {
    async create() {
      const scope = await createDataplaneScope();
      await migrate(scope.pool, DEPLOY_SQL);
      return { store: new PostgresE2eeMemberStore(scope.pool), dispose: () => scope.dispose() };
    },
  });
}

async function memberRows(pool: Pool, tenant: TenantId, deviceId: string, memberId: string): Promise<Record<string, number>> {
  const count = async (sql: string, params: readonly unknown[]) =>
    Number((await pool.query<{ count: string }>(sql, [...params])).rows[0]!.count);
  return {
    member_key: await count('SELECT count(*)::text AS count FROM e2ee_member_key WHERE tenant_id = $1 AND device_id = $2', [tenant, deviceId]),
    pairing_mac: await count('SELECT count(*)::text AS count FROM e2ee_pairing_mac WHERE tenant_id = $1 AND device_id = $2', [tenant, deviceId]),
    packages: await count('SELECT count(*)::text AS count FROM e2ee_scope_key_package WHERE tenant_id = $1 AND recipient = $2', [tenant, memberId]),
  };
}

async function seed(devices: PostgresDeviceDirectory, store: PostgresE2eeMemberStore, tenant: TenantId, deviceId: string, machineId?: string) {
  await devices.register(tenant, {
    productId: 'product',
    deviceId,
    deviceName: deviceId,
    devicePublicKey: `${deviceId}-public-key`,
    proofKeyId: 'identity',
    proofKeyEpoch: 0,
    ...(machineId === undefined ? {} : { machineId }),
  });
  const memberId = `member-${deviceId}`;
  expect(await store.registerMember(tenant, { deviceId, memberId, bundle: `{"memberId":"${memberId}"}`, deviceMac: 'mac', macExpiresAt: EXPIRES })).toBe('registered');
  expect(await store.putClientPairingMac(tenant, { deviceId, body: '{"mac":"client"}', expiresAt: EXPIRES })).toBe('stored');
  expect(await store.putScopeKeyPackages(tenant, [{
    scopeId: 'scope', epoch: 1, recipient: memberId, keyId: 'key', sender: memberId, package: `{"recipient":"${memberId}"}`,
  }])).toEqual({ outcome: 'stored', stored: 1 });
  return memberId;
}

describe.skipIf(SKIP_DATAPLANE)('Postgres device cleanup removes the device member state', () => {
  it('deletes the revoked device rows and keeps every other device and tenant', async () => {
    const scope = await createDataplaneScope(4);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const devices = new PostgresDeviceDirectory(scope.pool, createMutableClock());
      const store = new PostgresE2eeMemberStore(scope.pool);
      const revoked = await seed(devices, store, TENANT_A, 'revoked-device');
      const kept = await seed(devices, store, TENANT_A, 'kept-device');
      const other = await seed(devices, store, TENANT_B, 'other-device');
      await expect(memberRows(scope.pool, TENANT_A, 'revoked-device', revoked)).resolves.toEqual({ member_key: 1, pairing_mac: 2, packages: 1 });

      await devices.revoke(TENANT_A, 'revoked-device');

      await expect(memberRows(scope.pool, TENANT_A, 'revoked-device', revoked)).resolves.toEqual({ member_key: 0, pairing_mac: 0, packages: 0 });
      await expect(memberRows(scope.pool, TENANT_A, 'kept-device', kept)).resolves.toEqual({ member_key: 1, pairing_mac: 2, packages: 1 });
      await expect(memberRows(scope.pool, TENANT_B, 'other-device', other)).resolves.toEqual({ member_key: 1, pairing_mac: 2, packages: 1 });
      // The chain is tenant history: a revoke never edits it.
      expect(await store.appendChainEntries(TENANT_A, [{ seq: 1, entry: '{}' }])).toEqual({ outcome: 'appended', appended: 1, replayed: 0 });
      await devices.revoke(TENANT_A, 'kept-device');
      expect(await store.readChainEntries(TENANT_A, { afterSeq: 0, limit: 256 })).toEqual([{ seq: 1, entry: '{}' }]);
    } finally {
      await scope.dispose();
    }
  });

  it('deletes the superseded device rows when the same machine pairs again', async () => {
    const scope = await createDataplaneScope(4);
    try {
      await migrate(scope.pool, DEPLOY_SQL);
      const devices = new PostgresDeviceDirectory(scope.pool, createMutableClock());
      const store = new PostgresE2eeMemberStore(scope.pool);
      const old = await seed(devices, store, TENANT_A, 'old-device', MACHINE);
      const fresh = await seed(devices, store, TENANT_A, 'new-device', MACHINE);

      await expect(devices.get(TENANT_A, 'old-device')).resolves.toBeUndefined();
      await expect(memberRows(scope.pool, TENANT_A, 'old-device', old)).resolves.toEqual({ member_key: 0, pairing_mac: 0, packages: 0 });
      await expect(memberRows(scope.pool, TENANT_A, 'new-device', fresh)).resolves.toEqual({ member_key: 1, pairing_mac: 2, packages: 1 });
    } finally {
      await scope.dispose();
    }
  });
});
