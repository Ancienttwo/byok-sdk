import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import type { StoreCompatibilityVerdict } from '@byok-sdk/core';
import { connectControlClient } from '../daemon/control-client.js';
import { controlEndpointPath, controlTokenPath, type ControlStatusResult } from '../daemon/control-protocol.js';
import { daemonLifecycleHealth, type DaemonLifecycle } from '../daemon/daemon-lifecycle.js';
import { acquireDaemonOwner, DaemonOwnerActiveError, DaemonOwnerReclaimingError, type DaemonOwnerLease } from '../util/daemon-owner.js';
import { OwnedProcessLedger, OwnedProcessResidueError } from '../daemon/owned-process-ledger.js';
import { acquirePathMutationGates, PathMutationGateBusyError, type PathMutationGate } from '../util/path-mutation-gate.js';
import { createManagedServiceLifecycle, type CreateServiceLifecycleOptions } from './create-service-lifecycle.js';
import type { ManagedServiceLifecycle } from './managed-lifecycle.js';
import {
  isJsonObject, isPayloadPath, listPayloadFiles, SERVICE_PAYLOAD_MANIFEST, sha256File, SHA256_HEX, VERSION_ID, type ServicePayloadManifest,
} from '../service-payload-manifest.js';
import { serviceStateDir, ServiceUnitError } from './service-unit.js';
import type { ServiceDefinition, ServiceInstallOptions, ServiceLifecycle, ServiceProgram } from './service-types.js';

/**
 * One store the candidate's precheck reports (#1328): an SDK `LocalStoreId`
 * or a Host store id, with the verdict the candidate gives it. The snapshot
 * covers exactly the reported stores.
 */
export interface ServiceStoreVerdict {
  /** An SDK `LocalStoreId` or a Host store id: 1-64 of `a-z 0-9 -`, starting with a letter or digit. */
  readonly store: string;
  /** Absolute. No two stores share a path, and no store lies inside a `directory` store. */
  readonly path: string;
  /**
   * `file` (the default): the file plus its `-wal` and `-journal`, each a
   * regular file or absent. `directory`: the whole tree, a real directory
   * (not a symlink) or absent; symlinks inside it are copied as links.
   */
  readonly kind?: 'file' | 'directory';
  readonly verdict: StoreCompatibilityVerdict;
  /** The error code the store reported when it refused the store. */
  readonly code?: string;
  readonly reason: string;
}

/** A daemon store the service process owns (#1328): the `DaemonConfig.storeDir` and `productId` of one daemon it runs. */
export interface ServiceDaemonStore {
  readonly storeDir: string;
  readonly productId: string;
}

/**
 * What an installation is told to do (#1097). `program` and `precheck`
 * receive a version directory: `program` gets `<installRoot>/current`, so the
 * unit and launcher never change across upgrades; `precheck` gets the staged
 * candidate's own directory.
 */
export interface ServiceInstallationOptions {
  /** The service, without `program`: {@link ServiceInstallationOptions.program} supplies it. */
  service: Omit<ServiceDefinition, 'program'>;
  /** The daemon's product id; the default health check reaches its control socket with it. */
  productId: string;
  /**
   * A Host-owned directory outside the store. The SDK owns `versions/`,
   * `current`, `previous`, `snapshots/` and `upgrade-receipt.json` in it.
   */
  installRoot: string;
  /** The service program, run from `versionDir`. */
  program(versionDir: string): ServiceProgram;
  /**
   * The candidate's store precheck, run from its staged `versionDir` while
   * every writer is stopped. It prints `{ "stores": ServiceStoreVerdict[] }`
   * (`byok-agent upgrade check --store --json` prints the SDK's own stores in
   * this shape) and exits 2 when a store is `new-path-repair` or `rejected`,
   * 0 otherwise. Every store the candidate rewrites must be
   * listed, Host stores included: the snapshot covers exactly the listed
   * stores. Output that breaks {@link ServiceStoreVerdict}'s rules is
   * `precheck_failed`.
   */
  precheck(versionDir: string): ServiceProgram;
  /**
   * The candidate's store migration, run from its staged `versionDir` after
   * the snapshot when the precheck reports a store as `migration-required`;
   * exit 0 is success. The precheck then runs again and must report every
   * store `accepted` or `absent`. Without it, a `migration-required` store is
   * `store_migration_required` and nothing is switched. Any failure after the
   * snapshot (a throw here, an exit other than 0, a failed or non-accepting
   * second precheck) restores the snapshot and is `store_migration_failed`,
   * with a thrown or precheck error as `cause`. The Host must make
   * this program safe to run again after interruption: install has no
   * write-ahead receipt for a process death during migration.
   */
  migrate?(versionDir: string): ServiceProgram;
  /**
   * Resolves when the started version is healthy and throws when it is not.
   * Default: the daemon's control socket reports a live `lifecycle` — `running`
   * (connecting or open), or `awaiting-enrollment` for a service-enrollment
   * daemon that has not paired yet. `halted` or `crashed` fails at once.
   */
  healthCheck?(signal: AbortSignal): Promise<void>;
  /**
   * How long the health check may take: an integer from 1 to 2147483647
   * (2^31-1) ms, or a TypeError when the installation is created. Default
   * 60000. On install, upgrade,
   * rollback and recover, this bounds only the health-check wait after start
   * returns, also against a check that ignores its abort signal. Unit writes,
   * activation, start and cleanup stop run outside it; platform commands
   * have no time bound today (#1971).
   */
  healthTimeoutMs?: number;
  /**
   * Every daemon store the service process owns, leased on a first install
   * and read after stopping the service on upgrade, rollback and recover
   * (#1328, #1983). Each `storeDir`
   * is absolute and listed once; `productId` is not empty; an empty list is
   * valid. An invalid list or a throw is `daemon_stores_invalid`. Default:
   * `[{ storeDir: service.storeDir, productId }]`. Requires `healthCheck`,
   * since the default one reaches only `productId`'s daemon.
   */
  daemonStores?(): Promise<readonly ServiceDaemonStore[]>;
  /** How long a stop may take to leave every daemon store quiescent, shared by all of them. Default 30000. */
  stopTimeoutMs?: number;
  /**
   * The Host's own payload policy (#1842), such as a Node floor, file-size
   * ceilings or file modes. Runs on the staged copy after every digest
   * passed and before it becomes `versions/<id>`, and on an existing
   * `versions/<id>` whose manifest matched, so it checks the exact bytes
   * that will run. `manifest` is a frozen copy. A throw is `payload_invalid` with the error as `cause`;
   * nothing new appears under `versions/`.
   */
  verifyPayload?(stagedDir: string, manifest: ServicePayloadManifest): void | Promise<void>;
  /** Test seams for the underlying lifecycle. */
  lifecycle?: CreateServiceLifecycleOptions;
}

/**
 * The upgrade receipt a Host UI reads (`upgrade-receipt.json`):
 *
 * - `pending`: an upgrade or a rollback began and has not been confirmed.
 *   It is written before the service is stopped, so it also covers a death
 *   before the snapshot: `recover()` then starts `from` again without a
 *   store restore. Only `recover()` resolves a pending receipt, by
 *   restoring `from` with the snapshot taken for `to` when one exists. A
 *   rollback journals its target as `from`, so recover completes it.
 * - `switched`: `to` runs and passed the health check.
 * - `rolled-back`: `from` runs again with its store snapshot; `code` says why.
 * - `failed`: nothing was switched (`code` and, for a store refusal,
 *   `stores` say why), or a rollback could not bring `from` back to health.
 */
export interface ServiceUpgradeReceipt {
  format: 'byok-service-upgrade-receipt';
  version: 1;
  state: 'pending' | 'switched' | 'rolled-back' | 'failed';
  from: string;
  to: string;
  /** Where `previous` pointed before this upgrade; a restore of `from` puts it back, so an earlier upgrade can still be rolled back. */
  previous?: string;
  at: string;
  code?: ServiceInstallationErrorCode;
  stores?: ServiceStoreVerdict[];
}

/**
 * Every mutation (install, upgrade, rollback, recover, uninstall) first
 * passes the lifecycle's owner check: when another owner is recorded for the
 * store it throws `ServiceUnitError` `lifecycle_owner_conflict` and changes
 * nothing.
 */
