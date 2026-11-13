import {
  constants as fsConstants,
  fstatSync,
  linkSync,
  lstatSync,
  unlinkSync,
  promises as fs,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isTenantId } from '@byok-sdk/core';
import { atomicWriteFile } from '../util/atomic-write.js';
import { pickPlainDataProperties } from '../util/plain-data.js';
import { sameContent, sameFile } from '../util/file-state.js';
import { ensureSecureStoreRoot, type EnsureSecureDirOptions } from '../util/secure-dir.js';
import {
  type DeviceCredentialBackend,
  type DeviceCredentialConfig,
  type DeviceMetadata,
  type DeviceRecord,
} from './device-credential-store.js';
import { createDeviceCredentialStore } from './device-credential-provider.js';
import { DeviceStoreBindingMismatchError } from './daemon-errors.js';
import { foldNameAliases } from '../util/fold-name-aliases.js';
import { defaultStoreDir } from './host-layout.js';

export type { DeviceMetadata, DeviceRecord } from './device-credential-store.js';

/**
 * Non-secret projection of an authenticated device enrollment. This is the
 * complete permitted `device.json` shape. The complete record, including
 * these authenticated metadata fields and secret bytes, lives atomically in
 * DeviceCredentialStore; this file is only its deterministic projection.
 *
 * Internal only: the package root exposes DeviceEnrollment/status, never this
 * storage record.
 */
/** Public credential-blind result of explicit pairing. */
export interface DeviceEnrollment {
  readonly deviceId: string;
}

export interface DeviceEnrollmentStatusOptions {
  productId: string;
  storeDir?: string;
  deviceCredentials?: DeviceCredentialConfig;
  /** `DaemonConfig.nativeAssetRoot` of a packaged Windows Host, which has no installed koffi. */
  nativeAssetRoot?: string;
}

/** Credential-blind cold read model for host setup and diagnostics. */
export type DeviceEnrollmentStatus =
  | { state: 'unpaired' }
  | { state: 'paired'; deviceId: string }
  | { state: 're_pair_required' };

/**
 * Device-proof key id of the one key a local enrollment holds: the Ed25519
 * identity key registered at pairing. The pairing contract registers that key
 * as proof key `identity` at epoch `0` (`@byok-sdk/cloud`
 * `DEVICE_IDENTITY_PROOF_KEY_ID` / `DEVICE_IDENTITY_PROOF_KEY_EPOCH`, stored as
 * the device row's `proof_key_id` / `proof_key_epoch`); the pairing response
 * carries neither value, so this is the local projection of that contract,
 * held equal to cloud by a drift test. A future proof-key rotation must carry
 * the epoch through its own authenticated response into the local record and
 * replace this projection in the same cut.
 */
export const DEVICE_ENROLLMENT_PROOF_KEY_ID = 'identity';
/** Epoch of {@link DEVICE_ENROLLMENT_PROOF_KEY_ID}; see its documentation. */
export const DEVICE_ENROLLMENT_PROOF_KEY_EPOCH = 0;

/**
 * Non-secret identity of the current authenticated enrollment: everything a
 * host needs to address this device and to build device proofs or sealed
 * provisioning identity snapshots, and nothing that authenticates it.
 */
export interface DeviceEnrollmentIdentity {
  /** Authenticated tenant binding written only by pairing. */
  readonly tenantId: string;
  readonly deviceId: string;
  /** Device-proof `keyId` the enrollment key is registered under. */
  readonly proofKeyId: string;
  /** Device-proof `keyEpoch` the enrollment key is registered under. */
  readonly proofKeyEpoch: number;
  /**
   * Sealed provisioning `enrollmentRevision`: the decimal string of
   * `proofKeyEpoch`. A Host issues the same value from its device row
   * (`String(proof_key_epoch)`) as `expectedEnrollmentRevision`. It is
   * monotonic across proof-key rotation for one device id; re-pair mints a new
   * device id, so `(tenantId, deviceId, enrollmentRevision)` names exactly one
   * enrollment key.
   */
  readonly enrollmentRevision: string;
}

