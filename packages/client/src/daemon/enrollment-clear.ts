import { acquireDaemonOwner, assertDaemonOwnerAvailable, DaemonOwnerActiveError, DaemonOwnerReclaimingError, type DaemonOwnerLease } from '../util/daemon-owner.js';
import { acquireEnrollmentGate } from './enrollment-gate.js';
import {
  DeviceRecordRePairRequiredError, DeviceStore, readEnrollmentOptions, readStoreEnrollment,
  type DeviceEnrollmentStatusOptions, type DeviceRecord,
} from './store.js';
import { DeviceStoreBindingMismatchError } from './daemon-errors.js';
import { createDeviceCredentialStore, createDeviceMemberCustody } from './device-credential-provider.js';
import { DeviceMemberRecords } from './device-member-custody.js';
import { DeviceCredentialLegacyEntryError, type DeviceCredentialBackend, type PairingAttempt } from './device-credential-store.js';

const CLEAR_MESSAGES = {
  store_owned: 'another process holds this store\'s owner lease (a daemon, doctor or installer); the enrollment is unchanged',
  store_not_bound: 'the OS credential entry for this productId holds an enrollment or pairing attempt of another storeDir; nothing was cleared',
  clear_failed: 'the device enrollment could not be cleared; see the cause',
} as const;

export type DeviceEnrollmentClearErrorCode = keyof typeof CLEAR_MESSAGES;

/**
 * Why a device enrollment clear refused or failed:
 * - `store_owned`: another process holds the store's owner lease. It may be a
 *   running daemon, a doctor or an installer; nothing was read or cleared.
 * - `store_not_bound`: the OS entry holds an enrollment another storeDir
 *   paired, or a pairing attempt another storeDir staged; nothing was
 *   cleared.
 * - `clear_failed`: `cause` holds the error. A `device.json` that cannot be
 *   parsed or is empty (`DeviceRecordRePairRequiredError`) is refused before
 *   anything is deleted; the store needs a re-pair. The clear deletes the
 *   member entries one by one (pairing verification, member state, member
 *   keys), then the device credential, each read back after its deletion. A
 *   provider failure can come after some of those deletions (a deletion or
 *   read-back that fails or times out). The store's state then follows
 *   whether the device credential is still there, not the step that failed:
 *   with it the device is paired, without it (deleted by this clear or an
 *   earlier one) `device.json` remains and reads as re-pair-required. A failed
 *   `device.json` removal after the credential was deleted leaves the same
 *   state. E2EE is lost once `member-state` or `member-keys` is deleted; a
 *   device still completing its E2EE pairing also loses that pairing with
 *   the pairing verification. A retry clears whatever remains (#1965). An
 *   injected `DeviceCredentialBackend`'s error is the `cause` unchanged; such
 *   a backend must not put secrets in its errors.
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
 * {@link clearDeviceEnrollment}; the caller holds the store's owner lease,
 * and the clear takes the productId gate ({@link acquireEnrollmentGate}).
 * `readCurrent` reads the bound enrollment under that lease, so another
 * store's OS entry is refused before anything is deleted. A `device.json`
 * that cannot be parsed is refused too, with its
 * `DeviceRecordRePairRequiredError`: nothing proves the productId-wide OS
 * entry is this store's, and `remove()` could never delete that file. A valid
 * projection without its credential (left by a failed metadata removal) is
 * cleared. A staged pairing attempt is deleted only when this store staged
 * it; another store's attempt is refused as `store_not_bound`. A wire v6
 * entry is void and deleted unread. The member entries
 * go first, each read back after deletion, then the credential, also read
 * back. A failure leaves the device paired if its credential is still there,
 * possibly with some member entries deleted, and otherwise leaves
 * `device.json` without its credential. `onCredentialCleared` runs once the
 * credential is gone, before `device.json` is removed. Returns the cleared
 * enrollment, or undefined when the store held no readable one.
 */
export async function clearEnrollmentUnderLease(
  custody: EnrollmentCustody,
  readCurrent: () => Promise<DeviceRecord | undefined>,
  onCredentialCleared: () => void = () => {},
): Promise<DeviceRecord | undefined> {
  const gate = await acquireEnrollmentGate(custody.store.productId);
  try {
    const current = await readClearableEnrollment(custody.store, readCurrent);
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
  } finally {
    await gate.release();
  }
}

async function readClearableEnrollment(
  store: DeviceStore,
  readCurrent: () => Promise<DeviceRecord | undefined>,
): Promise<DeviceRecord | undefined> {
  let current: DeviceRecord | undefined;
  try {
    current = await readCurrent();
  } catch (error) {
    if (!(error instanceof DeviceCredentialLegacyEntryError) && !(error instanceof DeviceRecordRePairRequiredError)) throw error;
    // A valid projection without its credential can be cleared. An invalid
    // projection throws on load before the clear can delete anything.
    await store.load();
  }
  const attempt = await readAttempt(store.credentials);
  if (attempt !== undefined && attempt.storeIdentity !== store.identity) {
    throw new DeviceEnrollmentClearError('store_not_bound');
  }
  return current;
}

/** The staged attempt; a wire v6 entry holds none this clear could refuse. */
async function readAttempt(credentials: DeviceCredentialBackend): Promise<PairingAttempt | undefined> {
  try {
    return await credentials.readPairingAttempt();
  } catch (error) {
    if (error instanceof DeviceCredentialLegacyEntryError) return undefined;
    throw error;
  }
}