export interface ServiceInstallation {
  /** The service lifecycle whose program runs `<installRoot>/current`. */
  readonly lifecycle: ServiceLifecycle;
  /**
   * With no current version, stages the payload, leases daemon stores, runs
   * the candidate precheck, snapshots listed stores and migrates when
   * required, then points
   * `current` at it, records, installs, starts and checks health. Preparation
   * failures remove staging and use upgrade's store errors. A later failure
   * removes the installation and restores the prepared store snapshot,
   * then throws `install_health_check_failed`. A same-id reinstall only
   * repairs the service and checks health, as before; it does not prepare
   * stores or change earlier rollback snapshots. An allowed unmarked unit
   * is untouched until preparation succeeds; its live store owner causes
   * `store_busy`. An owned marked unit without a current version is stopped
   * before preparation and started again after preparation fails, once
   * leases/gates are released and the version directory this call created
   * is removed (one it reused, or any after `installation_exists`, is kept:
   * another installation may use it; the next successful upgrade's prune or
   * uninstall removes it). After a failed store
   * restore it is removed instead, and the next install writes it again.
   * OS credentials are never cleared. `precheck` is required.
   * The temporary snapshot `snapshots/.install-<uuid>` is removed after a
   * healthy start or a completed restore; a removal failure does not change
   * the outcome, and a leftover is kept, never restored automatically: the
   * next first install refuses with `install_snapshot_leftover`, listing it,
   * and starts nothing until an operator removes it. Every check uses
   * `current` and the snapshots read under the store leases: when another
   * installation wrote `current` in between, it refuses with
   * `installation_exists` and keeps every version directory. A
   * failed restore renames it `snapshots/.install-repair-<uuid>` and the
   * error names it: the next first install restores it, under the store
   * leases and before its precheck. When it cannot stop the service, take
   * the leases, restore or retire the repair name, or when more than one
   * repair snapshot exists, it fails, names the snapshots, starts nothing
   * and removes a marked unit.
   */
  install(payloadDir: string, opts?: ServiceInstallOptions): Promise<void>;
  /**
   * Stages the payload, writes the pending receipt, stops the service, runs
   * the candidate's precheck, snapshots the listed stores, runs `migrate`
   * and the precheck again when a store is `migration-required`, switches
   * `current` (the old one becomes `previous`), starts it and checks its
   * health. A store refusal stops before the switch and restarts the old
   * version; a failed migration restores the snapshot first; a failed health
   * check restores the old version and its snapshot together; a death after
   * the receipt leaves `recover()` that work. When the snapshot restore
   * after a failed preparation (such as a failed migration) fails, the
   * stores may be partial: the old version is not restarted, the receipt
   * stays `pending`, and the error names the kept snapshot. Call `recover()`
   * as soon as possible: the unit stays installed, so a reboot or login
   * before it starts the old version on those stores. A failed restore
   * after a failed health check is not covered: it throws the underlying
   * error, which need not name the snapshot, and `current` may still point
   * at the candidate (#1992).
   */
  upgrade(payloadDir: string): Promise<ServiceUpgradeReceipt>;
  /**
   * Restores `previous` and the store snapshot taken when `current` was
   * switched to, under a `pending` receipt written first. Store writes since
   * that switch are discarded.
   *
   * The top-level code names the Host's next step, which follows where the
   * receipt stops. On every exit where a store gate or lease failed to
   * release and the receipt stays `pending` (a refusal whose `failed`
   * receipt was not written, including one that is not a
   * `ServiceInstallationError`; a failed pointer write or snapshot restore;
   * the release after the pointer writes; a rollback after a failed health
   * check), the error is `store_release_failed`. Its `cause` is one flat
   * `AggregateError`: the failure that came first (such as
   * `health_check_failed`, a preparation error or `store_busy`), every
   * release failure, then a failed receipt write or restart. Call
   * recover(); a lease that failed to release stays held until its process
   * exits, so restart the Host process first when recover() reports
   * `store_busy`. When an upgrade refusal's `failed` receipt cannot be
   * written, the previous version also stays stopped, since recover()
   * restores the snapshot over whatever it would write; without a release
   * failure the refusal keeps its code and the receipt write joins its
   * `cause`. A refusal whose final receipt was written keeps its code,
   * and a later release or restart failure joins its `cause` the same way.
   * A release failure after the final receipt would not reject a committed
   * result; no path releases there today.
   */
  rollback(): Promise<ServiceUpgradeReceipt>;
  /** Resolves a `pending` receipt by restoring its `from` version and snapshot. Returns the receipt, or `undefined` when there is none. Release failures follow the same rule as on `rollback()`. */
  recover(): Promise<ServiceUpgradeReceipt | undefined>;
  /** Uninstalls the service and removes `versions/`, the pointers, `snapshots/` and the receipt. Install snapshots (`snapshots/.install-*`) are kept, and so is `snapshots/` around them. A symlinked `snapshots/` is refused with `snapshots_symlinked` before anything changes. The store is not touched. */
  uninstall(): Promise<void>;
  /** The last receipt, or `undefined`. */
  receipt(): Promise<ServiceUpgradeReceipt | undefined>;
  /** The version `current` points at, or `undefined` before install. */
  currentVersion(): Promise<string | undefined>;
}

const ERROR_MESSAGES = {
  installation_absent: 'No version is installed under this install root. Install a payload first.',
  installation_exists: 'A version is already installed under this install root. Upgrade it instead.',
  payload_invalid: 'The payload manifest is missing, malformed, or does not match the payload files.',
  version_current: 'The payload is the version already running.',
  version_conflict: 'A different payload with the same version id is already staged.',
  upgrade_pending: 'An earlier upgrade or rollback was interrupted. Run recover() (CLI: byok-agent upgrade recover) first.',
  store_busy: 'A daemon store still has a running owner after the stop. Stop every process that uses it and retry.',
  store_release_failed: 'The store gates or leases could not be released before the final receipt was written; the receipt stays pending. Run recover() (CLI: byok-agent upgrade recover); if it reports store_busy, restart the Host process first.',
  daemon_stores_invalid: 'daemonStores() threw or listed an invalid store: each storeDir must be absolute and listed once, each productId not empty.',
  owned_process_residue: 'Processes from the previous daemon run survived; resolve them before upgrading.',
  precheck_failed: 'The candidate\'s store precheck did not produce a valid verdict.',
  snapshot_failed: 'The store snapshot could not be written. Nothing was switched; free space or remove what cannot be copied, then retry.',
  store_repair_required: 'The candidate needs a new store path and a new pairing. Nothing was switched; decide before upgrading.',
  store_rejected: 'The candidate refuses a store. Nothing was switched; resolve the store first.',
  store_migration_required: 'The candidate opens a store only after its migration, and no migrate program is configured. Nothing was switched and the store is unchanged.',
  store_migration_failed: 'The candidate\'s store migration failed or left a store it does not accept. The store snapshot was restored and nothing was switched.',
  install_health_check_failed: 'The service failed to install, activate or pass its health check; the installation was removed.',
  health_check_failed: 'The new version failed its health check; the previous version and its store snapshot were restored.',
  rollback_unhealthy: 'The previous version was restored but failed its health check too.',
  no_rollback: 'There is no previous version with a store snapshot to roll back to.',
  install_snapshot_leftover: 'An install snapshot from an earlier call remains under snapshots/ and may hold the only copy of the stores. Nothing was installed or started; compare its snapshot.json with the stores, remove it, then retry.',
  snapshots_symlinked: 'The install root\'s snapshots/ is a symbolic link. Uninstall does not follow it and changed nothing; replace it with a directory or remove the link, then retry.',
} as const;

export type ServiceInstallationErrorCode = keyof typeof ERROR_MESSAGES;

/** Closed codes; a store refusal carries the precheck verdicts, and `snapshot_failed` the copy error as `cause`. */
export class ServiceInstallationError extends Error {
  constructor(readonly code: ServiceInstallationErrorCode, readonly stores?: readonly ServiceStoreVerdict[], options?: ErrorOptions) {
    super(ERROR_MESSAGES[code], options);
    this.name = 'ServiceInstallationError';
  }
}

/** `<storeDir>/service/installation.json`: where this store's installation lives. */
export interface ServiceInstallationRecord {
  format: 'byok-service-installation';
  version: 1;
  installRoot: string;
}

export function serviceInstallationRecordPath(storeDir: string): string {
  return path.join(serviceStateDir(storeDir), 'installation.json');
}

