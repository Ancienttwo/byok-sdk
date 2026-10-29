import type { HarnessInfo } from '@byok-sdk/protocol';
/**
 * In-memory {@link DeviceDirectory}.
 *
 * Rows live under a `(tenant, deviceId)` composite key, so a cross-tenant read
 * is not "denied" — it addresses a different key space and finds nothing
 * (§12.6.2 layer 3). The pre-tenant index below maps a deviceId to that same
 * composite key, so a revocation applied through the composite key is
 * immediately visible to `/byok/challenge` and `/byok/token` with no second
 * copy to keep in sync — and a deleted row is removed from BOTH in one step.
 *
 * Revocation DELETES. `DeviceRecord.revoked` survives as the field every auth
 * path already reads, but no record this store writes ever carries `true`:
 * revocation and machine supersession remove the record outright, so "revoked"
 * and "never registered" are one indistinguishable answer rather than two.
 *
 * A removed device is retired through the task state and the mailbox the
 * composition hands in: its unfinished attempts are settled and its pending
 * rows dead-lettered (see `DeviceDirectory` in `../ports`). Registration and
 * revocation run one at a time, so a retirement never overlaps a later
 * registration of the same device id, and a failed mailbox expiry puts the
 * registrations back before anything else moved: the in-memory stand-in for
 * the SQL stores' one transaction (#1119).
 */
import {
  PRESENCE_LEVELS,
  tenantKey,
  type MailboxStore,
  type PresenceStore,
  type TenantId,
  type TenantReadinessDevice,
  type TenantReadiness,
} from '@byok-sdk/core';
import type { DeviceDirectory, DeviceRecord, DeviceRegistration } from '../ports';
import type { InMemoryTaskAttemptState } from './task-attempts';
import { settleDeviceAttempts } from './task-retirement';

export class InMemoryDeviceDirectory implements DeviceDirectory {
  readonly #byTenant = new Map<string, DeviceRecord>();
  readonly #byDeviceId = new Map<string, string>();
  readonly #tasks: InMemoryTaskAttemptState;
  readonly #mailbox: MailboxStore;
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(tasks: InMemoryTaskAttemptState, mailbox: MailboxStore) {
    this.#tasks = tasks;
    this.#mailbox = mailbox;
  }

  register(tenant: TenantId, input: DeviceRegistration): Promise<DeviceRecord> {
    return this.#serialized(() => this.#register(tenant, input));
  }

  async #register(tenant: TenantId, input: DeviceRegistration): Promise<DeviceRecord> {
    const record: DeviceRecord = {
      tenantId: tenant,
      productId: input.productId,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      devicePublicKey: input.devicePublicKey,
      proofKeyId: input.proofKeyId,
      proofKeyEpoch: input.proofKeyEpoch,
      // Always false, and there is no writer that sets it true — see the file
      // header. The field stays because every auth path reads it.
      revoked: false,
      ...(input.machineId === undefined ? {} : { machineId: input.machineId }),
    };
    // One physical machine, one device row per product. The scan is
    // deliberately narrowed by tenant AND product AND a present machineId:
    // an absent machineId matches nothing, so devices that could not identify
    // their machine never supersede each other. Prior rows are DELETED, not
    // flagged: a superseded grant that lingers as a row is a credential the
    // directory still has to remember to exclude on every read path, and the
    // history of which machine held which grant belongs to the audit surfaces
    // keyed by device id (tasks, egress, proof receipts), not to the directory.
    //
    // The device being registered is skipped: re-pairing the SAME deviceId is
    // an in-place replacement below, not a supersession of itself.
    const superseded: Array<readonly [string, DeviceRecord]> = [];
    if (input.machineId !== undefined) {
      for (const [key, existing] of [...this.#byTenant]) {
        if (existing.deviceId === record.deviceId) continue;
        if (existing.tenantId !== tenant) continue;
        if (existing.productId !== input.productId) continue;
        if (existing.machineId !== input.machineId) continue;
        superseded.push([key, existing]);
      }
    }
    const key = tenantKey(tenant, record.deviceId);
    const replaced = this.#byTenant.get(key);
    for (const [supersededKey, existing] of superseded) this.#forget(supersededKey, existing.deviceId);
    this.#remember(key, record);
    try {
      for (const [, existing] of superseded) await this.#mailbox.expirePending(tenant, { deviceId: existing.deviceId, seqs: 'all' });
    } catch (caught) {
      if (replaced === undefined) this.#forget(key, record.deviceId);
      else this.#remember(key, replaced);
      for (const [supersededKey, existing] of superseded) this.#remember(supersededKey, existing);
      throw caught;
    }
    for (const [, existing] of superseded) {
      await settleDeviceAttempts(this.#tasks, tenant, existing.deviceId, 'device_superseded');
    }
    return record;
  }

  async get(tenant: TenantId, deviceId: string): Promise<DeviceRecord | undefined> {
    return this.#byTenant.get(tenantKey(tenant, deviceId));
  }

  /**
   * Revocation removes the registration. A no-op for a device this tenant does
   * not own: revoking what you cannot address changes nothing.
   */
  revoke(tenant: TenantId, deviceId: string): Promise<void> {
    return this.#serialized(async () => {
      const key = tenantKey(tenant, deviceId);
      const record = this.#byTenant.get(key);
      if (record === undefined) return;
      this.#forget(key, deviceId);
      try {
        await this.#mailbox.expirePending(tenant, { deviceId, seqs: 'all' });
      } catch (caught) {
        this.#remember(key, record);
        throw caught;
      }
      await settleDeviceAttempts(this.#tasks, tenant, deviceId, 'device_revoked');
    });
  }

