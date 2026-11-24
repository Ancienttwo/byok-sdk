/**
 * Recovery commands run by the Host executable re-entered after the shell
 * stopped the Host (`byok-desktop-start-fresh`, `byok-desktop-snapshot`,
 * `byok-desktop-snapshot-status`, `byok-desktop-restore`). Running here keeps
 * store layout resolution and file manipulation solely in the Host (#1499 D4,
 * #1917, #2459).
 */
import { clearDeviceEnrollment, DeviceEnrollmentClearError, type DeviceCredentialBackend } from '@byok-sdk/client';
import { ByokKeysError, inspectProviderProfileStore, SqliteProviderProfileStore } from '@byok-sdk/keys';
import { RESTORE_COMMAND, SNAPSHOT_COMMAND, SNAPSHOT_STATUS_COMMAND, START_FRESH_COMMAND, type RestoreReceipt, type SnapshotReceipt, type SnapshotStatusReceipt, type StartFreshReceipt } from '../recovery/protocol.ts';
import { keysDbPath } from './keys/launcher.ts';
import {
  completeSnapshot,
  moveAll,
  moveBack,
  MoveBackError,
  restoreSnapshot,
  snapshotStores,
  startFreshMoves,
  type Move,
  type StoreLayout,
} from '../recovery/stores.ts';

export interface StartFreshOptions {
  readonly layout: StoreLayout;
  readonly productId: string;
  readonly stamp: string;
  /** `DaemonConfig.nativeAssetRoot` of a packaged Windows Host. */
  readonly nativeAssetRoot?: string;
  /** Tests inject the device credential backend, as the daemon takes one. */
  readonly deviceCredentials?: DeviceCredentialBackend;
}

/** Single-segment validation for stamps and snapshot version directory names (rejects traversal and separators). */
function requireSegment(value: string | undefined, pattern: RegExp, errorMessage: string): string {
  if (!value || value === '.' || value === '..' || !pattern.test(value)) throw new Error(errorMessage);
  return value;
}

const requireStamp = (args: readonly string[], index: number, command: string): string =>
  requireSegment(args[index], /^[0-9TZ.-]+$/, `${command} requires a single-segment aside stamp`);

const requireVersion = (args: readonly string[], index: number, command: string): string =>
  requireSegment(args[index], /^[0-9A-Za-z._+-]+$/, `${command} requires a single-segment version`);

const writeReceipt = async <T extends { readonly ok: boolean }>(receipt: T): Promise<number> => {
  await new Promise<void>((resolve, reject) => process.stdout.write(`${JSON.stringify(receipt)}\n`, error => (error ? reject(error) : resolve())));
  return receipt.ok ? 0 : 1;
};

/**
 * Ensures no custody child holds the keys configuration lock during S1 store
 * work (P1-6). Snapshot holds the SQLite configuration lock across its entire
 * copy, while restore/startFresh close the lock handle immediately before moving
 * `host/` so Windows does not reject directory renames (`EBUSY`), relying on the
 * shell `MaintenanceLock` custody exclusion against new custody spawns.
 */
async function withKeysConfigurationIdle<T>(hostStorageRoot: string, action: () => Promise<T>): Promise<T> {
  const keysDb = keysDbPath(hostStorageRoot);
  const inspection = await inspectProviderProfileStore(keysDb);
  if (inspection.verdict !== 'accepted') return action();
  const store = new SqliteProviderProfileStore({ path: keysDb, readOnly: true, configurationLockWaitMs: 0 });
  let lock: Awaited<ReturnType<SqliteProviderProfileStore['acquireConfigurationLock']>> | undefined;
  try {
    lock = await store.acquireConfigurationLock();
    return await action();
  } finally {
    try {
      await lock?.release();
    } finally {
      await store.close();
    }
  }
}

async function assertKeysConfigurationIdle(hostStorageRoot: string): Promise<void> {
  await withKeysConfigurationIdle(hostStorageRoot, async () => {});
}

/**
 * Moves the SDK store, the Host stores with their snapshots, and the Agent homes
 * aside, then clears the device enrollment of the moved SDK store, so the next
 * Host pairs a new device. The moves come first because they can be undone and
 * the clear cannot: a failed move, or a clear the SDK refuses, moves everything
 * back. The SDK binds an enrollment to the content of `device.json`, not to the
 * directory, so the moved store clears as the original would. Nothing is deleted
 * but the enrollment: its `device.json` and its OS credential.
 */