/** The installation record of a store, or `undefined` when the service is not installed from payloads. */
export async function readServiceInstallationRecord(storeDir: string): Promise<ServiceInstallationRecord | undefined> {
  let text: string;
  try {
    text = await fs.readFile(serviceInstallationRecordPath(storeDir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const record = JSON.parse(text) as Partial<ServiceInstallationRecord>;
  if (record.format !== 'byok-service-installation' || record.version !== 1 || typeof record.installRoot !== 'string' || !path.isAbsolute(record.installRoot)) {
    throw new Error(`service installation record ${serviceInstallationRecordPath(storeDir)} is not a version 1 record`);
  }
  return record as ServiceInstallationRecord;
}

const POINTERS = ['current', 'previous'] as const;
type Pointer = (typeof POINTERS)[number];
/** A SQLite store is its main file plus a WAL or a hot rollback journal; `-shm` is rebuilt and is removed on restore. */
const STORE_FILE_SUFFIXES = ['', '-wal', '-journal'] as const;
const STORE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const STORE_KINDS: ReadonlySet<unknown> = new Set([undefined, 'file', 'directory']);
/** A directory store's tree is copied as it is: links stay links, nothing is overwritten, a clone where the file system has one. */
const TREE_COPY = { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false, preserveTimestamps: true, mode: fsConstants.COPYFILE_FICLONE } as const;
/** How long a stale-token probe waits for the control endpoint to accept or refuse. */
const CONTROL_PROBE_TIMEOUT_MS = 1_000;
const VERDICTS: ReadonlySet<StoreCompatibilityVerdict> = new Set(['accepted', 'migration-required', 'new-path-repair', 'rejected', 'absent']);
/**
 * A first install's store snapshot, `.install-<uuid>`. A version id starts
 * with an alphanumeric, so rollback and recover never select one, and
 * prune() and uninstall() keep every one: a leftover cannot be told from a
 * backup that is still needed.
 */
const INSTALL_SNAPSHOT_PREFIX = '.install-';
/** An install snapshot whose restore failed, renamed so the next first install restores it before anything else. */
const REPAIR_SNAPSHOT_PREFIX = '.install-repair-';

/** A store restore that failed: the stores may be partial, so no service may start on them. */
class StoreRestoreError extends AggregateError {}

/** Failures after which the stores may be partial or their only copy is in a snapshot: nothing starts. */
function startsNothing(error: unknown): boolean {
  return error instanceof StoreRestoreError || (error instanceof ServiceInstallationError && error.code === 'install_snapshot_leftover');
}

/** The causes joinFailure() built, so a second join extends them instead of nesting. */
const joinedCauses = new WeakSet<AggregateError>();

/** More than one store gate or lease failed to release; `errors` lists each failure. */
class StoreReleaseError extends AggregateError {}

/**
 * Joins later failures to the error they followed. A ServiceInstallationError
 * keeps its class, code and stores, with every error in its `cause`; any
 * other error becomes an AggregateError, a StoreRestoreError when it starts
 * nothing.
 */
function joinFailure(failure: unknown, later: readonly unknown[], note: string): Error {
  const message = `${failure instanceof Error ? failure.message : 'Store preparation failed.'} ${note}`;
  const joinedBefore = failure instanceof ServiceInstallationError && failure.cause instanceof AggregateError && joinedCauses.has(failure.cause);
  const errors = [...(joinedBefore ? (failure.cause as AggregateError).errors : [failure]), ...later.flatMap((error) => error instanceof StoreReleaseError ? error.errors : [error])];
  if (failure instanceof ServiceInstallationError) {
    const cause = new AggregateError(errors, message);
    joinedCauses.add(cause);
    const joined = new ServiceInstallationError(failure.code, failure.stores, { cause });
    joined.message = message;
    return joined;
  }
  return startsNothing(failure) ? new StoreRestoreError(errors, message) : new AggregateError(errors, message);
}

/** The failure a withReleaseFailure() result followed, and the release failures joined to it. */
const releaseParts = new WeakMap<object, { failure: unknown; releases: readonly unknown[] }>();

function withReleaseFailure(failure: unknown, releaseError: unknown): Error {
  const joined = joinFailure(failure, [releaseError], 'The store leases could not be released either.');
  releaseParts.set(joined, { failure, releases: releaseError instanceof StoreReleaseError ? releaseError.errors : [releaseError] });
  return joined;
}

/** One error as the flat list a cause holds: a joined release failure and a StoreReleaseError are spread. */
function failureParts(error: unknown): unknown[] {
  const parts = typeof error === 'object' && error !== null ? releaseParts.get(error) : undefined;
  if (parts !== undefined) return [parts.failure, ...parts.releases];
  return error instanceof StoreReleaseError ? [...error.errors] : [error];
}

/**
 * The one exit for a release failure that leaves the receipt `pending`: the
 * next step is recover(), so the top-level code says so. `errors` are in
 * order: the failure that came first (such as `health_check_failed`, a
 * preparation error or `store_busy`), the release failures, then a failed
 * receipt write or restart. The cause is one flat AggregateError.
 */
function storeReleaseFailed(errors: readonly unknown[]): ServiceInstallationError {
  return new ServiceInstallationError('store_release_failed', undefined, { cause: new AggregateError(errors.flatMap(failureParts), 'The store gates or leases could not be released.') });
}

/** The version `<installRoot>/<name>` points at, or `undefined` when the pointer is absent. */
async function readInstallPointer(installRoot: string, name: Pointer): Promise<string | undefined> {
  const link = path.join(installRoot, name);
  let target: string;
  try {
    target = await fs.readlink(link);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const id = path.basename(target.replace(/[\\/]+$/u, ''));
  if (!VERSION_ID.test(id)) throw new Error(`${link} does not point into ${path.join(installRoot, 'versions')}`);
  return id;
}

async function readUpgradeReceipt(installRoot: string): Promise<ServiceUpgradeReceipt | undefined> {
  const receiptPath = path.join(installRoot, 'upgrade-receipt.json');
  let text: string;
  try {
    text = await fs.readFile(receiptPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const receipt = JSON.parse(text) as Partial<ServiceUpgradeReceipt>;
  if (receipt.format !== 'byok-service-upgrade-receipt' || receipt.version !== 1) throw new Error(`${receiptPath} is not a version 1 upgrade receipt`);
  return receipt as ServiceUpgradeReceipt;
}

/**
 * @internal The running version and the last receipt of an install root,
 * read from disk only: no service definition, unit or service manager is
 * involved, so a status read needs none of their inputs (WinSW paths).
 */
export async function readServiceInstallationState(installRoot: string): Promise<{ current: string | undefined; receipt: ServiceUpgradeReceipt | undefined }> {
  const root = path.resolve(installRoot);
  return { current: await readInstallPointer(root, 'current'), receipt: await readUpgradeReceipt(root) };
}

export function createServiceInstallation(opts: ServiceInstallationOptions): ServiceInstallation {
  const program = opts.program(path.join(path.resolve(opts.installRoot), 'current'));
  return serviceInstallationOver(opts, createManagedServiceLifecycle({ ...opts.service, program }, opts.lifecycle));
}

/** The live daemon's lifecycle, or `undefined` while its control socket does not answer. */
async function liveDaemonLifecycle(storeDir: string, productId: string): Promise<DaemonLifecycle | undefined> {
  const connection = await connectControlClient({ storeDir, productId });
  if (!connection.ok) return undefined;
  try {
    return (await connection.client.request<ControlStatusResult>('status')).lifecycle;
  } catch {
    return undefined;
  } finally {
    connection.client.close();
  }
}

/**
 * The default health check: polls the daemon's control socket until its own
 * lifecycle reports a live run ({@link daemonLifecycleHealth}). A
 * service-enrollment daemon that has not paired yet is up, not a failed
 * upgrade, so `awaiting-enrollment` is healthy; a halted or crashed run fails
 * at once (#1097).
 */
export function defaultServiceHealthCheck(options: { storeDir: string; productId: string }): (signal: AbortSignal) => Promise<void> {
  return async (signal) => {
    while (!signal.aborted) {
      const lifecycle = await liveDaemonLifecycle(options.storeDir, options.productId);
      if (lifecycle !== undefined) {
        const health = daemonLifecycleHealth(lifecycle);
        if (health === 'up') return;
        if (health === 'ended') throw new Error(`the daemon is ${lifecycle.phase}`);
      }
      await delay(250);
    }
    throw new Error('the daemon did not report a live lifecycle in time');
  };
}

/**
 * @internal The installation over a given lifecycle; tests drive it with a
 * fake service manager. Every mutation runs inside `lifecycle.owned()`, so
 * another recorded lifecycle owner is refused before anything is written.
 */
export function serviceInstallationOver(opts: ServiceInstallationOptions, lifecycle: ManagedServiceLifecycle): ServiceInstallation {
  if (opts.daemonStores !== undefined && opts.healthCheck === undefined) {
    throw new TypeError('ServiceInstallationOptions.daemonStores requires healthCheck: the default health check reaches only productId\'s daemon');
  }
  // setTimeout takes at most 2^31-1 ms; a larger delay fires at once.
  if (opts.healthTimeoutMs !== undefined && !(Number.isInteger(opts.healthTimeoutMs) && opts.healthTimeoutMs > 0 && opts.healthTimeoutMs <= 2 ** 31 - 1)) {
    throw new TypeError('ServiceInstallationOptions.healthTimeoutMs must be an integer from 1 to 2147483647');
  }
  const root = path.resolve(opts.installRoot);
  const storeDir = opts.service.storeDir;
  const versionsDir = path.join(root, 'versions');
  const snapshotsDir = path.join(root, 'snapshots');
  const receiptPath = path.join(root, 'upgrade-receipt.json');
  const platform = opts.lifecycle?.platform ?? process.platform;

  async function currentVersion(): Promise<string | undefined> {
    return readPointer('current');
  }

  function readPointer(name: Pointer): Promise<string | undefined> {
    return readInstallPointer(root, name);
  }

  /**
   * Points `name` at `versions/<id>`. POSIX renames a fresh symlink over the
   * old one, which is atomic. Windows uses a directory junction, which a
   * rename cannot replace: the old one moves aside first. Both run only while
   * the service is stopped, and a pending receipt makes `recover()` set every
   * pointer again, so the window with no `current` is never observed by a run.
   */
  async function setPointer(name: Pointer, id: string | undefined): Promise<void> {
    const link = path.join(root, name);
    const next = `${link}.next`;
    const old = `${link}.old`;
    await fs.rm(next, { force: true });
    await fs.rm(old, { force: true });
    if (id === undefined) {
      await fs.rm(link, { force: true });
      return;
    }
    if (platform === 'win32') {
      await fs.symlink(path.join(versionsDir, id), next, 'junction');
      if (await exists(link)) await fs.rename(link, old);
      await fs.rename(next, link);
      await fs.rm(old, { force: true });
    } else {
      await fs.symlink(path.join('versions', id), next);
      await fs.rename(next, link);
    }
  }

  function readReceipt(): Promise<ServiceUpgradeReceipt | undefined> {
    return readUpgradeReceipt(root);
  }

  /** Only `recover()` may act while a receipt is `pending`. */
  async function refusePending(): Promise<void> {
    if ((await readReceipt())?.state === 'pending') throw new ServiceInstallationError('upgrade_pending');
  }

  async function writeReceipt(fields: Omit<ServiceUpgradeReceipt, 'format' | 'version' | 'at'>): Promise<ServiceUpgradeReceipt> {
    const receipt: ServiceUpgradeReceipt = { format: 'byok-service-upgrade-receipt', version: 1, ...fields, at: new Date().toISOString() };
    await writeFileAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    return receipt;
  }

  /** Copies the payload into `versions/<id>`, checking every file against the manifest. Returns the id. */
  /** `created` is true only when this call renamed its staging into `versions/<id>`. */
  async function stage(payloadDir: string, { manifest, bytes }: Awaited<ReturnType<typeof readPayload>>): Promise<{ id: string; created: boolean }> {
    const id = manifest.id;
    const target = path.join(versionsDir, id);
    if (await exists(target)) {
      if (!(await matchesManifest(target, manifest, bytes))) throw new ServiceInstallationError('version_conflict');
      await verifyStaged(target, manifest);
      return { id, created: false };
    }
    const staging = path.join(versionsDir, `.staging-${randomUUID()}`);
    await fs.mkdir(staging, { recursive: true });
    try {
      for (const [relative, digest] of Object.entries(manifest.files)) {
        const destination = path.join(staging, ...relative.split('/'));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(path.join(payloadDir, ...relative.split('/')), destination);
        if ((await sha256File(destination)) !== digest) throw new ServiceInstallationError('payload_invalid');
        const mode = (await fs.stat(path.join(payloadDir, ...relative.split('/')))).mode & 0o777;
        await fs.chmod(destination, mode);
      }
      // The parsed bytes, not a second read: a manifest swapped after the check never lands in `versions/`.
      await fs.writeFile(path.join(staging, SERVICE_PAYLOAD_MANIFEST), bytes);
      await verifyStaged(staging, manifest);
      await fs.rename(staging, target);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
    return { id, created: true };
  }

  async function verifyStaged(dir: string, manifest: ServicePayloadManifest): Promise<void> {
    if (opts.verifyPayload === undefined) return;
    try {
      // A frozen copy: the hook reads the manifest and cannot change what stage uses.
      await opts.verifyPayload(dir, deepFreeze(structuredClone(manifest)));
    } catch (error) {
      throw new ServiceInstallationError('payload_invalid', undefined, { cause: error });
    }
  }

  async function writeRecord(): Promise<void> {
    const record: ServiceInstallationRecord = { format: 'byok-service-installation', version: 1, installRoot: root };
    await fs.mkdir(path.dirname(serviceInstallationRecordPath(storeDir)), { recursive: true });
    await writeFileAtomic(serviceInstallationRecordPath(storeDir), `${JSON.stringify(record, null, 2)}\n`);
  }

  /** A same-id reinstall rewrites the unit and launcher and must pass the same health check as a first install. */
  function install(payloadDir: string, installOpts: ServiceInstallOptions = {}): Promise<void> {
    return lifecycle.owned(async (held) => {
      await refusePending();
      // owned() has already checked the owner. Refuse foreign units before
      // staging or writing any installation artifact, not by error class
      // after activation may have written a unit and launcher.
      const inspection = await lifecycle.inspect();
      if (inspection.state === 'foreign' && installOpts.replaceUnmarked !== true) {
        throw new ServiceUnitError('service_unit_unmarked');
      }
      const installed = await currentVersion();
      const payload = await readPayload(payloadDir);
      if (installed !== undefined && installed !== payload.manifest.id) throw new ServiceInstallationError('installation_exists');
      const { id, created } = await stage(payloadDir, payload);
      // An install snapshot must not replace a same-id reinstall's earlier
      // upgrade snapshot, which still belongs to its previous version.
      const snapshotId = `${INSTALL_SNAPSHOT_PREFIX}${randomUUID()}`;
      const stopMarked = inspection.state === 'exact' || inspection.state === 'repairable';
      let prepared: Awaited<ReturnType<typeof prepareStores>> | undefined;
      if (installed === undefined) {
        try {
          prepared = await prepareStores(id, snapshotId, true, stopMarked);
        } catch (error) {
          // Preparation released its leases. Remove staging before
          // restarting an owned marked unit, as upgrade does on refusal.
          // After installation_exists every version directory stays: the
          // other installation may use it. A later prune or uninstall
          // removes what is left. Otherwise only a directory this call
          // created is removed: another installation may have staged it.
          // withReleaseFailure() puts the refusal first.
          let failure = error;
          const original = error instanceof AggregateError ? error.errors[0] : error;
          if (created && !(original instanceof ServiceInstallationError && original.code === 'installation_exists')) {
            try {
              await fs.rm(path.join(versionsDir, id), { recursive: true, force: true });
            } catch (cleanup) {
              failure = joinFailure(error, [cleanup], `The staged version could not be removed: ${path.join(versionsDir, id)}.`);
            }
          }
          // A failed restore may have left partial stores. The unit stays
          // stopped, and our marked unit is removed, as after a failed health
          // check: a boot or login must not start it on those stores. The
          // next install writes it again.
          if (stopMarked && error instanceof StoreRestoreError) {
            try {
              await held.uninstall();
            } catch (removal) {
              throw joinFailure(failure, [removal], `The marked service unit could not be removed: ${inspection.unitPath}.`);
            }
          }
          if (stopMarked && !startsNothing(error)) {
            try {
              await lifecycle.start();
            } catch (restart) {
              throw joinFailure(failure, [restart], 'The marked service could not be restarted.');
            }
          }
          throw failure;
        }
      }
      let storesHeld = prepared !== undefined;
      let activationAttempted = false;
      let health: Awaited<ReturnType<typeof startHealthy>>;
      try {
        await setPointer('current', id);
        await writeRecord();
        if (prepared !== undefined) {
          // A failed release cannot prove the stores are still all held.
          storesHeld = false;
          await prepared.release();
        }
        activationAttempted = true;
        await held.install(installOpts);
        health = await startHealthy();
      } catch (cause) {
        health = { ok: false, cause };
      }
      if (health.ok) {
        // Health commits the installation. Garbage collection cannot turn
        // that success into a rejection with migrated stores still live.
        if (prepared !== undefined) await fs.rm(path.join(snapshotsDir, snapshotId), { recursive: true, force: true }).catch(() => undefined);
        return;
      }

      // Stop and unregister before removing anything the service runs. The
      // stores are restored last, only once no installation artifact is
      // left: a failed restore then always ends with nothing installed and
      // one repair snapshot. The credential store is never touched.
      let releaseRestored: (() => Promise<void>) | undefined;
      let leasesReleased = false;
      const removals = [
        { name: 'service unit and launcher', remove: async () => {
          // A first install that failed before activation has not touched
          // the allowed foreign unit. Never try to uninstall that unit.
          if (activationAttempted || installed !== undefined || stopMarked) await held.uninstall();
        } },
        { name: 'current pointer', remove: () => setPointer('current', undefined) },
        { name: 'installation record', remove: () => fs.rm(serviceInstallationRecordPath(storeDir), { force: true }) },
        { name: 'staged version directory', remove: () => fs.rm(path.join(versionsDir, id), { recursive: true, force: true }) },
        ...(prepared === undefined ? [] : [{ name: 'prepared store snapshot restoration', remove: async () => {
          const release = storesHeld ? prepared.release : await stopQuiescent(false);
          storesHeld = false;
          try {
            await restoreInstallSnapshot(snapshotId);
          } catch (error) {
            // The restore error names where the snapshot is kept: a release
            // failure joins it rather than replacing it.
            try {
              await release();
            } catch (releaseError) {
              throw withReleaseFailure(error, releaseError);
            }
            leasesReleased = true;
            throw error;
          }
          releaseRestored = release;
        } }, { name: 'store lease release', remove: () => releaseRestored!() },
        { name: 'install snapshot directory', remove: () => fs.rm(path.join(snapshotsDir, snapshotId), { recursive: true, force: true }) }]),
      ];
      for (const [index, removal] of removals.entries()) {
        try {
          await removal.remove();
        } catch (cause) {
          // Release the leases a pre-activation failure still holds. The
          // stores stay migrated: they match the artifact that remains, or,
          // when only the restore's leases could not be taken, the version
          // that was removed.
          const later = failureParts(cause);
          if (storesHeld && prepared !== undefined) {
            await prepared.release().catch((releaseError: unknown) => { later.push(...failureParts(releaseError)); });
          }
          const failure = new AggregateError([health.cause, ...later], 'Service installation and removal both failed.');
          const error = new ServiceInstallationError('install_health_check_failed', undefined, { cause: failure });
          // Every failure that stops this loop keeps the install snapshot: name it.
          const snapshotPath = path.join(snapshotsDir, snapshotId);
          const kept = cause instanceof StoreRestoreError
            ? ` ${cause.message}`
            : prepared === undefined ? ''
              : releaseRestored === undefined ? ` The install snapshot is retained at ${snapshotPath}.`
                // Restored stores: the snapshot is an ordinary leftover the next install refuses until it is removed.
                : ` The stores were restored; remove the install snapshot at ${snapshotPath} before the next install.`;
          error.message = `The service failed to install, activate or pass its health check; removal failed. Remaining: ${removals.slice(index).filter((item) => !(leasesReleased && item.name === 'store lease release')).map((item) => item.name).join(', ')}.${kept}`;
          throw error;
        }
      }
      throw new ServiceInstallationError('install_health_check_failed', undefined, { cause: health.cause });
    });
  }

  /** The daemon stores to quiesce, read now: the service has just stopped. */
  async function readDaemonStores(): Promise<readonly ServiceDaemonStore[]> {
    if (opts.daemonStores === undefined) return [{ storeDir, productId: opts.productId }];
    let listed: readonly ServiceDaemonStore[];
    try {
      listed = await opts.daemonStores();
    } catch {
      throw new ServiceInstallationError('daemon_stores_invalid');
    }
    if (!Array.isArray(listed)) throw new ServiceInstallationError('daemon_stores_invalid');
    const seen = new Set<string>();
    return listed.map((store: Partial<ServiceDaemonStore>) => {
      if (typeof store?.storeDir !== 'string' || !path.isAbsolute(store.storeDir) || typeof store.productId !== 'string' || store.productId === '') {
        throw new ServiceInstallationError('daemon_stores_invalid');
      }
      const resolved = path.resolve(store.storeDir);
      if (seen.has(resolved)) throw new ServiceInstallationError('daemon_stores_invalid');
      seen.add(resolved);
      return { storeDir: resolved, productId: store.productId };
    });
  }

  /**
   * Stops the service and takes an `installer` owner lease on every daemon
   * store before one shared deadline: a lease proves the store's last owner
   * is gone and reclaims what a crashed one left, including a `control.token`
   * whose endpoint no longer answers. Then it holds every store gate (taken
   * after the service gate, the documented order, and sorted) and ends
   * whatever the stopped runs left in their owned-process ledgers. The
   * returned release frees every gate, then every lease (a lease's own
   * release takes its store gate), and throws only after all of them were
   * tried: the one failure, or a StoreReleaseError listing each.
   */
  async function stopQuiescent(stopService = true): Promise<() => Promise<void>> {
    if (stopService) await lifecycle.stop();
    const deadline = Date.now() + (opts.stopTimeoutMs ?? 30_000);
    const leases: DaemonOwnerLease[] = [];
    let gates: readonly PathMutationGate[] = [];
    const release = async (): Promise<void> => {
      const failures: unknown[] = [];
      for (const gate of gates) await gate.release().catch((error: unknown) => { failures.push(error); });
      for (const lease of leases) await lease.release().catch((error: unknown) => { failures.push(error); });
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new StoreReleaseError(failures, 'More than one store gate or lease could not be released.');
    };
    try {
      const stores = await readDaemonStores();
      for (const store of stores) {
        leases.push(await leaseStore(store.storeDir, deadline));
        await removeStaleControlToken(store);
      }
      try {
        gates = await acquirePathMutationGates(stores.map((store) => ({ scope: 'store', targetPath: store.storeDir })), { waitMs: 5_000 });
      } catch (error) {
        if (error instanceof PathMutationGateBusyError) throw new ServiceInstallationError('store_busy');
        throw error;
      }
      for (const store of stores) await new OwnedProcessLedger(store.storeDir).reconcile();
    } catch (error) {
      // The stop's own error decides the receipt; a release failure joins it.
      const failure = error instanceof OwnedProcessResidueError ? new ServiceInstallationError('owned_process_residue') : error;
      try {
        await release();
      } catch (releaseError) {
        throw withReleaseFailure(failure, releaseError);
      }
      throw failure;
    }
    return release;
  }

  /**
   * Starts the service and runs its health check against `healthTimeoutMs`,
   * counted from when start settles. A check that ignores its abort signal
   * or succeeds after the deadline fails.
   */
  async function startHealthy(): Promise<{ ok: true } | { ok: false; cause: unknown }> {
    const controller = new AbortController();
    const timeoutMs = opts.healthTimeoutMs ?? 60_000;
    const timedOut = new Error(`the service health check timed out after ${timeoutMs} ms`);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      // Platform commands are outside the health-check deadline and
      // currently have no timeout. Await start before checking health or
      // cleaning up; abandoning it could start a service after its removal.
      await lifecycle.start();
      const check = opts.healthCheck ?? defaultServiceHealthCheck({ storeDir, productId: opts.productId });
      const deadline = Date.now() + timeoutMs;
      timeout = setTimeout(() => controller.abort(), timeoutMs);
      const expired = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(timedOut);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      await Promise.race([check(controller.signal), expired]);
      if (Date.now() >= deadline) throw timedOut;
      return { ok: true };
    } catch (cause) {
      return { ok: false, cause };
    } finally {
      clearTimeout(timeout);
      if (onAbort !== undefined) controller.signal.removeEventListener('abort', onAbort);
    }
  }

  /** Runs the staged candidate's precheck and returns its verdicts. */
  async function precheck(id: string): Promise<ServiceStoreVerdict[]> {
    const program = opts.precheck(path.join(versionsDir, id));
    const { code, stdout } = await runProgram(program);
    if (code !== 0 && code !== 2) throw new ServiceInstallationError('precheck_failed');
    let stores: unknown;
    try {
      stores = (JSON.parse(stdout) as { stores?: unknown }).stores;
    } catch {
      throw new ServiceInstallationError('precheck_failed');
    }
    if (!Array.isArray(stores) || !stores.every(isServiceStoreVerdict) || overlaps(stores)) throw new ServiceInstallationError('precheck_failed');
    if (stores.some(isRefused) !== (code === 2)) throw new ServiceInstallationError('precheck_failed');
    return stores.map((store) => store.kind === 'directory' ? { ...store, path: directoryStorePath(store.path) } : store);
  }

  /** One candidate store preparation sequence for install and upgrade, retaining the quiescent leases until the caller switches. */
  async function prepareStores(candidate: string, snapshotId: string, installing = false, stopService = !installing): Promise<{ stores: ServiceStoreVerdict[]; release: () => Promise<void> }> {
    // Listed before quiescence only to decide what a failed stop or lease
    // means: with an install snapshot pending the stores may be partial, so
    // that failure starts nothing.
    const pending = installing ? await listInstallSnapshots() : [];
    // A first install stops only a marked unit of our owner. Absent and
    // allowed-unmarked units rely on the store lease alone.
    let release: () => Promise<void>;
    try {
      release = await stopQuiescent(stopService);
    } catch (error) {
      if (pending.length > 0) throw unrestoredRepair(pending, error);
      throw error;
    }
    let restoreOnFailure = false;
    try {
      // Every decision uses `current` and the inventory read under the
      // leases: until then another installation (an owner gate under another
      // gate root) can still change them.
      if (installing) {
        if ((await currentVersion()) !== undefined) throw new ServiceInstallationError('installation_exists');
        await restoreRepairSnapshots(checkInstallSnapshots(await listInstallSnapshots()));
      }
      let stores = await precheck(candidate);
      const refused = stores.find(isRefused);
      if (refused !== undefined) {
        throw new ServiceInstallationError(refused.verdict === 'new-path-repair' ? 'store_repair_required' : 'store_rejected', stores);
      }
      await snapshot(snapshotId, stores);
      if (stores.some((store) => store.verdict === 'migration-required')) {
        restoreOnFailure = opts.migrate !== undefined;
        stores = await migrateStores(candidate, stores);
      }
      return { stores, release };
    } catch (error) {
      let failure = error;
      try {
        if (restoreOnFailure) {
          if (installing) await restoreInstallSnapshot(snapshotId, error);
          else await restoreUpgradeSnapshot(snapshotId, error);
        }
        // A leftover is kept and never restored; its removal error must not replace the store code.
        if (installing) await fs.rm(path.join(snapshotsDir, snapshotId), { recursive: true, force: true }).catch(() => undefined);
      } catch (restoreError) {
        failure = restoreError;
      }
      try {
        await release();
      } catch (releaseError) {
        throw withReleaseFailure(failure, releaseError);
      }
      throw failure;
    }
  }

  /**
   * Runs the Host's migration of the candidate's stores, after the snapshot
   * and while every writer is stopped, then the precheck again. The shared
   * preparation restores the snapshot before propagating a migration error.
   * Every failure here is `store_migration_failed`. A throwing `migrate`
   * callback, a launch that throws (such as an invalid command or argument)
   * or a failed precheck is its cause. A program the OS cannot start (exit
   * code null) or that exits nonzero has no cause.
   */
  async function migrateStores(to: string, stores: readonly ServiceStoreVerdict[]): Promise<ServiceStoreVerdict[]> {
    if (opts.migrate === undefined) throw new ServiceInstallationError('store_migration_required', stores);
    let code: number | null;
    let migrated: ServiceStoreVerdict[];
    try {
      ({ code } = await runProgram(opts.migrate(path.join(versionsDir, to))));
      if (code !== 0) throw new ServiceInstallationError('store_migration_failed', stores);
      migrated = await precheck(to);
    } catch (error) {
      if (error instanceof ServiceInstallationError && error.code === 'store_migration_failed') throw error;
      throw new ServiceInstallationError('store_migration_failed', stores, { cause: error });
    }
    if (!migrated.every((store) => store.verdict === 'accepted' || store.verdict === 'absent')) {
      throw new ServiceInstallationError('store_migration_failed', migrated);
    }
    return migrated;
  }

  /**
   * Copies every listed store to `snapshots/<to>`: a file store's files as
   * `<index><suffix>`, a directory store's tree as `<index>.d`. Every store
   * is checked with `lstat` first, so nothing is followed through a symlink.
   * `snapshot.json` is written last and marks a complete snapshot; a copy
   * that fails removes the partial snapshot.
   */
  async function snapshot(to: string, stores: readonly ServiceStoreVerdict[]): Promise<void> {
    const sources = await Promise.all(stores.map(storeSources));
    const dir = path.join(snapshotsDir, to);
    await fs.rm(dir, { recursive: true, force: true });
    try {
      await fs.mkdir(dir, { recursive: true });
      const entries: SnapshotEntry[] = [];
      for (const [index, store] of stores.entries()) {
        const files: Record<string, string> = {};
        for (const suffix of sources[index]!) {
          const name = store.kind === 'directory' ? `${index}.d` : `${index}${suffix}`;
          if (store.kind === 'directory') await fs.cp(store.path, path.join(dir, name), TREE_COPY);
          else await fs.copyFile(`${store.path}${suffix}`, path.join(dir, name));
          files[suffix] = name;
        }
        entries.push({ store: store.store, path: store.path, ...(store.kind === 'directory' ? { kind: 'directory' as const } : {}), files });
      }
      await writeFileAtomic(path.join(dir, 'snapshot.json'), `${JSON.stringify({ entries }, null, 2)}\n`);
    } catch (error) {
      // The cleanup is best effort: the receipt must say snapshot_failed, with the copy error as its cause.
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw new ServiceInstallationError('snapshot_failed', undefined, { cause: error });
    }
  }

  async function restoreSnapshot(to: string): Promise<void> {
    const dir = path.join(snapshotsDir, to);
    const snapshot = JSON.parse(await fs.readFile(path.join(dir, 'snapshot.json'), 'utf8')) as { entries: SnapshotEntry[] };
    // Older snapshots retain the Host's spelling. Check every directory root
    // before changing any store, including links hidden by a trailing / or /.
    const entries = snapshot.entries.map((entry) => entry.kind === 'directory' ? { ...entry, path: directoryStorePath(entry.path) } : entry);
    await Promise.all(entries.filter((entry) => entry.kind === 'directory').map(async (entry) => {
      try {
        if ((await fs.lstat(entry.path)).isSymbolicLink()) throw new ServiceInstallationError('precheck_failed');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }));
    for (const entry of entries) {
      if (entry.kind === 'directory') {
        await fs.rm(entry.path, { recursive: true, force: true });
        if (entry.files[''] !== undefined) await fs.cp(path.join(dir, entry.files['']), entry.path, TREE_COPY);
        continue;
      }
      for (const suffix of [...STORE_FILE_SUFFIXES, '-shm']) await fs.rm(`${entry.path}${suffix}`, { force: true });
      for (const [suffix, name] of Object.entries(entry.files)) await fs.copyFile(path.join(dir, name), `${entry.path}${suffix}`);
    }
  }

  /**
   * Restores a first install's snapshot. When the restore fails, one rename
   * marks the snapshot for repair; when that rename fails too, it keeps its
   * ordinary name, which nothing restores automatically.
   */
  async function restoreInstallSnapshot(snapshotId: string, failure?: unknown): Promise<void> {
    try {
      await restoreSnapshot(snapshotId);
    } catch (restoreError) {
      let kept = path.join(snapshotsDir, snapshotId);
      const repair = path.join(snapshotsDir, `${REPAIR_SNAPSHOT_PREFIX}${snapshotId.slice(INSTALL_SNAPSHOT_PREFIX.length)}`);
      try {
        await fs.rename(kept, repair);
        kept = repair;
      } catch { /* The error below names the path the snapshot kept. */ }
      const errors = failure === undefined ? [restoreError] : [failure, restoreError];
      throw new StoreRestoreError(errors, `${failure === undefined ? 'The prepared stores' : 'Store preparation failed and its stores'} could not be restored; the snapshot is retained at ${kept}.`);
    }
  }

  /** The install snapshots under snapshots/. A listing failure cannot rule a repair snapshot out, so it counts as a failed restore. */
  async function listInstallSnapshots(): Promise<string[]> {
    try {
      return (await listDir(snapshotsDir)).filter((entry) => entry.startsWith(INSTALL_SNAPSHOT_PREFIX));
    } catch (error) {
      throw new StoreRestoreError([error], `The install snapshots under ${snapshotsDir} could not be listed; the stores may be partial.`);
    }
  }

  /**
   * Returns the repair snapshot a first install restores. Any other install
   * snapshot left by an earlier call refuses the install: it may hold the
   * only copy of the stores, and nothing tells whether it is still needed.
   */
  function checkInstallSnapshots(names: readonly string[]): string[] {
    const leftovers = names.filter((name) => !name.startsWith(REPAIR_SNAPSHOT_PREFIX));
    if (leftovers.length > 0) {
      const error = new ServiceInstallationError('install_snapshot_leftover');
      error.message = `${error.message} ${leftovers.map((name) => path.join(snapshotsDir, name)).join(', ')}`;
      throw error;
    }
    const repairs = names.filter((name) => name.startsWith(REPAIR_SNAPSHOT_PREFIX));
    // A uuid does not order them in time, so restoring each in turn could
    // leave an older state last. An operator chooses.
    if (repairs.length > 1) {
      throw new StoreRestoreError([new Error('more than one repair snapshot')], `More than one install repair snapshot exists; nothing was restored. Keep the one to restore and remove the others: ${repairs.map((name) => path.join(snapshotsDir, name)).join(', ')}.`);
    }
    return repairs;
  }

  function unrestoredRepair(names: readonly string[], error: unknown): StoreRestoreError {
    const kept = names.map((name) => path.join(snapshotsDir, name)).join(', ');
    return new StoreRestoreError([error], `The stores of an earlier failed install were not restored; the snapshot is retained at ${kept}.`);
  }

  /** Restores an upgrade's snapshot after a failed preparation; a failure keeps the snapshot and the pending receipt for recover(). */
  async function restoreUpgradeSnapshot(to: string, failure: unknown): Promise<void> {
    try {
      await restoreSnapshot(to);
    } catch (restoreError) {
      throw new StoreRestoreError([failure, restoreError], `Store preparation failed and its stores could not be restored; the snapshot is retained at ${path.join(snapshotsDir, to)}. The service was not restarted and the upgrade stays pending: call recover() (CLI: byok-agent upgrade recover) before anything restarts the service.`);
    }
  }

  /**
   * Run by a first install under the store leases, before its precheck:
   * when an earlier install failed and could not restore its own snapshot,
   * restores the stores from that kept repair snapshot, as they were before
   * the earlier install. Without it, a retry would read half-restored stores
   * as absent. A failure is the same restore error and changes nothing else.
   */
  async function restoreRepairSnapshots(names: readonly string[]): Promise<void> {
    for (const name of names) {
      const repair = path.join(snapshotsDir, name);
      try {
        await restoreSnapshot(name);
      } catch (error) {
        throw unrestoredRepair([name], error);
      }
      // One rename retires the repair name, so this install never runs
      // beside it; removing the renamed copy is best effort. While the name
      // stays, a later install would restore it over what a restarted
      // service wrote, so a failed rename starts nothing either.
      const done = path.join(snapshotsDir, `${INSTALL_SNAPSHOT_PREFIX}${randomUUID()}`);
      try {
        await fs.rename(repair, done);
      } catch (error) {
        throw new StoreRestoreError([error], `The stores of an earlier failed install were restored, but its repair snapshot could not be retired; it is retained at ${repair} and the next install restores it again.`);
      }
      await fs.rm(done, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Brings `from` back under a `pending` receipt: stops whatever runs,
   * restores the snapshot taken for `to`, points `current` at `from` and
   * `previous` at `previous`, then starts `from` and checks its health. The
   * snapshot is removed only after the final receipt is written, so until
   * then `recover()` can run every step again from what is on disk.
   */
  async function restore(from: string, to: string, previous: string | undefined, code?: ServiceInstallationErrorCode, prior: readonly unknown[] = []): Promise<ServiceUpgradeReceipt> {
    // The receipt is pending until the end: a release failure on any exit is store_release_failed.
    let release: () => Promise<void>;
    try {
      release = await stopQuiescent();
    } catch (error) {
      if (releaseParts.has(error as object)) throw storeReleaseFailed([...prior, error]);
      throw error;
    }
    try {
      // The write-ahead pending receipt may predate the snapshot: nothing was
      // switched or rewritten then, so `from` only needs to run again.
      if (await exists(path.join(snapshotsDir, to, 'snapshot.json'))) await restoreSnapshot(to);
      await setPointer('current', from);
      await setPointer('previous', previous);
    } catch (error) {
      try {
        await release();
      } catch (releaseError) {
        throw storeReleaseFailed([...prior, error, releaseError]);
      }
      throw error;
    }
    try {
      await release();
    } catch (releaseError) {
      throw storeReleaseFailed([...prior, releaseError]);
    }
    const kept = previous === undefined ? {} : { previous };
    const receipt = (await startHealthy()).ok
      ? await writeReceipt({ state: 'rolled-back', from, to, ...kept, ...(code === undefined ? {} : { code }) })
      : await writeReceipt({ state: 'failed', from, to, ...kept, code: 'rollback_unhealthy' });
    await fs.rm(path.join(snapshotsDir, to), { recursive: true, force: true });
    return receipt;
  }

  /** Keeps `current` and `previous`, the snapshot of the last switch and every install snapshot; removes every other version and snapshot. */
  async function prune(current: string, previous: string): Promise<void> {
    for (const name of await listDir(versionsDir)) {
      if (name !== current && name !== previous) await fs.rm(path.join(versionsDir, name), { recursive: true, force: true });
    }
    for (const name of await listDir(snapshotsDir)) {
      // The upgrade is committed: a snapshot that cannot be removed is left
      // for the prune of the next successful upgrade to try again. Nothing selects it meanwhile (rollback reads only
      // the snapshot of `current`; upgrade removes snapshots/<to> first).
      if (name !== current && !name.startsWith(INSTALL_SNAPSHOT_PREFIX)) await fs.rm(path.join(snapshotsDir, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  function upgrade(payloadDir: string): Promise<ServiceUpgradeReceipt> {
    return lifecycle.owned(async () => {
      await refusePending();
      const from = await currentVersion();
      if (from === undefined) throw new ServiceInstallationError('installation_absent');
      const { id: to } = await stage(payloadDir, await readPayload(payloadDir));
      if (to === from) throw new ServiceInstallationError('version_current');
      const previous = await readPointer('previous');
      const kept = previous === undefined ? {} : { previous };

      // A failed attempt after its snapshot leaves snapshots/<to>. Remove it
      // before the intent: recover() restores any snapshot it finds for `to`,
      // and an old one would overwrite what `from` wrote since.
      await fs.rm(path.join(snapshotsDir, to), { recursive: true, force: true });
      // Write-ahead: the service may be stopped from here on, so the intent
      // must be on disk before the stop. A death between this write and the
      // switch leaves recover() a pending receipt to finish or roll back;
      // before it, nothing has changed and a failure restarts `from`.
      await writeReceipt({ state: 'pending', from, to, ...kept });
      let stores: ServiceStoreVerdict[];
      let release: () => Promise<void>;
      try {
        ({ stores, release } = await prepareStores(to, to));
      } catch (error) {
        // The refusal keeps its code: a release, receipt or restart failure
        // after it joins its cause.
        const later: unknown[] = [];
        let final = false;
        let receiptFailed = false;
        if (error instanceof ServiceInstallationError) {
          await writeReceipt({ state: 'failed', from, to, code: error.code, ...(error.stores ? { stores: [...error.stores] } : {}) })
            .then(() => { final = true; }, (receiptError: unknown) => { receiptFailed = true; later.push(receiptError); });
        }
        // `from` stays stopped while the receipt stays pending: recover()
        // restores the snapshot, which would overwrite what a restarted
        // service wrote. Stores whose restore failed may be partial too.
        if (!startsNothing(error) && !receiptFailed) await lifecycle.start().catch((startError: unknown) => { later.push(startError); });
        if (!final && releaseParts.has(error as object)) throw storeReleaseFailed([error, ...later]);
        if (receiptFailed) throw joinFailure(error, later, 'Its failed receipt could not be written: the previous version stays stopped and the receipt stays pending. Run recover() (CLI: byok-agent upgrade recover).');
        throw later.length === 0 ? error : joinFailure(error, later, 'Restarting the previous version failed too.');
      }

      // From here a crash leaves the pending receipt, which recover() resolves.
      // The leases and gates are held through the switch.
      try {
        await setPointer('previous', from);
        await setPointer('current', to);
      } catch (error) {
        try {
          await release();
        } catch (releaseError) {
          throw storeReleaseFailed([error, releaseError]);
        }
        throw error;
      }
      // Before the switched receipt: the receipt stays pending for recover().
      try {
        await release();
      } catch (releaseError) {
        throw storeReleaseFailed([releaseError]);
      }
      const health = await startHealthy();
      if (!health.ok) {
        const receipt = await restore(from, to, previous, 'health_check_failed', [new ServiceInstallationError('health_check_failed', undefined, { cause: health.cause })]);
        throw new ServiceInstallationError(receipt.state === 'rolled-back' ? 'health_check_failed' : 'rollback_unhealthy');
      }
      const receipt = await writeReceipt({ state: 'switched', from, to, stores });
      await prune(to, from);
      return receipt;
    });
  }

  function rollback(): Promise<ServiceUpgradeReceipt> {
    return lifecycle.owned(async () => {
      await refusePending();
      const [current, previous] = [await currentVersion(), await readPointer('previous')];
      if (current === undefined || previous === undefined || !(await exists(path.join(snapshotsDir, current, 'snapshot.json')))) {
        throw new ServiceInstallationError('no_rollback');
      }
      // The pending receipt is what recover() completes: the same restore of `previous` with this snapshot.
      await writeReceipt({ state: 'pending', from: previous, to: current });
      return restore(previous, current, undefined);
    });
  }

  function recover(): Promise<ServiceUpgradeReceipt | undefined> {
    return lifecycle.owned(async () => {
      const last = await readReceipt();
      if (last?.state !== 'pending') return last;
      return restore(last.from, last.to, last.previous, 'upgrade_pending');
    });
  }

  function uninstall(): Promise<void> {
    return lifecycle.owned(async (held) => {
      await refusePending();
      // snapshots/ is listed below; a link would lead the removal outside the root.
      try {
        if ((await fs.lstat(snapshotsDir)).isSymbolicLink()) {
          const error = new ServiceInstallationError('snapshots_symlinked');
          error.message = `${error.message} (${snapshotsDir})`;
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await held.uninstall();
      for (const name of POINTERS) await setPointer(name, undefined);
      await fs.rm(versionsDir, { recursive: true, force: true });
      // Install snapshots stay, and so does `snapshots/` around them.
      const snapshots = await listDir(snapshotsDir);
      if (snapshots.some((name) => name.startsWith(INSTALL_SNAPSHOT_PREFIX))) {
        for (const name of snapshots) {
          if (!name.startsWith(INSTALL_SNAPSHOT_PREFIX)) await fs.rm(path.join(snapshotsDir, name), { recursive: true, force: true });
        }
      } else {
        await fs.rm(snapshotsDir, { recursive: true, force: true });
      }
      await fs.rm(receiptPath, { force: true });
      await fs.rm(serviceInstallationRecordPath(storeDir), { force: true });
    });
  }

  return { lifecycle, install, upgrade, rollback, recover, uninstall, receipt: readReceipt, currentVersion };
}

interface SnapshotEntry {
  store: string;
  path: string;
  /** Absent in a snapshot 0.34 wrote, and for every file store. */
  kind?: 'directory';
  /** Saved files by suffix (`''`, `-wal`, `-journal`; a directory's tree under `''`); empty when the store was absent. */
  files: Record<string, string>;
}

/**
 * The suffixes of a store that exist now: a file store's regular files, or a
 * directory store's real directory under `''`. Anything else at a store path
 * (a symlink, a directory for a file store, a file for a directory store) is
 * `precheck_failed`.
 */
async function storeSources(store: ServiceStoreVerdict): Promise<string[]> {
  const suffixes = store.kind === 'directory' ? [''] : [...STORE_FILE_SUFFIXES];
  const present: string[] = [];
  for (const suffix of suffixes) {
    let stat: import('node:fs').Stats;
    try {
      stat = await fs.lstat(`${store.path}${suffix}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!(store.kind === 'directory' ? stat.isDirectory() : stat.isFile())) throw new ServiceInstallationError('precheck_failed');
    present.push(suffix);
  }
  return present;
}

/** Strip only terminal separators and dot components, exposing the root to lstat.
 * Do not resolve symlinks or collapse interior `..`: those can change the target. */
function directoryStorePath(input: string): string {
  const root = path.parse(input).root;
  const separators = process.platform === 'win32' ? /[\\/]+$/u : /\/+$/u;
  let value = input;
  while (value.length > root.length) {
    const trimmed = value.replace(separators, '');
    if (trimmed.length < root.length) return root;
    if (path.basename(trimmed) !== '.') return trimmed;
    value = path.dirname(trimmed);
  }
  return value;
}

export async function readPayloadManifest(payloadDir: string): Promise<ServicePayloadManifest> {
  return (await readPayload(payloadDir)).manifest;
}

/** The payload's manifest and its exact bytes; every file it lists must exist and no other file may. */
async function readPayload(payloadDir: string): Promise<{ manifest: ServicePayloadManifest; bytes: Uint8Array }> {
  let bytes: Uint8Array;
  let manifest: Partial<ServicePayloadManifest>;
  try {
    bytes = await fs.readFile(path.join(payloadDir, SERVICE_PAYLOAD_MANIFEST));
    manifest = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<ServicePayloadManifest>;
  } catch {
    throw new ServiceInstallationError('payload_invalid');
  }
  if (!isJsonObject(manifest)) throw new ServiceInstallationError('payload_invalid');
  const files = manifest.files;
  const valid = manifest.format === 'byok-service-payload' && manifest.version === 1
    && typeof manifest.id === 'string' && VERSION_ID.test(manifest.id)
    && typeof files === 'object' && files !== null && Object.keys(files).length > 0
    && Object.entries(files).every(([relative, digest]) => isPayloadPath(relative) && typeof digest === 'string' && SHA256_HEX.test(digest))
    && (manifest.meta === undefined || isJsonObject(manifest.meta));
  if (!valid) throw new ServiceInstallationError('payload_invalid');
  const present = (await listFiles(payloadDir)).filter((relative) => relative !== SERVICE_PAYLOAD_MANIFEST);
  const listed = new Set(Object.keys(files!));
  if (present.length !== listed.size || !present.every((relative) => listed.has(relative))) throw new ServiceInstallationError('payload_invalid');
  return { manifest: manifest as ServicePayloadManifest, bytes };
}

/** Whether `dir` holds exactly the manifest's files and the same manifest bytes. */
async function matchesManifest(dir: string, manifest: ServicePayloadManifest, bytes: Uint8Array): Promise<boolean> {
  const files = await listFiles(dir);
  if (files.length !== Object.keys(manifest.files).length + 1) return false;
  const staged = path.join(dir, SERVICE_PAYLOAD_MANIFEST);
  if (!(await exists(staged)) || !Buffer.from(bytes).equals(await fs.readFile(staged))) return false;
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const file = path.join(dir, ...relative.split('/'));
    if (!(await exists(file)) || (await sha256File(file)) !== digest) return false;
  }
  return true;
}

/** Every regular file under `dir`; a symlink or other entry fails the payload. */
function listFiles(dir: string): Promise<string[]> {
  return listPayloadFiles(dir, () => new ServiceInstallationError('payload_invalid'));
}

function isServiceStoreVerdict(value: unknown): value is ServiceStoreVerdict {
  if (typeof value !== 'object' || value === null) return false;
  const store = value as Record<string, unknown>;
  return typeof store.store === 'string' && STORE_ID.test(store.store) && typeof store.path === 'string' && path.isAbsolute(store.path)
    && STORE_KINDS.has(store.kind) && typeof store.reason === 'string' && VERDICTS.has(store.verdict as StoreCompatibilityVerdict);
}

/** A verdict that stops the upgrade before the snapshot; `migration-required` is not one. */
function isRefused(store: ServiceStoreVerdict): boolean {
  return store.verdict === 'new-path-repair' || store.verdict === 'rejected';
}

/** Whether two stores share a path or one lies inside a directory store. */
function overlaps(stores: readonly ServiceStoreVerdict[]): boolean {
  const paths = stores.map((store) => path.resolve(store.path));
  return stores.some((store, index) => paths.some((other, at) => at !== index
    && (other === paths[index] || (store.kind === 'directory' && other.startsWith(`${paths[index]}${path.sep}`)))));
}

/**
 * Takes an `installer` lease on a stopped daemon's store, retrying while its
 * last owner is still alive or another process is reclaiming its lease. `acquireDaemonOwner` reclaims the owner files of
 * a dead one.
 */
async function leaseStore(storeDir: string, deadline: number): Promise<DaemonOwnerLease> {
  for (;;) {
    try {
      return await acquireDaemonOwner(storeDir, 'installer');
    } catch (error) {
      if (!(error instanceof DaemonOwnerActiveError) && !(error instanceof DaemonOwnerReclaimingError)) throw error;
      if (Date.now() >= deadline) throw new ServiceInstallationError('store_busy');
      await delay(100);
    }
  }
}

/**
 * Under the store's lease no daemon can serve it, so a `control.token` whose
 * endpoint refuses connections was left by a crashed run and is removed. An
 * endpoint that answers, or whose state is unknown (including no answer
 * within {@link CONTROL_PROBE_TIMEOUT_MS}), is `store_busy`.
 */
async function removeStaleControlToken(store: ServiceDaemonStore): Promise<void> {
  const token = controlTokenPath(store.storeDir);
  if (!(await exists(token))) return;
  const refused = await new Promise<boolean>((resolve) => {
    const socket = createConnection(controlEndpointPath(store.productId, store.storeDir));
    const timer = setTimeout(() => finish(false), CONTROL_PROBE_TIMEOUT_MS);
    const finish = (result: boolean): void => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => finish(false));
    socket.once('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ECONNREFUSED' || error.code === 'ENOENT'));
  });
  if (!refused) throw new ServiceInstallationError('store_busy');
  await fs.rm(token, { force: true });
}

function runProgram(program: ServiceProgram): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(program.command, program.args, { cwd: program.cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
      resolve({ code, stdout });
    });
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function writeFileAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, content, 'utf8');
  await fs.rename(temp, file);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