/** Cold read of the enrollment identity; the non-paired states match {@link DeviceEnrollmentStatus}. */
export type DeviceEnrollmentIdentityStatus =
  | { readonly state: 'unpaired' }
  | { readonly state: 're_pair_required' }
  | ({ readonly state: 'paired' } & DeviceEnrollmentIdentity);

/**
 * Package-internal read of the complete enrollment authority. It is the one
 * classification shared by the public status/identity reads and the host
 * device-proof signer, and it never writes (no metadata reconcile).
 */
export type EnrollmentAuthorityRead =
  | { readonly state: 'unpaired' }
  | { readonly state: 're_pair_required' }
  | { readonly state: 'paired'; readonly record: DeviceRecord };

const MAX_DEVICE_RECORD_BYTES = 256 * 1024;

const REPAIR_REQUIRED_MESSAGE =
  'device enrollment record is missing or has an invalid authenticated tenant binding; re-pair required';

/**
 * A durable enrollment record cannot be used by any steady-state path. Only
 * the explicit pair operation may replace it with a fresh authenticated row.
 */
export class DeviceRecordRePairRequiredError extends Error {
  constructor() {
    super(REPAIR_REQUIRED_MESSAGE);
    this.name = 'DeviceRecordRePairRequiredError';
  }
}

/**
 * The one binding check between a storeDir and the shared OS enrollment: the
 * `device.json` that pairing wrote must name exactly the stored enrollment.
 */
export function assertStoreBound(projection: DeviceMetadata | undefined, authority: DeviceMetadata): void {
  if (
    projection === undefined ||
    projection.deviceId !== authority.deviceId ||
    projection.tenantId !== authority.tenantId ||
    projection.devicePublicKey !== authority.devicePublicKey
  ) {
    throw new DeviceStoreBindingMismatchError(authority, projection);
  }
}

const LEGACY_SECRET_FIELDS = new Set(['accessToken', 'expiresAt', 'devicePrivateKeyPem']);

function assertDeviceMetadata(value: unknown): asserts value is DeviceMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeviceRecordRePairRequiredError();
  }
  const parsed = value as Partial<DeviceMetadata>;
  if (Object.keys(parsed).some((key) => LEGACY_SECRET_FIELDS.has(key))) {
    // Never dual-read/import legacy file material. Its only recovery is an
    // explicit authenticated re-pair that replaces the OS credential entry.
    throw new DeviceRecordRePairRequiredError();
  }
  if (
    typeof parsed.deviceId === 'string' &&
    isTenantId(parsed.tenantId) &&
    typeof parsed.devicePublicKey === 'string'
  ) {
    return;
  }
  throw new DeviceRecordRePairRequiredError();
}

function parseDeviceMetadata(raw: string): DeviceMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeviceRecordRePairRequiredError();
  }
  assertDeviceMetadata(parsed);
  return {
    deviceId: parsed.deviceId,
    tenantId: parsed.tenantId,
    devicePublicKey: parsed.devicePublicKey,
  };
}

/**
 * Persists only bounded non-secret enrollment projection. The paired bearer
 * token and private key are never accepted here and are owned by the internal
 * OS DeviceCredentialStore.
 */
export class DeviceStore {
  private readonly filePath: string;
  /**
   * Non-secret identity of this storeDir, the SHA-256 hex of its resolved
   * path: a first-pairing attempt records it so a clear deletes only its own
   * store's attempt from the productId-wide OS entry (#1964).
   */
  readonly identity: string;

  /**
   * `secureDirOptions` is a test-only DI seam (mirrors `EnsureSecureDirOptions`'s
   * own `run`/`platform` overrides) — every real caller omits it, getting
   * real `ensureSecureDir(storeDir)` behavior unchanged. It exists so
   * finding R4's fail-closed contract ("on win32, an `icacls` failure makes
   * `save()` — and thus `AuthManager.pair()` — reject with a clear typed
   * `SecureDirHardeningError` instead of silently persisting an
   * ACL-unprotected credential") is verifiable from a real `darwin`/`linux`
   * CI/dev machine, not just asserted.
   */
  constructor(
    /** The productId whose OS credential entry this store shares; the one source of the enrollment lock's scope (#2034). */
    readonly productId: string,
    storeDir: string,
    readonly credentials: DeviceCredentialBackend,
    private readonly secureDirOptions?: EnsureSecureDirOptions,
  ) {
    if (credentials === null || (typeof credentials !== 'object' && typeof credentials !== 'function') ||
        (['read', 'readFirstPairingAttempt', 'saveFirstPairingAttempt', 'replace', 'clear'] as const)
          .some((method) => typeof credentials[method] !== 'function')) {
      throw new TypeError('device credential backend must implement complete enrollment custody');
    }
    this.filePath = path.join(storeDir, 'device.json');
    this.identity = createHash('sha256').update(path.resolve(storeDir), 'utf8').digest('hex');
  }