function composeClearStore(
  options: DeviceEnrollmentStatusOptions & { readonly storeDir: string },
  overrides: { readonly deviceCredentials?: DeviceCredentialBackend } | undefined,
  operation: string,
) {
  const { productId, storeDir: configuredStoreDir, deviceCredentials, nativeAssetRoot } = readEnrollmentOptions(options);
  if (configuredStoreDir === undefined || configuredStoreDir.length === 0) {
    throw new TypeError(`${operation} requires a non-empty storeDir`);
  }
  const storeDir = DeviceStore.resolveDir(productId, configuredStoreDir);
  const provider = { productId, storeDir, deviceCredentials, nativeAssetRoot };
  const injected = overrides?.deviceCredentials;
  const store = new DeviceStore(productId, storeDir, injected ?? createDeviceCredentialStore(provider));
  return { store, provider, injected };
}

async function readCurrentEnrollment(store: DeviceStore): Promise<DeviceRecord | undefined> {
  const read = await readStoreEnrollment(store);
  if (read.state === 're_pair_required') throw new DeviceRecordRePairRequiredError();
  return read.state === 'paired' ? read.record : undefined;
}

function ownerRefusal(error: unknown): DeviceEnrollmentClearError {
  const owned = error instanceof DaemonOwnerActiveError || error instanceof DaemonOwnerReclaimingError;
  return new DeviceEnrollmentClearError(owned ? 'store_owned' : 'clear_failed', { cause: error });
}

function enrollmentRefusal(error: unknown): DeviceEnrollmentClearError {
  if (error instanceof DeviceEnrollmentClearError) return error;
  const code = error instanceof DeviceStoreBindingMismatchError ? 'store_not_bound' : 'clear_failed';
  return new DeviceEnrollmentClearError(code, { cause: error });
}

/**
 * Checks for a store owner or another store's enrollment or staged pairing
 * attempt before {@link clearDeviceEnrollment}. Uses the calling process's OS
 * credential set. Takes no store lease or enrollment gate and changes no files
 * or credentials. Inspection failures reject, including an unreadable
 * enrollment or invalid `device.json` (`DeviceEnrollmentClearError` with code
 * `clear_failed`).
 *
 * This is a point-in-time hint. `ok: true` means neither refusal was observed.
 * During store path gate operations, including after the mutex binds and before
 * ownership is published, the owner check can pass. Ownership or enrollment can
 * change before the clear. The clear acquires its own lease and checks enrollment
 * again under the productId gate.
 */
export async function inspectDeviceEnrollmentClear(
  options: DeviceEnrollmentStatusOptions & { readonly storeDir: string },
  overrides?: { readonly deviceCredentials?: DeviceCredentialBackend },
): Promise<{ ok: true } | { ok: false; code: 'store_owned' | 'store_not_bound' }> {
  const { store, provider } = composeClearStore(options, overrides, 'inspectDeviceEnrollmentClear');
  try {
    await assertDaemonOwnerAvailable(provider.storeDir);
  } catch (error) {
    const refusal = ownerRefusal(error);
    if (refusal.code === 'store_owned') return { ok: false, code: refusal.code };
    throw refusal;
  }
  try {
    await readClearableEnrollment(store, () => readCurrentEnrollment(store));
  } catch (error) {
    const refusal = enrollmentRefusal(error);
    if (refusal.code === 'store_not_bound') return { ok: false, code: refusal.code };
    throw refusal;
  }
  return { ok: true };
}

/**
 * Clears one store's device enrollment without a daemon: its member
 * entries, its OS credential (read back after deletion) and `device.json`,
 * under the store's owner lease. It never reads Host secrets, returns no
 * secret and makes no network call. Clearing a store that holds no
 * enrollment succeeds. Unlike `Daemon.unpair()` it leaves the delivery cursor
 * file, which no later pairing reads because each pairing mints a new device
 * id. It reads the calling process's OS credential set, so it clears the
 * enrollment of the account it runs as. The OS credential entry is shared by
 * every store of one productId: the clear never deletes another store's
 * enrollment or staged first pairing, and it excludes their pairing and
 * renewal writes while it runs (#1964, #2034). A wire v6 entry is deleted
 * unread.
 */
export async function clearDeviceEnrollment(
  options: DeviceEnrollmentStatusOptions & { readonly storeDir: string },
  overrides?: { readonly deviceCredentials?: DeviceCredentialBackend },
): Promise<void> {
  const { store, provider, injected } = composeClearStore(options, overrides, 'clearDeviceEnrollment');
  // Composition only reads once the lease is held. An injected backend has
  // no member custody, as in a daemon built with one.
  const custody: EnrollmentCustody = {
    store,
    memberRecords: injected === undefined ? new DeviceMemberRecords(createDeviceMemberCustody(provider)) : undefined,
  };
  let lease: DaemonOwnerLease;
  try {
    lease = await acquireDaemonOwner(provider.storeDir, 'installer');
  } catch (error) {
    throw ownerRefusal(error);
  }
  try {
    await clearEnrollmentUnderLease(custody, () => readCurrentEnrollment(store));
  } catch (error) {
    throw enrollmentRefusal(error);
  } finally {
    await lease.release();
  }
}
