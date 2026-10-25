import type { PoolClient } from 'pg';
import { DEVICE_SWITCHING, type SyncRefusal } from '@byok-sdk/example-bot-collaboration/rules/commands';
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

/**
 * A write that can create execution found its device frozen by an open owner switch (§4.1, #957). Nothing was written.
 * It is the typed "switching" refusal: retry after the switch. L throws its own error with the same `code`.
 */
export class DeviceSwitchingError extends Error {
  readonly code = DEVICE_SWITCHING;
  constructor(readonly deviceId: string, readonly target: 'L' | 'H', readonly revision: number) {
    super(`Device is switching to ${target}: ${deviceId}`);
    this.name = 'DeviceSwitchingError';
  }
}
/** A switch step that the device's binding refuses (#957). Nothing was written. */
export class DeviceSwitchRefusedError extends Error {
  readonly code = 'switch_refused' as const;
  constructor(readonly deviceId: string, readonly reason: 'stale_revision' | 'switching' | 'not_switching' | 'same_mode' | 'revoked' | 'not_owner' | 'open_work',
    message: string) {
    super(message);
    this.name = 'DeviceSwitchRefusedError';
  }
}

type BindingRow = { mode: 'L' | 'H'; mode_revision: string; revoked: boolean; switching: 'L' | 'H' | null };
/** A device's binding row as the switch steps return it, read back in the transaction that wrote it. */
export interface DeviceBinding { mode: 'L' | 'H'; revision: number; switching?: 'L' | 'H'; revoked: boolean }
/** Why a device's binding row refuses new execution, or nothing for an active binding in mode H with no open switch. */
function refusalOf(row: BindingRow | undefined): SyncRefusal | undefined {
  if (!row) return 'unbound';
  if (row.revoked) return 'revoked';
  if (row.switching) return 'switching';
  return row.mode === 'H' ? undefined : 'mode';
}
const BINDING = `SELECT device, mode, mode_revision::text, revoked_at IS NOT NULL AS revoked, switching FROM device_binding WHERE scope = $1`;
const readRow = async (client: PoolClient, scopeKey: string, deviceId: string) =>
  (await client.query<BindingRow>(`${BINDING} AND device = $2`, [scopeKey, storedKey(deviceId)])).rows[0];
const viewOf = (row: BindingRow): DeviceBinding =>
  ({ mode: row.mode, revision: Number(row.mode_revision), ...(row.switching ? { switching: row.switching } : {}), revoked: row.revoked });

/**
 * The mode revision of the device's binding. Throws `DeviceBindingError` unless the binding is active and in mode H, and
 * `DeviceSwitchingError` while an owner switch of the device is open.
 */
export async function activeBinding(client: PoolClient, scopeKey: string, deviceId: string): Promise<number> {
  const row = await readRow(client, scopeKey, deviceId), refusal = refusalOf(row);
  if (refusal === 'switching') throw new DeviceSwitchingError(deviceId, row!.switching!, Number(row!.mode_revision));
  if (refusal) throw new DeviceBindingError(deviceId, refusal);
  return Number(row!.mode_revision);
}

/**
 * The owner-switch fence of a write that #956 lets through for an unbound device (#957): it throws `DeviceSwitchingError`
 * while a switch of the device is open, and `DeviceBindingError` with `mode` once the device's row names mode L. A device
 * with no row, a revoked one and one bound to H pass: the sync holds or runs their work as before.
 */
export async function switchFence(client: PoolClient, scopeKey: string, deviceId: string): Promise<void> {
  const row = await readRow(client, scopeKey, deviceId), refusal = row && refusalOf(row);
  if (refusal === 'switching') throw new DeviceSwitchingError(deviceId, row!.switching!, Number(row!.mode_revision));
  if (refusal === 'mode') throw new DeviceBindingError(deviceId, 'mode');
}

/**
 * The device's row names mode L and is not revoked (#957): L owns it, or owns it until an open switch to H commits. H then
 * leaves the Agent home writes of its Bots to L. A device with no row, or a revoked one, keeps the flush it had before.
 */
export async function ownedByL(client: PoolClient, scopeKey: string, deviceId: string): Promise<boolean> {
  const row = await readRow(client, scopeKey, deviceId);
  return row !== undefined && !row.revoked && row.mode === 'L';
}

/**
 * The K8 `deviceRefusal` of each of these devices (#956), read in one query: the reason that `activeBinding` would throw,
 * and no entry for a device with an active binding in mode H.
 */