  /**
   * Resolve the one store pathname every daemon/CLI component must share.
   * A configured relative path is anchored once at process entry rather than
   * being reinterpreted after a diagnostics operation temporarily changes
   * cwd to pin a quarantine directory inode. Name aliases (8.3 short names,
   * letter case) are folded into the on-disk spelling here, so the daemon and
   * every CLI derive the same control endpoint, Agent-home owner and retention
   * roots from one spelling.
   * On POSIX a symbolic link in an existing ancestor is followed only when it
   * and the directory holding it are trusted; an untrusted link throws
   * `configured_path_untrusted_link`. On Windows any symbolic link or
   * drive-letter junction in an existing ancestor throws it.
   */
  static resolveDir(productId: string, configured?: string): string {
    return foldNameAliases(configured ?? defaultStoreDir(productId));
  }

  async load(): Promise<DeviceMetadata | undefined> {
    const opened = await this.openBounded();
    if (!opened) return undefined;
    try {
      return parseDeviceMetadata(opened.raw);
    } finally {
      await opened.handle.close();
    }
  }

  /**
   * Read and remove the exact bounded, no-follow device record under the
   * caller's mutation lease. The hard-link guard keeps the inspected inode
   * identifiable until the synchronous pathname check and unlink complete.
   */
  async remove(): Promise<DeviceMetadata | undefined> {
    const opened = await this.openBounded();
    if (!opened) return undefined;
    const guardPath = `${this.filePath}.${process.pid}.${randomUUID()}.remove`;
    try {
      const record = parseDeviceMetadata(opened.raw);
      linkSync(this.filePath, guardPath);
      const openStat = fstatSync(opened.handle.fd, { bigint: true });
      const guarded = lstatSync(guardPath, { bigint: true });
      const named = lstatSync(this.filePath, { bigint: true });
      // Creating the guard hard-link legitimately changes ctime/link count on
      // the inode; the post-link check compares identity + content-bearing
      // size/mtime, as the bounded read does.
      if (!sameContent(openStat, opened.stat) || !sameFile(guarded, opened.stat) || !sameContent(named, opened.stat)) {
        throw new Error('device identity changed before removal');
      }
      unlinkSync(this.filePath);
      unlinkSync(guardPath);
      return record;
    } finally {
      try { unlinkSync(guardPath); } catch { /* unpublished guard may not exist */ }
      await opened.handle.close();
    }
  }

  /**
   * Rebuild only the non-secret projection, while the caller owns the store
   * lease. Only the operator-confirmed doctor `restore-enrollment-metadata`
   * action calls this; startup and reads never adopt an enrollment.
   */
  async reconcileMetadata(authority: DeviceMetadata): Promise<boolean> {
    const projection: DeviceMetadata = {
      deviceId: authority.deviceId,
      tenantId: authority.tenantId,
      devicePublicKey: authority.devicePublicKey,
    };
    // Invalid/legacy files still throw: only explicit authenticated pairing
    // may replace them. Never copy extra fields from the OS record.
    const current = await this.load();
    if (current !== undefined && current.deviceId === projection.deviceId &&
        current.tenantId === projection.tenantId && current.devicePublicKey === projection.devicePublicKey) {
      return false;
    }
    await this.save(projection);
    return true;
  }

