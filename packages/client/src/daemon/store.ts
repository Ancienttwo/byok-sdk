import {
  constants as fsConstants,
  fstatSync,
  linkSync,
  lstatSync,
  unlinkSync,
  promises as fs,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { isTenantId } from '@byok-sdk/core';
import { atomicWriteFile } from '../util/atomic-write';
import { ensureSecureDir, type EnsureSecureDirOptions } from '../util/secure-dir';
import {
  DeviceCredentialStore,
  InMemoryDeviceCredentialStore,
  type DeviceMetadata,
  type DeviceRecord,
} from './device-credential-store';

export type { DeviceMetadata, DeviceRecord } from './device-credential-store';

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
}

/** Credential-blind cold read model for host setup and diagnostics. */
export type DeviceEnrollmentStatus =
  | { state: 'unpaired' }
  | { state: 'paired'; deviceId: string }
  | { state: 're_pair_required' };

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

function sameInode(left: import('node:fs').BigIntStats, right: import('node:fs').BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileState(left: import('node:fs').BigIntStats, right: import('node:fs').BigIntStats): boolean {
  return (
    sameInode(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameContentState(left: import('node:fs').BigIntStats, right: import('node:fs').BigIntStats): boolean {
  return sameInode(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs;
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
  /** Process-local keyed doubles preserve restart semantics in isolated tests. */
  private static readonly testCredentials = new Map<string, InMemoryDeviceCredentialStore>();
  private readonly filePath: string;
  /** Internal test seam. Product construction always supplies productId and gets an OS store. */
  readonly credentials: DeviceCredentialStore | InMemoryDeviceCredentialStore;

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
    storeDir: string,
    private readonly secureDirOptions?: EnsureSecureDirOptions,
    productId?: string,
  ) {
    this.filePath = path.join(storeDir, 'device.json');
    if (productId === undefined) {
      this.credentials = new InMemoryDeviceCredentialStore();
    } else if (process.env.BYOK_TEST_DEVICE_CREDENTIAL_STORE === '1') {
      const key = `${path.resolve(storeDir)}\0${productId}`;
      let credentials = DeviceStore.testCredentials.get(key);
      if (credentials === undefined) {
        credentials = new InMemoryDeviceCredentialStore();
        DeviceStore.testCredentials.set(key, credentials);
      }
      this.credentials = credentials;
    } else {
      this.credentials = new DeviceCredentialStore({ productId });
    }
  }

  static defaultDir(productId: string): string {
    return path.join(os.homedir(), '.byok', productId);
  }

  /**
   * Resolve the one store pathname every daemon/CLI component must share.
   * A configured relative path is anchored once at process entry rather than
   * being reinterpreted after a diagnostics operation temporarily changes
   * cwd to pin a quarantine directory inode.
   */
  static resolveDir(productId: string, configured?: string): string {
    return path.resolve(configured ?? DeviceStore.defaultDir(productId));
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
      // the inode, so the post-link check compares identity + content-bearing
      // size/mtime. The bounded read already compared ctime before publication.
      if (!sameContentState(openStat, opened.stat) || !sameInode(guarded, opened.stat) || !sameContentState(named, opened.stat)) {
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

  async save(record: DeviceMetadata): Promise<void> {
    assertDeviceMetadata(record);
    const storeDir = path.dirname(this.filePath);
    // `mkdir`'s own `mode` only applies at CREATION time — a pre-existing
    // storeDir (predating this fix, or created by something else with a
    // more permissive mode) keeps whatever it already had until explicitly
    // chmod'd. Re-asserted on every save, best-effort — mirrors
    // `bin/audit-log.ts`'s `appendAuditEvent`, which has the identical gap
    // (and the identical fix) for the same reason: a failure here (e.g. a
    // storeDir owned by a different user) must never block the save itself.
    // Finding F7: on win32, `ensureSecureDir` ALSO applies a restrictive
    // DACL via `icacls` — POSIX modes alone restrict nothing there. See
    // `util/secure-dir.ts`'s own doc comment. Finding R4: this now THROWS
    // (`SecureDirHardeningError`) on a win32 `icacls` failure instead of
    // warning and continuing — propagates straight out of `save()` (and so
    // out of `AuthManager.pair()`, since nothing here catches it), before
    // `device.json` is ever written.
    await ensureSecureDir(storeDir, this.secureDirOptions);
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
        !sameFileState(namedBefore, before) ||
        !sameFileState(before, namedAfterOpen)
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
        !sameFileState(before, after) ||
        !sameFileState(after, namedAfterRead) ||
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
 * Read the canonical device store without projecting credential or tenant
 * material. A legacy/tampered record remains distinct from an absent record so
 * hosts can require explicit re-pair instead of silently changing semantics.
 * Filesystem and pathname-safety failures intentionally remain errors.
 */
export async function readDeviceEnrollmentStatus(
  options: DeviceEnrollmentStatusOptions,
): Promise<DeviceEnrollmentStatus> {
  const storeDir = DeviceStore.resolveDir(options.productId, options.storeDir);
  try {
    const store = new DeviceStore(storeDir, undefined, options.productId);
    const authority = await store.credentials.read();
    if (authority !== undefined) return { state: 'paired', deviceId: authority.deviceId };

    // An enrollment projection without its OS authority is not an unpaired
    // machine: it is a partial/legacy state that requires explicit recovery.
    return (await store.load()) === undefined
      ? { state: 'unpaired' }
      : { state: 're_pair_required' };
  } catch (error) {
    if (error instanceof DeviceRecordRePairRequiredError) {
      return { state: 're_pair_required' };
    }
    throw error;
  }
}
