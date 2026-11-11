import { acquireDaemonOwner, DaemonOwnerActiveError, DaemonOwnerReclaimingError, type DaemonOwnerLease } from '../util/daemon-owner.js';
import {
  DeviceRecordRePairRequiredError, DeviceStore, readEnrollmentOptions, readStoreEnrollment,
  type DeviceEnrollmentStatusOptions, type DeviceRecord,
} from './store.js';
import { DeviceStoreBindingMismatchError } from './daemon-errors.js';
import { createDeviceCredentialStore, createDeviceMemberCustody } from './device-credential-provider.js';
import { DeviceMemberRecords } from './device-member-custody.js';
import type { DeviceCredentialBackend } from './device-credential-store.js';

const CLEAR_MESSAGES = {
  store_owned: 'another process holds this store\'s owner lease (a daemon, doctor or installer); the enrollment is unchanged',
  store_not_bound: 'the OS credential entry for this productId holds an enrollment this storeDir did not pair; nothing was cleared',
  clear_failed: 'the device enrollment could not be cleared; see the cause',
} as const;

export type DeviceEnrollmentClearErrorCode = keyof typeof CLEAR_MESSAGES;

/**
 * Why a device enrollment clear refused or failed:
 * - `store_owned`: another process holds the store's owner lease. It may be a
 *   running daemon, a doctor or an installer; nothing was read or cleared.
 * - `store_not_bound`: the OS entry holds an enrollment another storeDir
 *   paired; nothing was cleared.
 * - `clear_failed`: `cause` holds the error. A `device.json` that cannot be
 *   parsed (`DeviceRecordRePairRequiredError`) is refused before anything is
 *   deleted; the store needs a re-pair. A credential provider failure leaves
 *   the store paired. A failed `device.json` removal after the credential was
 *   deleted leaves a valid projection without its credential, which a retry
 *   clears.
 */
export class DeviceEnrollmentClearError extends Error {
  constructor(readonly code: DeviceEnrollmentClearErrorCode, options?: ErrorOptions) {
    super(CLEAR_MESSAGES[code], options);
    this.name = 'DeviceEnrollmentClearError';
  }
}

/** One store's enrollment custody: the `device.json` projection, the OS credential and, with the OS provider, the member entries. */
export interface EnrollmentCustody {
  readonly store: DeviceStore;
  readonly memberRecords: { clear(): Promise<void> } | undefined;
}

/**
 * The one enrollment clear, shared by `Daemon.unpair()` and
 * {@link clearDeviceEnrollment}; the caller holds the store's owner lease.
 * `readCurrent` reads the bound enrollment under that lease, so another
 * store's OS entry is refused before anything is deleted. A `device.json`
 * that cannot be parsed is refused too, with its
 * `DeviceRecordRePairRequiredError`: nothing proves the productId-wide OS
 * entry is this store's, and `remove()` could never delete that file. A valid
 * projection without its credential (left by a failed metadata removal) is
 * cleared. The member entries
 * go first and the credential is read back after deletion: any failure up to
 * there leaves the device paired. `onCredentialCleared` runs once the
 * credential is gone, before `device.json` is removed. Returns the cleared
 * enrollment, or undefined when the store held no readable one.
 */
export async function clearEnrollmentUnderLease(
  custody: EnrollmentCustody,
  readCurrent: () => Promise<DeviceRecord | undefined>,
  onCredentialCleared: () => void = () => {},
): Promise<DeviceRecord | undefined> {
  let current: DeviceRecord | undefined;
  try {
    current = await readCurrent();
  } catch (error) {
    if (!(error instanceof DeviceRecordRePairRequiredError)) throw error;
    // Re-pair-required is either a valid projection without its credential,
    // which is cleared, or a projection that cannot be parsed, whose load
    // throws here before anything is deleted.
    await custody.store.load();
  }
  await custody.memberRecords?.clear();
  try {
    await custody.store.credentials.clear();
  } catch (error) {
    throw new DeviceEnrollmentClearError('clear_failed', { cause: error });
  }
  onCredentialCleared();
  // A failure here leaves a valid projection without its credential, which
  // reads as re-pair-required; a retry removes it.
  await custody.store.remove();
  return current;
}

/**
 * Clears one store's device enrollment without a daemon: its member
 * entries, its OS credential (read back after deletion) and `device.json`,
 * under the store's owner lease. It never reads Host secrets, returns no
 * secret and makes no network call. Clearing a store that holds no
 * enrollment succeeds. Unlike `Daemon.unpair()` it leaves the delivery cursor
 * file, which no later pairing reads because each pairing mints a new device
 * id. It reads the calling process's OS credential set, so it clears the
 * enrollment of the account it runs as.
 */
export async function clearDeviceEnrollment(
  options: DeviceEnrollmentStatusOptions & { readonly storeDir: string },
  overrides?: { readonly deviceCredentials?: DeviceCredentialBackend },
): Promise<void> {
  const { productId, storeDir: configuredStoreDir, deviceCredentials, nativeAssetRoot } = readEnrollmentOptions(options);
  if (configuredStoreDir === undefined || configuredStoreDir.length === 0) {
    throw new TypeError('clearDeviceEnrollment requires a non-empty storeDir');
  }
  const injected = overrides?.deviceCredentials;
  const storeDir = DeviceStore.resolveDir(productId, configuredStoreDir);
  const provider = { productId, storeDir, deviceCredentials, nativeAssetRoot };
  // Composition only reads once the lease is held. An injected backend has
  // no member custody, as in a daemon built with one.
  const custody: EnrollmentCustody = {
    store: new DeviceStore(storeDir, injected ?? createDeviceCredentialStore(provider)),
    memberRecords: injected === undefined ? new DeviceMemberRecords(createDeviceMemberCustody(provider)) : undefined,
  };
  let lease: DaemonOwnerLease;
  try {
    lease = await acquireDaemonOwner(storeDir, 'installer');
  } catch (error) {
    const owned = error instanceof DaemonOwnerActiveError || error instanceof DaemonOwnerReclaimingError;
    throw new DeviceEnrollmentClearError(owned ? 'store_owned' : 'clear_failed', { cause: error });
  }
  try {
    await clearEnrollmentUnderLease(custody, async () => {
      const read = await readStoreEnrollment(custody.store);
      if (read.state === 're_pair_required') throw new DeviceRecordRePairRequiredError();
      return read.state === 'paired' ? read.record : undefined;
    });
  } catch (error) {
    if (error instanceof DeviceEnrollmentClearError) throw error;
    if (error instanceof DeviceStoreBindingMismatchError) throw new DeviceEnrollmentClearError('store_not_bound', { cause: error });
    throw new DeviceEnrollmentClearError('clear_failed', { cause: error });
  } finally {
    await lease.release();
  }
}