  async save(record: DeviceMetadata): Promise<void> {
    assertDeviceMetadata(record);
    const storeDir = path.dirname(this.filePath);
    // `mkdir`'s own `mode` only applies at CREATION time — a pre-existing
    // storeDir (predating this fix, or created by something else with a
    // more permissive mode) keeps whatever it already had until explicitly
    // chmod'd. Re-asserted on every save for an owned storeDir; a storeDir
    // owned by a different user keeps its owner's mode and never blocks the
    // save (`ensureSecureStoreRoot`).
    // Finding F7: on win32, `ensureSecureDir` ALSO applies a restrictive
    // DACL via `icacls` — POSIX modes alone restrict nothing there. See
    // `util/secure-dir.ts`'s own doc comment. Finding R4: this now THROWS
    // (`SecureDirHardeningError`) on a win32 `icacls` failure instead of
    // warning and continuing — propagates straight out of `save()` (and so
    // out of `AuthManager.pair()`, since nothing here catches it), before
    // `device.json` is ever written.
    await ensureSecureStoreRoot(storeDir, this.secureDirOptions);
    // Atomic metadata projection write. No secret value is present in this
    // file; the restrictive mode still limits metadata exposure.
    await atomicWriteFile(this.filePath, JSON.stringify(record, null, 2), { mode: 0o600 });
  }