export async function deviceRefusals(client: PoolClient, scopeKey: string, deviceIds: readonly string[]): Promise<Map<string, SyncRefusal>> {
  const rows = new Map((await client.query<BindingRow & { device: string }>(`${BINDING} AND device = ANY($2::text[])`,
    [scopeKey, deviceIds.map(storedKey)])).rows.map(row => [JSON.parse(row.device) as string, row]));
  return new Map(deviceIds.flatMap(id => {
    const refusal = refusalOf(rows.get(id));
    return refusal ? [[id, refusal] as const] : [];
  }));
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
  // A revoke ends an open switch too: no switch step applies to a revoked device, so the row must not stay frozen.
  await client.query(`UPDATE device_binding SET revoked_at = $3, mode_revision = mode_revision + 1, switching = NULL
    WHERE scope = $1 AND device = $2 AND revoked_at IS NULL`, [scopeKey, storedKey(deviceId), revokedAt]);
}

/**
 * Opens an owner switch of a device toward `target` on the expected mode revision (§4.1, #957): the freeze. It raises the
 * revision, so a submit claimed before the freeze fails its re-read, and every later step names the frozen revision. A
 * device with no row is in the default mode L at revision 0, so an existing L device starts its switch to H here, with a
 * mode L row. Returns the row read back. The caller holds the scope lock.
 */
export async function beginSwitch(client: PoolClient, scopeKey: string, deviceId: string, target: 'L' | 'H', expectedRevision: number): Promise<DeviceBinding> {
  const row = await readRow(client, scopeKey, deviceId);
  if (!row) {
    if (target !== 'H') throw new DeviceSwitchRefusedError(deviceId, 'same_mode', `Device is already in mode L: ${deviceId}`);
    if (expectedRevision !== 0) throw stale(deviceId, expectedRevision, 0);
    await client.query(`INSERT INTO device_binding (scope, device, ordinal, mode, mode_revision, switching)
      SELECT $1, $2, coalesce(max(ordinal) + 1, 0), 'L', 1, 'H' FROM device_binding WHERE scope = $1`, [scopeKey, storedKey(deviceId)]);
  } else {
    refuseUnless(deviceId, row, expectedRevision, false);
    if (row.mode === target) throw new DeviceSwitchRefusedError(deviceId, 'same_mode', `Device is already in mode ${target}: ${deviceId}`);
    await client.query('UPDATE device_binding SET switching = $3, mode_revision = mode_revision + 1 WHERE scope = $1 AND device = $2',
      [scopeKey, storedKey(deviceId), target]);
  }
  return viewOf((await readRow(client, scopeKey, deviceId))!);
}

/**
 * Ends the open switch of a device on the expected (frozen) revision and raises the revision: `commit` makes the target the
 * owner mode, `abort` keeps the old one. The caller checks the device's open work before a commit and holds the scope lock.
 */
export async function endSwitch(client: PoolClient, scopeKey: string, deviceId: string, expectedRevision: number, end: 'commit' | 'abort'): Promise<DeviceBinding> {
  await openSwitch(client, scopeKey, deviceId, expectedRevision);
  await client.query(`UPDATE device_binding SET mode = CASE WHEN $3 THEN switching ELSE mode END, switching = NULL,
    mode_revision = mode_revision + 1 WHERE scope = $1 AND device = $2`, [scopeKey, storedKey(deviceId), end === 'commit']);
  return viewOf((await readRow(client, scopeKey, deviceId))!);
}

/** The open switch of a device on the expected (frozen) revision. Throws `DeviceSwitchRefusedError` otherwise. */
export async function openSwitch(client: PoolClient, scopeKey: string, deviceId: string, expectedRevision: number): Promise<DeviceBinding> {
  const row = await readRow(client, scopeKey, deviceId);
  if (!row) throw new DeviceSwitchRefusedError(deviceId, 'not_switching', `Device has no open switch: ${deviceId}`);
  refuseUnless(deviceId, row, expectedRevision, true);
  return viewOf(row);
}

/** A switch step needs a device that is not revoked, at the expected revision, with (`open`) or without an open switch. */
function refuseUnless(deviceId: string, row: BindingRow, expectedRevision: number, open: boolean): void {
  if (row.revoked) throw new DeviceSwitchRefusedError(deviceId, 'revoked', `Device is revoked: ${deviceId}`);
  if (open && !row.switching) throw new DeviceSwitchRefusedError(deviceId, 'not_switching', `Device has no open switch: ${deviceId}`);
  if (!open && row.switching) throw new DeviceSwitchRefusedError(deviceId, 'switching', `Device already has an open switch: ${deviceId}`);
  if (Number(row.mode_revision) !== expectedRevision) throw stale(deviceId, expectedRevision, Number(row.mode_revision));
}
const stale = (deviceId: string, expected: number, actual: number) =>
  new DeviceSwitchRefusedError(deviceId, 'stale_revision', `Device ${deviceId} is at mode revision ${actual}, not ${expected}`);