export async function startFresh(options: StartFreshOptions): Promise<readonly Move[]> {
  const done = await moveAll(startFreshMoves(options.layout, options.stamp));
  const store = done.find(move => move.from === options.layout.storeDir);
  if (store === undefined) return done;
  try {
    await clearDeviceEnrollment(
      { productId: options.productId, storeDir: store.to, ...(options.nativeAssetRoot === undefined ? {} : { nativeAssetRoot: options.nativeAssetRoot }) },
      options.deviceCredentials === undefined ? undefined : { deviceCredentials: options.deviceCredentials },
    );
  } catch (error) {
    await moveBack(done, error);
  }
  return done;
}

/** The re-entered command: one receipt line on stdout; exit 0 only when the stores moved and the enrollment cleared. */
export async function runStartFreshCommand(args: readonly string[], options: Omit<StartFreshOptions, 'stamp'>): Promise<number> {
  if (args.length !== 2) throw new Error(`${START_FRESH_COMMAND} takes one argument: the aside stamp`);
  const stamp = requireStamp(args, 1, START_FRESH_COMMAND);
  let receipt: StartFreshReceipt;
  try {
    await assertKeysConfigurationIdle(options.layout.hostStorageRoot);
    receipt = { ok: true, moved: await startFresh({ ...options, stamp }) };
  } catch (error) {
    const failure = error instanceof MoveBackError ? error.cause : error;
    const code = failure instanceof ByokKeysError || failure instanceof DeviceEnrollmentClearError ? failure.code : 'start_fresh_failed';
    receipt = { ok: false, code, message: (error as Error).message, movedBack: !(error instanceof MoveBackError) };
  }
  return writeReceipt(receipt);
}

/** Re-entered S1 command: atomically copies current stores into `<hostStorageRoot>/host/snapshots/<version>`. */
export async function runSnapshotCommand(args: readonly string[], options: { readonly layout: StoreLayout }): Promise<number> {
  if (args.length !== 2) throw new Error(`${SNAPSHOT_COMMAND} takes one argument: the app version`);
  const version = requireVersion(args, 1, SNAPSHOT_COMMAND);
  let receipt: SnapshotReceipt;
  try {
    receipt = await withKeysConfigurationIdle(options.layout.hostStorageRoot, async () => ({
      ok: true,
      target: await snapshotStores(options.layout, version),
    }));
  } catch (error) {
    receipt = { ok: false, code: error instanceof ByokKeysError ? error.code : 'snapshot_failed', message: (error as Error).message };
  }
  return writeReceipt(receipt);
}

/** Re-entered S1 command: reports whether a complete snapshot of `<version>` exists on disk. */
export async function runSnapshotStatusCommand(args: readonly string[], options: { readonly layout: StoreLayout }): Promise<number> {
  if (args.length !== 2) throw new Error(`${SNAPSHOT_STATUS_COMMAND} takes one argument: the app version`);
  const version = requireVersion(args, 1, SNAPSHOT_STATUS_COMMAND);
  let receipt: SnapshotStatusReceipt;
  try {
    const target = await completeSnapshot(options.layout, version);
    receipt = { ok: true, snapshot: target === undefined ? null : { version, target } };
  } catch (error) {
    receipt = { ok: false, code: 'snapshot_status_failed', message: (error as Error).message };
  }
  return writeReceipt(receipt);
}

/** Re-entered S1 command: atomically restores `<version>`'s complete snapshot after moving current stores aside with `<stamp>`. */
export async function runRestoreCommand(args: readonly string[], options: { readonly layout: StoreLayout }): Promise<number> {
  if (args.length !== 3) throw new Error(`${RESTORE_COMMAND} takes two arguments: the app version and aside stamp`);
  const version = requireVersion(args, 1, RESTORE_COMMAND);
  const stamp = requireStamp(args, 2, RESTORE_COMMAND);
  let receipt: RestoreReceipt;
  try {
    await assertKeysConfigurationIdle(options.layout.hostStorageRoot);
    receipt = { ok: true, asidePath: await restoreSnapshot(options.layout, version, stamp) };
  } catch (error) {
    receipt = {
      ok: false,
      code: error instanceof ByokKeysError ? error.code : 'restore_failed',
      message: (error as Error).message,
      movedBack: !(error instanceof MoveBackError),
    };
  }
  return writeReceipt(receipt);
}