  private async openBounded(): Promise<{
    handle: Awaited<ReturnType<typeof fs.open>>;
    raw: string;
    stat: import('node:fs').BigIntStats;
  } | undefined> {
    let namedBefore: import('node:fs').BigIntStats;
    try {
      namedBefore = await fs.lstat(this.filePath, { bigint: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('device identity could not be inspected safely', { cause: err });
    }
    if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) {
      throw new Error('device identity is not a real regular file');
    }
    let handle: Awaited<ReturnType<typeof fs.open>>;
    try {
      handle = await fs.open(
        this.filePath,
        fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | (fsConstants.O_NOFOLLOW ?? 0),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('device identity could not be opened safely', { cause: err });
    }
    try {
      const before = await handle.stat({ bigint: true });
      const namedAfterOpen = await fs.lstat(this.filePath, { bigint: true });
      if (
        !before.isFile() ||
        !namedAfterOpen.isFile() ||
        namedAfterOpen.isSymbolicLink() ||
        !sameContent(namedBefore, before) ||
        !sameContent(before, namedAfterOpen)
      ) {
        throw new Error('device identity pathname changed before safe open');
      }
      if (before.size <= 0 || before.size > BigInt(MAX_DEVICE_RECORD_BYTES)) {
        throw new Error('device identity exceeds the bounded read limit');
      }
      const size = Number(before.size);
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      const after = await handle.stat({ bigint: true });
      const namedAfterRead = await fs.lstat(this.filePath, { bigint: true });
      if (
        bytesRead !== size ||
        !sameContent(before, after) ||
        !sameContent(after, namedAfterRead) ||
        namedAfterRead.isSymbolicLink()
      ) {
        throw new Error('device identity changed during bounded read');
      }
      return { handle, raw: buffer.toString('utf8'), stat: after };
    } catch (err) {
      await handle.close();
      throw err;
    }
  }
}

/**
 * Read and classify the canonical device store without writing anything.
 * A legacy/tampered record remains distinct from an absent record so hosts can
 * require explicit re-pair instead of silently changing semantics. Filesystem,
 * pathname-safety and credential-provider failures intentionally remain errors,
 * and so does an OS enrollment this storeDir did not pair
 * ({@link DeviceStoreBindingMismatchError}).
 */
export async function readEnrollmentAuthority(
  options: DeviceEnrollmentStatusOptions,
): Promise<EnrollmentAuthorityRead> {
  const { productId, storeDir: configuredStoreDir, deviceCredentials, nativeAssetRoot } = readEnrollmentOptions(options);
  const storeDir = DeviceStore.resolveDir(productId, configuredStoreDir);
  return readStoreEnrollment(new DeviceStore(productId, storeDir, createDeviceCredentialStore({ productId, storeDir, deviceCredentials, nativeAssetRoot })));
}

/** {@link readEnrollmentAuthority} over an already composed store. */
export async function readStoreEnrollment(store: DeviceStore): Promise<EnrollmentAuthorityRead> {
  try {
    // Inspect the bounded projection even when the OS authority exists. A
    // legacy secret-bearing or otherwise invalid file is an explicit
    // re-pair-required state; steady-state reads must never hide or repair it.
    const projection = await store.load();
    const authority = await store.credentials.read();
    if (authority !== undefined) {
      assertStoreBound(projection, authority);
      return { state: 'paired', record: authority };
    }

    // An enrollment projection without its OS authority is not an unpaired
    // machine: it is a partial/legacy state that requires explicit recovery.
    return projection === undefined
      ? { state: 'unpaired' }
      : { state: 're_pair_required' };
  } catch (error) {
    if (error instanceof DeviceRecordRePairRequiredError) {
      return { state: 're_pair_required' };
    }
    throw error;
  }
}

/**
 * Reads `productId` and `storeDir` exactly once each as plain data
 * (`../util/plain-data`); other fields of a larger host config are never
 * read. An accessor, Proxy, non-plain prototype or wrong type is a
 * `TypeError` with no cause, before any filesystem or credential access.
 */
export function readEnrollmentOptions(options: unknown): { productId: string; storeDir: string | undefined; deviceCredentials: DeviceCredentialConfig | undefined; nativeAssetRoot: string | undefined } {
  const invalid = (): TypeError =>
    new TypeError('device enrollment reads require a non-empty productId and optional storeDir and nativeAssetRoot strings, as plain data properties');
  let picked: Record<'productId' | 'storeDir' | 'deviceCredentials' | 'nativeAssetRoot', unknown>;
  try {
    picked = pickPlainDataProperties(options, ['productId', 'storeDir', 'deviceCredentials', 'nativeAssetRoot'], { maxDepth: 1, allowUndefined: true });
  } catch {
    throw invalid();
  }
  const { productId, storeDir, nativeAssetRoot } = picked;
  if (typeof productId !== 'string' || productId.length === 0 || (storeDir !== undefined && typeof storeDir !== 'string')
    || (nativeAssetRoot !== undefined && typeof nativeAssetRoot !== 'string')) {
    throw invalid();
  }
  let deviceCredentials: DeviceCredentialConfig | undefined;
  if (picked.deviceCredentials !== undefined) {
    let config: Record<'macosKeychainPath', unknown>;
    try { config = pickPlainDataProperties(picked.deviceCredentials, ['macosKeychainPath']); }
    catch { throw invalid(); }
    if (config.macosKeychainPath !== undefined && typeof config.macosKeychainPath !== 'string') throw invalid();
    deviceCredentials = { macosKeychainPath: config.macosKeychainPath };
  }
  return { productId, storeDir, deviceCredentials, nativeAssetRoot };
}

/** The public non-secret identity projection of one enrollment record. */
export function enrollmentIdentityOf(record: DeviceMetadata): DeviceEnrollmentIdentity {
  return {
    tenantId: record.tenantId,
    deviceId: record.deviceId,
    proofKeyId: DEVICE_ENROLLMENT_PROOF_KEY_ID,
    proofKeyEpoch: DEVICE_ENROLLMENT_PROOF_KEY_EPOCH,
    enrollmentRevision: String(DEVICE_ENROLLMENT_PROOF_KEY_EPOCH),
  };
}

/**
 * Read the canonical device store without projecting credential or tenant
 * material. See {@link readEnrollmentAuthority} for the state classification.
 */
export async function readDeviceEnrollmentStatus(
  options: DeviceEnrollmentStatusOptions,
): Promise<DeviceEnrollmentStatus> {
  const read = await readEnrollmentAuthority(options);
  return read.state === 'paired' ? { state: 'paired', deviceId: read.record.deviceId } : { state: read.state };
}

/**
 * Read the non-secret identity of the current enrollment: tenant, device and
 * the device-proof key id/epoch, plus the derived sealed-provisioning
 * `enrollmentRevision`. Never returns the access token, private key or public
 * key, never writes, and uses the same classification as
 * {@link readDeviceEnrollmentStatus}. It reads the calling process's OS
 * credential set, so it observes the enrollment of the account the daemon runs
 * as only when called as that account.
 */
export async function readDeviceEnrollmentIdentity(
  options: DeviceEnrollmentStatusOptions,
): Promise<DeviceEnrollmentIdentityStatus> {
  const read = await readEnrollmentAuthority(options);
  return read.state === 'paired' ? { state: 'paired', ...enrollmentIdentityOf(read.record) } : { state: read.state };
}
