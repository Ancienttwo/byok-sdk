import type { PoolClient } from 'pg';
import { storedKey } from './layout';

/**
 * A write that can create execution found no active H binding for its device (#793 D2e). Nothing was written.
 * `revision`: the binding changed between the submit claim and the SDK call.
 */
export class DeviceBindingError extends Error {
  readonly code = 'device_not_bound' as const;
  constructor(readonly deviceId: string, readonly reason: 'unbound' | 'revoked' | 'mode' | 'revision') {
    super(`Device has no active H binding: ${reason}`);
    this.name = 'DeviceBindingError';
  }
}

/** The mode revision of the device's binding. Throws `DeviceBindingError` unless the binding is active and in mode H. */
export async function activeBinding(client: PoolClient, scopeKey: string, deviceId: string): Promise<number> {
  const found = await client.query<{ mode: string; mode_revision: string; revoked: boolean }>(
    'SELECT mode, mode_revision::text, revoked_at IS NOT NULL AS revoked FROM device_binding WHERE scope = $1 AND device = $2',
    [scopeKey, storedKey(deviceId)]);
  const row = found.rows[0];
  if (!row) throw new DeviceBindingError(deviceId, 'unbound');
  if (row.revoked) throw new DeviceBindingError(deviceId, 'revoked');
  if (row.mode !== 'H') throw new DeviceBindingError(deviceId, 'mode');
  return Number(row.mode_revision);
}

/**
 * Binds a device to H at mode revision 1 and returns its revision. A second bind changes nothing. A revoked device id is
 * never bound again (#793 O1 option A): a returning device must pair under a new id. The caller holds the scope lock.
 */
export async function bindDevice(client: PoolClient, scopeKey: string, deviceId: string): Promise<number> {
  const found = await client.query<{ mode: string }>('SELECT mode FROM device_binding WHERE scope = $1 AND device = $2',
    [scopeKey, storedKey(deviceId)]);
  if (found.rows[0]) return activeBinding(client, scopeKey, deviceId);
  await client.query(`INSERT INTO device_binding (scope, device, ordinal, mode, mode_revision)
    SELECT $1, $2, coalesce(max(ordinal) + 1, 0), 'H', 1 FROM device_binding WHERE scope = $1`, [scopeKey, storedKey(deviceId)]);
  return 1;
}

/**
 * Revokes a device id for good (#793 O1 option A): `revoked_at` and a raised mode revision, in one write. A second revoke
 * changes nothing. A device id that was never bound gets a tombstone row in the default mode L at revision 2, so a later
 * bind of that id is refused too. The caller holds the scope lock.
 */
export async function revokeDevice(client: PoolClient, scopeKey: string, deviceId: string, revokedAt: number): Promise<void> {
  const found = await client.query('SELECT 1 FROM device_binding WHERE scope = $1 AND device = $2', [scopeKey, storedKey(deviceId)]);
  if (!found.rows[0]) {
    await client.query(`INSERT INTO device_binding (scope, device, ordinal, mode, mode_revision, revoked_at)
      SELECT $1, $2, coalesce(max(ordinal) + 1, 0), 'L', 2, $3 FROM device_binding WHERE scope = $1`, [scopeKey, storedKey(deviceId), revokedAt]);
    return;
  }
  await client.query(`UPDATE device_binding SET revoked_at = $3, mode_revision = mode_revision + 1
    WHERE scope = $1 AND device = $2 AND revoked_at IS NULL`, [scopeKey, storedKey(deviceId), revokedAt]);
}