  /** Runs registrations and revocations one at a time, whatever the previous one's outcome. */
  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#mutationTail.then(operation, operation);
    this.#mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  #remember(key: string, record: DeviceRecord): void {
    this.#byTenant.set(key, record);
    this.#byDeviceId.set(record.deviceId, key);
  }

  /**
   * Drops a record from the composite map and, only when it still points here,
   * from the pre-tenant index. A re-registration under the same deviceId has
   * already re-pointed that index, and a stale delete would blind
   * `/byok/challenge` to a device that is currently paired.
   */
  #forget(key: string, deviceId: string): void {
    this.#byTenant.delete(key);
    if (this.#byDeviceId.get(deviceId) === key) this.#byDeviceId.delete(deviceId);
  }

  async recordCapabilities(
    tenant: TenantId,
    input: { readonly deviceId: string; readonly harnesses?: readonly HarnessInfo[]; readonly capabilities: readonly string[] },
  ): Promise<DeviceRecord | undefined> {
    const key = tenantKey(tenant, input.deviceId);
    const record = this.#byTenant.get(key);
    if (record === undefined || record.revoked) return undefined;
    const updated: DeviceRecord = {
      ...record,
      capabilities: Object.freeze([...input.capabilities]),
      harnesses: Object.freeze((input.harnesses ?? []).map(value => Object.freeze({ ...value }))),
    };
    this.#byTenant.set(key, updated);
    return updated;
  }

  async list(tenant: TenantId): Promise<readonly DeviceRecord[]> {
    const prefix = tenantKey(tenant, '');
    return [...this.#byTenant.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record);
  }

  async readiness(tenant: TenantId, presence: PresenceStore): Promise<TenantReadiness> {
    const devices = await this.list(tenant);
    const livePresence = await presence.list(tenant);
    const presenceByDevice = new Map(livePresence.map((hint) => [hint.deviceId, hint]));
    const activeDeviceIds = new Set(
      devices.filter((device) => !device.revoked).map((device) => device.deviceId),
    );
    const observedPresenceByLevel = Object.fromEntries(
      PRESENCE_LEVELS.map((level) => [level, 0]),
    ) as Record<(typeof PRESENCE_LEVELS)[number], number>;
    for (const hint of livePresence) {
      if (!activeDeviceIds.has(hint.deviceId)) continue;
      observedPresenceByLevel[hint.level] += 1;
    }
    return {
      tenantId: tenant,
      activePairedDeviceCount: devices.filter((device) => !device.revoked).length,
      revokedDeviceCount: devices.filter((device) => device.revoked).length,
      observedPresenceCount: Object.values(observedPresenceByLevel).reduce(
        (total, count) => total + count,
        0,
      ),
      observedPresenceByLevel,
      devices: [...devices]
        .sort((left, right) => left.deviceId.localeCompare(right.deviceId))
        .map((device): TenantReadinessDevice => {
          const hint = device.revoked ? undefined : presenceByDevice.get(device.deviceId);
          return {
            deviceId: device.deviceId,
            productId: device.productId,
            deviceName: device.deviceName,
            revoked: device.revoked,
            ...(hint === undefined
              ? {}
              : {
                  presence: {
                    level: hint.level,
                    ...(hint.detail === undefined ? {} : { detail: hint.detail }),
                    ...(hint.configuredToolsets === undefined
                      ? {}
                      : { configuredToolsets: hint.configuredToolsets }),
                    ...(hint.clientVersion === undefined ? {} : { clientVersion: hint.clientVersion }),
                    ...(hint.protocolVersions === undefined
                      ? {}
                      : { protocolVersions: hint.protocolVersions }),
                    ...(hint.runtimes === undefined ? {} : { runtimes: hint.runtimes }),
                    observedAt: hint.observedAt,
                    expiresAt: hint.expiresAt,
                  },
                }),
          };
        }),
    };
  }

  async resolveByDeviceId(deviceId: string): Promise<DeviceRecord | undefined> {
    const key = this.#byDeviceId.get(deviceId);
    return key === undefined ? undefined : this.#byTenant.get(key);
  }
}
