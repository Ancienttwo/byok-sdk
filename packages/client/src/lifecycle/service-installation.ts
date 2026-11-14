import { execFile, spawn } from 'node:child_process';
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
import { ownedProcessGroupRecord, ownedProcessGroupRuns, type OwnedProcessGroupRecord } from '../adapters/process-tree.js';
import { acquirePathMutationGate, acquirePathMutationGates, PathMutationGateBusyError, type PathMutationGate } from '../util/path-mutation-gate.js';
import { createManagedServiceLifecycle, type CreateServiceLifecycleOptions } from './create-service-lifecycle.js';
import { canonical, checkRestoreTargets, checkStorePaths, directoryStorePath, mkdirReal, parseSnapshotRecord, resolveTrusted, SNAPSHOT_FORMAT, within, type SnapshotEntry, type SnapshotRecord, type StorePathRefusal } from './store-path-identity.js';
import type { HeldServiceLifecycle, ManagedServiceLifecycle } from './managed-lifecycle.js';
import {
  isJsonObject, isPayloadPath, listPayloadFiles, SERVICE_PAYLOAD_MANIFEST, sha256File, SHA256_HEX, VERSION_ID, type ServicePayloadManifest,
} from '../service-payload-manifest.js';
import { ServiceUnitError, throwPublicCommandTimeout } from './service-unit.js';
import { readInstallPointer, readServiceInstallationRecord, serviceInstallationRecordPath, type InstallPointer, type ServiceInstallationRecord } from '../util/service-installation-record.js';
import type { ServiceDefinition, ServiceInstallOptions, ServiceLifecycle, ServiceProgram } from './service-types.js';

/**
 * One store the candidate's precheck reports (#1328): an SDK `LocalStoreId`
 * or a Host store id, with the verdict the candidate gives it. The snapshot
 * covers exactly the reported stores.
 */
export interface ServiceStoreVerdict {
  /** An SDK `LocalStoreId` or a Host store id: 1-64 of `a-z 0-9 -`, starting with a letter or digit. */
  readonly store: string;
  /**
   * Absolute. No two stores share a path or lie inside each other, compared
   * both as written and with links resolved (#2106): a store under another,
   * also only through a link, is `precheck_failed`, and so is a snapshot
   * entry an earlier version recorded that way, before a restore changes
   * any store.
   */
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
  /**
   * The service program, run from `versionDir` (`<installRoot>/current`):
   * the command or an argument must lie under it, or creating the
   * installation is `service_program_not_current` (#2011). upgrade() and
   * rollback() also require the installed unit to be exactly the one this
   * SDK writes. Both are plausibility checks: a removed `current` gates
   * every start only if the program really runs from it, which is the
   * Host's contract.
   */
  program(versionDir: string): ServiceProgram;
  /**
   * The candidate's store precheck, run from its staged `versionDir` while
   * every writer is stopped. It prints `{ "stores": ServiceStoreVerdict[] }`
   * (`byok-agent upgrade check --store --json` prints the SDK's own stores in
   * this shape) and exits 2 when a store is `new-path-repair` or `rejected`,
   * 0 otherwise. Every store the candidate rewrites must be
   * listed, Host stores included: the snapshot covers exactly the listed
   * stores. Output that breaks {@link ServiceStoreVerdict}'s rules is
   * `precheck_failed`; a store that is, holds or lies in the install root
   * or a daemon store's `service/` directory, after resolving links and
   * without case on darwin and win32, is `store_overlaps_service_state`
   * (#2011). A store path with a `..` segment (either separator on win32)
   * is `precheck_failed`: pass normalized absolute paths. On an upgrade's
   * first precheck a refusal touches no store and takes no snapshot: the
   * final receipt carries its code, `current` points at the previous version
   * again and that service restarts. On a first install no receipt is
   * written, a version directory this call staged is removed and a marked
   * unit it stopped restarts. On the precheck after a migration the refusal
   * is the cause of `store_migration_failed`, after the snapshot restores.
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
   * with a thrown or precheck error as `cause`. On upgrade it is recorded
   * in the pending receipt before it is awaited (#2011): on POSIX the
   * process group it leads, on Windows its pid and start time. Until that
   * group (on Windows, the root) has ended, nothing restores or starts on
   * the stores: upgrade() throws `upgrade_pending` and recover() changes
   * nothing. When the record cannot be written, the group gets SIGTERM, then
   * SIGKILL after a second; only once it is proved gone (ESRCH) is anything
   * restored, else the call is `upgrade_pending` with `current` absent. A pgid reused by another group also reads as running; recover()
   * then refuses until that group ends or the machine restarts. A process
   * that leaves the group (setsid), what a Windows root starts, and a death
   * between spawn and record stay the Host's responsibility. The Host
   * must make this program safe to run again after interruption: install
   * has no write-ahead receipt for a process death during migration.
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
   * activation, start and cleanup stop run outside it. Each service manager
   * command has its own fixed bound (30 s; WinSW 120 s; the Host's Windows
   * stop program 60 s) and is stopped past it, as `ServiceUnitError`
   * `service_command_timeout` (#1971). Where each operation reports it:
   * {@link ServiceInstallation}.
   */
  healthTimeoutMs?: number;
  /**
   * Every daemon store the service process owns, leased on a first install
   * and read after stopping the service on upgrade, rollback and recover
   * (#1328, #1983). Each `storeDir`
   * is absolute and listed once, compared with its links resolved (#2161):
   * a second spelling of one store would take a second lease on it and wait
   * for its own first one until `store_busy`. `productId` is not empty; an
   * empty list is valid. An invalid list or a throw is
   * `daemon_stores_invalid`. Default:
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
 * The upgrade receipt a Host UI reads (`upgrade-receipt.json`, version 2,
 * #2011):
 *
 * - `pending`: an operation of `kind` began and has not settled. Only
 *   `recover()` resolves it, from the receipt and where `current` points:
 *   a payload starts only through `current`, so the stores are restored
 *   only while `current` is absent, and a present `current` always runs as
 *   it is. A rollback journals its target as `from`.
 * - `switched`: `to` runs and passed the health check.
 * - `rolled-back`: `from` runs again with its store snapshot; `code` says why.
 * - `failed`: nothing was switched (`code` and, for a store refusal,
 *   `stores` say why), a restored `from` failed its health check
 *   (`rollback_unhealthy`), or `to` stays current but failed its health
 *   check after an interruption (`switch_unhealthy`): the Host decides
 *   whether to call rollback() or keep it.
 */
export interface ServiceUpgradeReceipt {
  format: 'byok-service-upgrade-receipt';
  version: 2;
  state: 'pending' | 'switched' | 'rolled-back' | 'failed';
  /** What a `pending` receipt journals: an upgrade, a rollback, or a same-id reinstall (`repair`, `from` = `to`). */
  kind?: 'upgrade' | 'rollback' | 'repair';
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
 *
 * A platform command that outlives its bound is `ServiceUnitError`
 * `service_command_timeout` (#1971): a service manager command, or `icacls`
 * when a store is leased on Windows. Each operation reports it as follows;
 * "in `cause`" means through `cause` and an `AggregateError`'s `errors`.
 *
 * - Every operation first restores the repair snapshot of an earlier failed
 *   install when `current` is absent; a timed-out stop or store lease there
 *   is `upgrade_pending`, with the timeout in `cause`.
 * - `install()`, first install: a timed-out stop of the marked unit or store
 *   lease, before anything is installed, is thrown as is; a timed-out
 *   restart of that unit after a failed preparation joins the `cause` of
 *   the preparation's error. A timed-out activation or start is
 *   `install_health_check_failed` with it in `cause`, as is a timed-out unit
 *   removal during the cleanup that follows (`upgrade_pending` instead when
 *   that cleanup cannot restore the stores).
 * - `install()`, same-version reinstall: a timed-out stop before the unit
 *   rewrite is thrown as is, and the pending `repair` receipt stays (recover()
 *   then reports `repair_interrupted`). A timed-out activation or start is
 *   `install_health_check_failed` with it in `cause`.
 * - `upgrade()`: a timed-out stop or store lease before the switch is
 *   `upgrade_pending` with it in `cause`. A timed-out start of the candidate
 *   is `health_check_failed` with it in `cause`, and the rollback runs; a
 *   timed-out stop or lease in that rollback makes it `upgrade_pending`, and
 *   a timed-out start of the restored version joins the `cause` of
 *   `health_check_failed`. A store refusal whose restart of the previous
 *   version times out keeps the refusal's code, with the timeout in `cause`.
 * - `rollback()`: a timed-out stop or store lease is thrown as is; only the
 *   stop has run. A timed-out start of the restored version is not thrown:
 *   rollback() resolves with a `failed` receipt, `rollback_unhealthy`.
 * - `recover()`: a timed-out stop or store lease before a restore is
 *   `upgrade_pending` with it in `cause`. A timed-out start is not thrown:
 *   recover() resolves with a `failed` receipt (`switch_unhealthy` or
 *   `rollback_unhealthy`).
 * - `uninstall()`: a timed-out stop, unregistration or `daemon-reload` is
 *   thrown as is, after `current` is removed; the unit files stay when the
 *   stop or unregistration timed out.
 * - `lifecycle`: each of its operations rejects with it as is.
 *
 * A payload starts only through `current` (#2011): while a pending receipt
 * has `current` absent the stores may be mid-restore, and the SDK's own
 * daemon start (`byok-agent start`, createDaemon) refuses with
 * `store_owned`. A symbolic link anywhere under `snapshots/` (the directory,
 * a snapshot, a snapshot file) is `snapshots_symlinked` before any side
 * effect; a link swapped in after that check is the Host's responsibility.
 * A pending version 1 receipt (SDK 0.42) is `receipt_upgrade_required`:
 * recover it with SDK 0.42 first. A final one reads as version 2, and the
 * next write stores version 2.
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
   * stores or change earlier rollback snapshots; it journals a pending
   * `repair` receipt with the prior receipt, stops the service before it
   * rewrites the unit, and never replaces `current`.
   * A failed repair keeps the payload, `current` and the unit, writes the
   * prior receipt back and throws `install_health_check_failed`; an
   * interrupted one leaves recover() to write the prior receipt back and
   * throw `repair_interrupted`, after which install() runs again. An allowed unmarked unit
   * is untouched until preparation succeeds; its live store owner causes
   * `store_busy`. An owned marked unit without a current version is stopped
   * before preparation and started again after preparation fails, once
   * leases/gates are released and the version directory this call created
   * is removed (one it reused is kept: it holds the version already
   * staged). After a failed store
   * restore it is removed instead, and the next install writes it again.
   * OS credentials are never cleared. `precheck` is required.
   * The temporary snapshot `snapshots/.install-<uuid>` is removed after a
   * healthy start or a completed restore; a removal failure does not change
   * the outcome, and a leftover is kept, never restored automatically: the
   * next first install refuses with `install_snapshot_leftover`, listing it,
   * and starts nothing until an operator removes it. Every operation holds
   * the install-root gate (#2001), so no other installation changes
   * `current` or the snapshots meanwhile. A
   * failed restore renames it `snapshots/.install-repair-<uuid>` and the
   * error, `upgrade_pending`, names it: the next operation (recover()
   * included) restores it first, under the store leases, while no version
   * is current. When it cannot stop the service, take the leases, restore
   * or retire the repair name, or when more than one repair snapshot
   * exists, it fails with `upgrade_pending`, names the snapshots, starts
   * nothing and removes a marked unit.
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
   * as soon as possible; `current` is absent meanwhile, so no payload
   * starts on those stores. A failed health check journals
   * `health_check_failed` in the pending receipt before `current` is
   * removed, so a failed restore after it is `upgrade_pending` too and
   * recover() finishes it (#1992). The unit must be the exact one this SDK
   * writes, or the call is `service_program_not_current` before anything
   * changes.
   */
  upgrade(payloadDir: string): Promise<ServiceUpgradeReceipt>;
  /**
   * Restores `previous` and the store snapshot taken when `current` was
   * switched to, under a `pending` receipt written first. Store writes since
   * that switch are discarded. It also resolves a `switch_unhealthy`
   * receipt. The unit must be the exact one this SDK writes, as on
   * upgrade(). A snapshot SDK 0.42 took is `snapshot_upgrade_required`
   * before anything changes; roll it back with SDK 0.42, or keep `current`.
   *
   * The top-level code follows the outcome (#2010). A call that wrote its
   * final receipt throws its first failure's own class and code; later
   * failures (a release, a restart) join its `cause`, one flat
   * `AggregateError` with the first failure first. A call that leaves its
   * work unfinished (the receipt stays `pending`: a failed stop, pointer
   * write, snapshot restore, release or final receipt write; or a repair
   * snapshot remains) throws `upgrade_pending`, whose `cause` lists every
   * failure in order; call recover() next. A lease that failed to release
   * stays held until its process exits, so restart the Host process first
   * when recover() fails with `store_busy` in its cause. An upgrade
   * refusal points `current` back at the previous version and starts it
   * before its `failed` receipt; when that write fails, recover() starts it
   * again idempotently and writes the receipt. A preparation error that is neither a
   * ServiceInstallationError nor a ServiceUnitError is
   * `store_preparation_failed`, with the original error as its cause.
   */
  rollback(): Promise<ServiceUpgradeReceipt>;
  /**
   * Resolves a `pending` receipt from its `kind`, code and where `current`
   * points (#2011). With `current` absent no payload ran since the
   * snapshot, so it restores the snapshot and starts `from`; with `current`
   * at `from` or `to` the stores belong to that version, which starts as it
   * is (idempotently). A candidate found unhealthy settles `failed`
   * `switch_unhealthy` with nothing started, stopped or restored: the Host
   * calls rollback() or keeps it. An interrupted same-version reinstall
   * writes the prior receipt back and throws `repair_interrupted`. A
   * receipt that no operation leaves for those pointers is
   * `receipt_state_inconsistent` and nothing changes. It does not check the
   * unit: a pending receipt is only written after upgrade() or rollback()
   * checked it. A final version 1 receipt is rewritten as version 2.
   * A snapshot SDK 0.42 took is `snapshot_upgrade_required` before
   * anything changes: finish or abandon that upgrade with SDK 0.42 first.
   * Before a restore changes any store, every snapshot entry is checked
   * (#2102, #2106): a `..` segment, two stores inside each other, or a path
   * that no longer resolves as it did at the snapshot is
   * `precheck_failed`; a store in the install root or a `service/` is
   * `store_overlaps_service_state`; each names the path. The call then
   * throws `upgrade_pending` with that refusal in its cause, and the
   * receipt, `current`, the snapshot and every store stay as they were.
   * Returns the receipt, or
   * `undefined` when there is none. Release
   * failures follow the same rule as on `rollback()`.
   */
  recover(): Promise<ServiceUpgradeReceipt | undefined>;
  /** Removes `current` first, so no payload starts even if the unit stays; uninstalls the service and removes `versions/`, the pointers, `snapshots/` and the receipt. Install snapshots (`snapshots/.install-*`) are kept, and so is `snapshots/` around them. A symlinked `snapshots/` is refused with `snapshots_symlinked` before anything changes. The store is not touched. */
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
  upgrade_pending: 'An earlier upgrade, rollback or install was interrupted or left its stores unrestored. Run recover() (CLI: byok-agent upgrade recover) first.',
  store_preparation_failed: 'Store preparation failed with an error of its own (the cause). Nothing was switched; the stores are as before.',
  store_busy: 'A daemon store still has a running owner after the stop. Stop every process that uses it and retry.',
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
  receipt_upgrade_required: 'Pending SDK 0.42 receipt: run recover() with SDK 0.42 first.',
  snapshot_upgrade_required: 'A snapshot SDK 0.42 took would be restored. Nothing was changed; with SDK 0.42, finish or abandon that upgrade (recover() or rollback()), then upgrade with this version.',
  receipt_state_inconsistent: 'The receipt does not match the version pointers. Nothing was changed.',
  switch_unhealthy: 'The new version stays current but is unhealthy. Call rollback(), or keep it.',
  repair_interrupted: 'A same-version reinstall was interrupted. Run install() again.',
  service_program_not_current: 'The service unit must be the one this SDK writes, running from <installRoot>/current. Reinstall the payload installed now (install() with the current version id) to rewrite the unit, then retry.',
  install_root_foreign_owner: 'The install root belongs to another user. Nothing was changed; run the operation as that user or choose an install root this user owns.',
  install_root_ancestor_unsafe: 'Another user could replace the install root. Nothing was changed; move it, or fix the owner or mode of',
  snapshots_symlinked: 'A path under the install root\'s snapshots/ is a symbolic link. Nothing changed; replace the link, then retry.',
  store_overlaps_service_state: 'A store overlaps the install root or a daemon store\'s service/ directory.',
} as const;

export type ServiceInstallationErrorCode = keyof typeof ERROR_MESSAGES;

/** Closed codes; a store refusal carries the precheck verdicts, and `snapshot_failed` the copy error as `cause`. */
export class ServiceInstallationError extends Error {
  constructor(readonly code: ServiceInstallationErrorCode, readonly stores?: readonly ServiceStoreVerdict[], options?: ErrorOptions) {
    super(ERROR_MESSAGES[code], options);
    this.name = 'ServiceInstallationError';
  }
}

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

/**
 * The failures of one operation, in the order they happened (#2010): the
 * first is the primary, and a later failure never replaces it. It is the one
 * cause shape every joined error carries, and the only AggregateError this
 * module spreads when it joins more failures; a Host callback's
 * AggregateError stays one item.
 */
class FailureList extends AggregateError {}

/** One error as the failures it stands for: a FailureList, or an error whose cause is one, is spread. */
function failureParts(error: unknown): unknown[] {
  if (error instanceof FailureList) return [...error.errors];
  if ((error instanceof ServiceInstallationError || error instanceof ServiceUnitError) && error.cause instanceof FailureList) return [...error.cause.errors];
  return [error];
}

/**
 * `error` with failures that came after it: the same class, code and
 * message, with every failure in one FailureList cause, the primary first.
 * An error that is not ours becomes the FailureList.
 */
function joinLater(error: unknown, later: readonly unknown[]): unknown {
  if (later.length === 0) return error;
  const all = [...failureParts(error), ...later.flatMap(failureParts)];
  if (error instanceof ServiceInstallationError) {
    const joined = new ServiceInstallationError(error.code, error.stores, { cause: new FailureList(all, error.message) });
    joined.message = error.message;
    return joined;
  }
  if (error instanceof ServiceUnitError) return new ServiceUnitError(error.code, { cause: new FailureList(all, error.message), exitConfirmed: error.exitConfirmed });
  return new FailureList(all, 'Service installation failed, and a later step failed too.');
}

/**
 * The error of an operation that left its work unfinished: the receipt stays
 * `pending`, or a repair snapshot remains. The next step is recover(), so the
 * code is `upgrade_pending`; `note` says what remains.
 */
function unfinishedFailure(errors: readonly unknown[], note: string): ServiceInstallationError {
  const error = new ServiceInstallationError('upgrade_pending', undefined, { cause: new FailureList(errors.flatMap(failureParts), note) });
  error.message = `${note} Run recover() (CLI: byok-agent upgrade recover); if it reports store_busy, restart the Host process first.`;
  return error;
}

/** The installation error for a refused store path, its message naming the path. */
function storePathError(refusal: StorePathRefusal): ServiceInstallationError {
  const error = new ServiceInstallationError(refusal.code);
  error.message += refusal.detail;
  return error;
}

const RELEASE_NOTE = 'The store gates or leases could not be released.';
const STOP_NOTE = 'The service could not be stopped and its stores leased.';

/** A migrate group that outlived its root (#2011): nothing is restored or started, and the record stays. */
class MigrateRunning extends Error {}

const migrateNote = (pgid: number): string => `Migrate process group ${pgid} may still run; nothing restored or started. Run recover() after it ends.`;

/**
 * POSIX: whether process group `pgid` ends within `timeoutMs`. Only ESRCH
 * proves it; any other answer is asked again (darwin answers EPERM while the
 * group's last process exits).
 */
async function groupGone(pgid: number, timeoutMs = 5000): Promise<boolean> {
  for (const until = Date.now() + timeoutMs; Date.now() < until; await delay(50)) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
    }
  }
  return false;
}

/** A preparation exit is typed (#2010): an error that is not ours becomes `store_preparation_failed`. */
function preparationError(error: unknown): unknown {
  return error instanceof ServiceInstallationError || error instanceof ServiceUnitError
    ? error
    : new ServiceInstallationError('store_preparation_failed', undefined, { cause: error });
}

/** The failures of a preparation exit, the primary typed. */
function typedParts(error: unknown): unknown[] {
  const [primary, ...later] = failureParts(error);
  return [preparationError(primary), ...later];
}

/**
 * A failed store preparation, released. `errors` starts with the typed
 * primary; `unfinished` names what a failed restore kept, and then nothing
 * may start on the stores.
 */
class PreparationFailure extends Error {
  constructor(readonly errors: readonly unknown[], readonly unfinished?: string) {
    super('store preparation failed');
  }
}

/** A receipt as stored: a pending one also keeps what recover() needs. */
interface StoredReceipt extends ServiceUpgradeReceipt {
  /** The migrate program's process group while it may run (#2011). */
  migrate?: OwnedProcessGroupRecord;
  /** A pending repair: the final receipt it replaced, written back when it settles. */
  prior?: ServiceUpgradeReceipt;
}

/** What a pending receipt journals: everything recover() needs, with `kind` set. */
type Journal = Omit<StoredReceipt, 'format' | 'version' | 'at' | 'state' | 'kind'> & { kind: NonNullable<StoredReceipt['kind']> };

const PENDING_KINDS: ReadonlySet<unknown> = new Set(['upgrade', 'rollback', 'repair']);
/** Codes a restored `from` settles as `rolled-back`; a refusal's code settles as `failed`. */
const ROLLED_BACK_CODES: ReadonlySet<ServiceInstallationErrorCode> = new Set(['health_check_failed', 'upgrade_pending']);

/**
 * recover()'s whole decision (#2011): a pending receipt's `kind`, its code
 * (none, `health_check_failed`, or a refusal's) and where `current` points
 * (absent, `from`, `to`, another version) select one action. A cell no
 * operation leaves is missing here and is `receipt_state_inconsistent`.
 *
 * - `restore`: `current` is absent, so no payload ran since the snapshot:
 *   restore it when complete, put back `previous`, point `current` at
 *   `from`, start it and settle.
 * - `from` / `to`: `current` is present, so the stores belong to it: start
 *   it as it is (idempotently) and settle.
 * - `unhealthy`: the candidate was found unhealthy and may have run since:
 *   nothing starts, stops or is restored; `switch_unhealthy`.
 * - `repair`: an interrupted same-version reinstall: its prior receipt is
 *   written back and `repair_interrupted` thrown; nothing starts.
 */
const RECOVER: Readonly<Record<string, 'restore' | 'from' | 'to' | 'unhealthy' | 'repair'>> = {
  'upgrade none absent': 'restore', 'upgrade none from': 'from', 'upgrade none to': 'to',
  'upgrade refusal absent': 'restore', 'upgrade refusal from': 'from',
  'upgrade health absent': 'restore', 'upgrade health from': 'from', 'upgrade health to': 'unhealthy',
  'rollback none absent': 'restore', 'rollback none from': 'from', 'rollback none to': 'to',
  'repair none absent': 'repair', 'repair none from': 'repair',
};

async function readUpgradeReceipt(installRoot: string): Promise<StoredReceipt | undefined> {
  return (await readStoredReceipt(installRoot))?.receipt;
}

/**
 * Reads the receipt (#2011). A pending version 1 receipt is
 * `receipt_upgrade_required`; a final one has the same fields and meaning in
 * version 2 and reads as one, and the next write stores version 2.
 */
async function readStoredReceipt(installRoot: string): Promise<{ receipt: StoredReceipt; v1: boolean } | undefined> {
  const receiptPath = path.join(installRoot, 'upgrade-receipt.json');
  let text: string;
  try {
    text = await fs.readFile(receiptPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const receipt = JSON.parse(text) as Omit<Partial<StoredReceipt>, 'version'> & { version?: unknown };
  if (receipt.format === 'byok-service-upgrade-receipt' && receipt.version === 1) {
    // A v1 pending receipt is restored only by the SDK that wrote it.
    if (receipt.state === 'pending') throw new ServiceInstallationError('receipt_upgrade_required');
    return { receipt: { ...receipt, version: 2 } as StoredReceipt, v1: true };
  }
  if (receipt.format !== 'byok-service-upgrade-receipt' || receipt.version !== 2 || (receipt.state === 'pending' && !PENDING_KINDS.has(receipt.kind))) {
    throw new Error(`${receiptPath} is not a version 2 upgrade receipt`);
  }
  return { receipt: receipt as StoredReceipt, v1: false };
}

/**
 * @internal The running version and the last receipt of an install root,
 * read from disk only: no service definition, unit or service manager is
 * involved, so a status read needs none of their inputs (WinSW paths).
 */
export async function readServiceInstallationState(installRoot: string): Promise<{ current: string | undefined; receipt: ServiceUpgradeReceipt | undefined; receiptError?: 'receipt_upgrade_required' }> {
  const root = path.resolve(installRoot);
  const current = await readInstallPointer(root, 'current');
  try {
    return { current, receipt: await readUpgradeReceipt(root) };
  } catch (error) {
    // A version 1 receipt is reported, never read or rewritten here (#2011).
    if (error instanceof ServiceInstallationError && error.code === 'receipt_upgrade_required') return { current, receipt: undefined, receiptError: error.code };
    throw error;
  }
}

export function createServiceInstallation(opts: ServiceInstallationOptions): ServiceInstallation {
  const current = path.join(path.resolve(opts.installRoot), 'current');
  const program = opts.program(current);
  if (!runsFromCurrent(program, current, opts.lifecycle?.platform ?? process.platform)) throw new ServiceInstallationError('service_program_not_current');
  return serviceInstallationOver(opts, createManagedServiceLifecycle({ ...opts.service, program }, opts.lifecycle));
}

/**
 * Whether the command or an argument lies under `current` (#2011). A
 * plausibility check only, without resolving links: the factory is
 * synchronous, and a program that names the path but runs something else
 * is the Host's responsibility.
 */
function runsFromCurrent(program: ServiceProgram, current: string, platform: NodeJS.Platform): boolean {
  return [program.command, ...program.args].some((value) => within(path.resolve(value), current, platform));
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

  /**
   * Runs one operation inside `owned()` holding the `install-root` gate for
   * `root` (#2001). The gate always uses the default gate root, never the
   * lifecycle's `gateRoot`, so installations under different gate roots that
   * share an install root still exclude each other. A held gate is
   * `lifecycle_owner_busy`. On POSIX the root's lookup is checked first
   * (#2028): an install root another user could rename or replace, through
   * any directory or link {@link resolveTrusted} reads, is
   * `install_root_ancestor_unsafe` before anything is created. Then the root
   * is created, so the gate and the owner check act on an existing
   * directory: the gate resolves its real path, one spelling for every alias
   * (a symlink, or another letter case on a case-insensitive volume), and
   * whoever creates a missing root owns it. The gate is per effective uid,
   * so a root another user owns is `install_root_foreign_owner` before
   * anything is written under it. A group-writable directory is accepted: its group is trusted (macOS
   * `/Applications` is root:admin 775). Windows has neither check: who can
   * rename an entry there follows ACLs (FILE_DELETE_CHILD on the parent,
   * DELETE on the entry, inheritance), which have no sticky-bit equivalent
   * and are not read; keep the root in a directory only this user can
   * change, such as one under %LOCALAPPDATA%.
   */
  function rootOwned<T>(operation: (held: HeldServiceLifecycle) => Promise<T>): Promise<T> {
    return lifecycle.owned(async (held) => {
      let gate: PathMutationGate;
      await prepareInstallRoot();
      try {
        gate = await acquirePathMutationGate({ scope: 'install-root', targetPath: root }, { waitMs: 0 });
      } catch (error) {
        if (error instanceof PathMutationGateBusyError) throw new ServiceUnitError('lifecycle_owner_busy', { cause: error });
        throw error;
      }
      let result: T;
      try {
        await assertOwnInstallRoot();
        // Every operation reads or writes snapshots/: a link would lead it outside the root.
        await refuseLinkedSnapshots();
        await restoreRepairs(held);
        result = await operation(held);
      } catch (error) {
        const failures: unknown[] = [];
        await gate.release().catch((releaseError: unknown) => { failures.push(releaseError); });
        throw joinLater(error, failures);
      }
      await gate.release();
      return result;
    });
  }

  /**
   * Checks the install root's lookup with {@link resolveTrusted} before
   * anything is created (#2028), then creates each missing directory alone,
   * never recursively, and checks again, so an existing one (EEXIST
   * included) is never taken for one this call made. Windows has no such
   * check (see {@link rootOwned}).
   */
  async function prepareInstallRoot(): Promise<void> {
    const euid = process.geteuid?.();
    if (euid === undefined) {
      await fs.mkdir(root, { recursive: true });
      return;
    }
    for (;;) {
      const walked = await resolveTrusted(root, euid);
      if ('untrusted' in walked) {
        const error = new ServiceInstallationError('install_root_ancestor_unsafe');
        error.message = `${error.message} ${walked.untrusted} (${walked.reason}).`;
        throw error;
      }
      if (walked.missing === undefined) return;
      await fs.mkdir(walked.missing).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    }
  }

  async function assertOwnInstallRoot(): Promise<void> {
    const euid = process.geteuid?.();
    if (euid === undefined) return;
    if ((await fs.stat(root)).uid !== euid) {
      const error = new ServiceInstallationError('install_root_foreign_owner');
      error.message = `${error.message} (${root})`;
      throw error;
    }
  }

  async function currentVersion(): Promise<string | undefined> {
    return readPointer('current');
  }

  function readPointer(name: InstallPointer): Promise<string | undefined> {
    return readInstallPointer(root, name);
  }

  /**
   * Points `name` at `versions/<id>`. POSIX renames a fresh symlink over the
   * old one, which is atomic. Windows uses a directory junction, which a
   * rename cannot replace: the old one moves aside first. Both run only while
   * the service is stopped, and a pending receipt makes `recover()` set every
   * pointer again, so the window with no `current` is never observed by a run.
   */
  async function setPointer(name: InstallPointer, id: string | undefined): Promise<void> {
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

  function readReceipt(): Promise<StoredReceipt | undefined> {
    return readUpgradeReceipt(root);
  }

  function writePending(journal: Journal): Promise<ServiceUpgradeReceipt> {
    return writeReceipt({ state: 'pending', ...journal });
  }

  /** Puts back the final receipt a repair journaled, or removes the receipt when there was none. */
  async function writeBack(prior: ServiceUpgradeReceipt | undefined): Promise<void> {
    if (prior === undefined) await fs.rm(receiptPath, { force: true });
    else await writeFileAtomic(receiptPath, `${JSON.stringify(prior, null, 2)}\n`);
  }

  /** upgrade() and rollback() rely on `current` gating every start, so the unit must be the one this SDK writes (#2011). */
  async function requireExactUnit(): Promise<void> {
    if ((await lifecycle.inspect()).state !== 'exact') throw new ServiceInstallationError('service_program_not_current');
  }

  /** Only `recover()` may act while a receipt is `pending`. */
  async function refusePending(): Promise<void> {
    if ((await readReceipt())?.state === 'pending') throw new ServiceInstallationError('upgrade_pending');
  }

  async function writeReceipt(fields: Omit<StoredReceipt, 'format' | 'version' | 'at'>): Promise<ServiceUpgradeReceipt> {
    const receipt: StoredReceipt = { format: 'byok-service-upgrade-receipt', version: 2, ...fields, at: new Date().toISOString() };
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
    return rootOwned(async (held) => {
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
      // Repair snapshots were restored first (rootOwned). Any other install
      // snapshot may hold the only copy of the stores, and nothing tells
      // whether it is still needed: refuse before stopping or staging.
      const leftovers = installed === undefined ? await listInstallSnapshots() : [];
      if (leftovers.length > 0) {
        const error = new ServiceInstallationError('install_snapshot_leftover');
        error.message = `${error.message} ${leftovers.map((name) => path.join(snapshotsDir, name)).join(', ')}`;
        throw error;
      }
      const { id, created } = await stage(payloadDir, payload);
      // A same-version reinstall (repair) touches no store, no payload byte and not
      // `current`: stage() only verifies `versions/<id>`, and the unit files are
      // replaced by rename. Its pending receipt keeps the final receipt it replaces,
      // put back when it settles, so the receipt records only upgrades (#2011).
      // A failed repair keeps all of that: there is no earlier state to restore.
      const prior = installed === undefined ? undefined : await readReceipt();
      if (installed !== undefined) {
        await writePending({ kind: 'repair', from: id, to: id, ...(prior === undefined ? {} : { prior }) });
        // A unit rewrite interrupted part way must not run (#2011): stop first, start once it is whole.
        await lifecycle.stop();
      }
      // An install snapshot must not replace a same-id reinstall's earlier
      // upgrade snapshot, which still belongs to its previous version.
      const snapshotId = `${INSTALL_SNAPSHOT_PREFIX}${randomUUID()}`;
      const stopMarked = inspection.state === 'exact' || inspection.state === 'repairable';
      let prepared: Awaited<ReturnType<typeof prepareStores>> | undefined;
      if (installed === undefined) {
        try {
          prepared = await prepareStores(id, snapshotId, true, stopMarked);
        } catch (error) {
          if (!(error instanceof PreparationFailure)) throw error;
          // Preparation released its leases. Remove staging before
          // restarting an owned marked unit, as upgrade does on refusal.
          // Only a directory this call created is removed: a same-id
          // directory it reused belongs to the version already staged.
          const later: unknown[] = [];
          if (created) await fs.rm(path.join(versionsDir, id), { recursive: true, force: true }).catch((cleanup: unknown) => { later.push(cleanup); });
          if (error.unfinished === undefined) {
            if (stopMarked) await lifecycle.start().catch((restart: unknown) => { later.push(restart); });
            const [primary, ...rest] = error.errors;
            throw joinLater(primary, [...rest, ...later]);
          }
          // A failed restore may have left partial stores. The unit stays
          // stopped, and our marked unit is removed, as after a failed health
          // check: a boot or login must not start it on those stores. The
          // next operation restores the repair snapshot first.
          let note = error.unfinished;
          if (stopMarked) await held.uninstall().catch((removal: unknown) => { later.push(removal); note = `${note} The marked service unit could not be removed: ${inspection.unitPath}.`; });
          throw unfinishedFailure([...error.errors, ...later], note);
        }
      }
      let storesHeld = prepared !== undefined;
      let activationAttempted = false;
      let health: Awaited<ReturnType<typeof startHealthy>>;
      try {
        if (installed === undefined) await setPointer('current', id);
        await writeRecord();
        if (prepared !== undefined) {
          // A failed release cannot prove the stores are still all held.
          storesHeld = false;
          const released = await prepared.release();
          if (released.length > 0) throw new FailureList(released, RELEASE_NOTE);
        }
        activationAttempted = true;
        await held.install(installOpts);
        health = await startHealthy();
      } catch (cause) {
        health = { ok: false, cause };
      }
      if (installed !== undefined) {
        await writeBack(prior);
        if (health.ok) return;
        throw new ServiceInstallationError('install_health_check_failed', undefined, { cause: health.cause });
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
      let releaseRestored: (() => Promise<unknown[]>) | undefined;
      let leasesReleased = false;
      let repairKept: string | undefined;
      const removals = [
        { name: 'service unit and launcher', remove: async () => {
          // A first install that failed before activation has not touched
          // the allowed foreign unit. Never try to uninstall that unit.
          if (activationAttempted || stopMarked) await held.uninstall();
        } },
        { name: 'current pointer', remove: () => setPointer('current', undefined) },
        { name: 'installation record', remove: () => fs.rm(serviceInstallationRecordPath(storeDir), { force: true }) },
        { name: 'staged version directory', remove: () => fs.rm(path.join(versionsDir, id), { recursive: true, force: true }) },
        ...(prepared === undefined ? [] : [{ name: 'prepared store snapshot restoration', remove: async () => {
          const release = storesHeld ? prepared.release : await stopQuiescent(false);
          storesHeld = false;
          const failed = await restoreInstallSnapshot(snapshotId);
          if (failed !== undefined) {
            repairKept = failed.kept;
            const released = await release();
            leasesReleased = released.length === 0;
            throw new FailureList([...failed.errors, ...released], `The prepared stores could not be restored; the snapshot is retained at ${failed.kept}.`);
          }
          releaseRestored = release;
        } }, { name: 'store lease release', remove: async () => {
          const released = await releaseRestored!();
          if (released.length > 0) throw new FailureList(released, RELEASE_NOTE);
        } },
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
          if (storesHeld && prepared !== undefined) later.push(...await prepared.release());
          // Every failure that stops this loop keeps the install snapshot: name it.
          const snapshotPath = path.join(snapshotsDir, snapshotId);
          const kept = repairKept !== undefined
            ? ` The prepared stores could not be restored; the snapshot is retained at ${repairKept}.`
            : prepared === undefined ? ''
              : releaseRestored === undefined ? ` The install snapshot is retained at ${snapshotPath}.`
                // Restored stores: the snapshot is an ordinary leftover the next install refuses until it is removed.
                : ` The stores were restored; remove the install snapshot at ${snapshotPath} before the next install.`;
          const message = `The service failed to install, activate or pass its health check; removal failed. Remaining: ${removals.slice(index).filter((item) => !(leasesReleased && item.name === 'store lease release')).map((item) => item.name).join(', ')}.${kept}`;
          // Partial stores and a repair snapshot: unfinished until the next operation restores it.
          if (repairKept !== undefined) throw unfinishedFailure([health.cause, ...later], message);
          const error = new ServiceInstallationError('install_health_check_failed', undefined, { cause: new FailureList([health.cause, ...later], message) });
          error.message = message;
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
    const stores: ServiceDaemonStore[] = [];
    for (const store of listed as Partial<ServiceDaemonStore>[]) {
      if (typeof store?.storeDir !== 'string' || !path.isAbsolute(store.storeDir) || typeof store.productId !== 'string' || store.productId === '') {
        throw new ServiceInstallationError('daemon_stores_invalid');
      }
      // One store is one canonical path, the identity a snapshot restore uses too.
      const identity = await canonical(store.storeDir);
      if (typeof identity !== 'string' || seen.has(identity)) throw new ServiceInstallationError('daemon_stores_invalid');
      seen.add(identity);
      stores.push({ storeDir: path.resolve(store.storeDir), productId: store.productId });
    }
    return stores;
  }

  /**
   * Stops the service and takes an `installer` owner lease on every daemon
   * store before one shared deadline: a lease proves the store's last owner
   * is gone and reclaims what a crashed one left, including a `control.token`
   * whose endpoint no longer answers. Then it holds every store gate (taken
   * after the service gate, the documented order, and sorted) and ends
   * whatever the stopped runs left in their owned-process ledgers. The
   * returned release frees every gate, then every lease (a lease's own
   * release takes its store gate), and resolves to every release failure.
   * A failure here is thrown with the release failures joined to it.
   */
  /** The `service/` directories (leases, launcher, records) of the daemon stores the last stop quiesced; the precheck that follows reads them. */
  let serviceDirs: string[] = [];

  async function stopQuiescent(stopService = true): Promise<() => Promise<unknown[]>> {
    if (stopService) await lifecycle.stop();
    const deadline = Date.now() + (opts.stopTimeoutMs ?? 30_000);
    const leases: DaemonOwnerLease[] = [];
    let gates: readonly PathMutationGate[] = [];
    const release = async (): Promise<unknown[]> => {
      const failures: unknown[] = [];
      for (const gate of gates) await gate.release().catch((error: unknown) => { failures.push(error); });
      for (const lease of leases) await lease.release().catch((error: unknown) => { failures.push(error); });
      return failures;
    };
    try {
      const stores = await readDaemonStores();
      serviceDirs = stores.map((store) => path.join(store.storeDir, 'service'));
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
      // The stop's own error decides the outcome; release failures join it.
      const failure = error instanceof OwnedProcessResidueError ? new ServiceInstallationError('owned_process_residue') : error;
      throw joinLater(failure, await release());
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
      // Platform commands are outside the health-check deadline and have
      // their own bounds (#1971). Await start before checking health or
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
    if (!Array.isArray(stores) || !stores.every(isServiceStoreVerdict)) throw new ServiceInstallationError('precheck_failed');
    const checked = await checkStorePaths(stores.map((store) => store.path), [root, ...serviceDirs], platform);
    if ('refusal' in checked) throw storePathError(checked.refusal);
    if (stores.some(isRefused) !== (code === 2)) throw new ServiceInstallationError('precheck_failed');
    return stores.map((store) => store.kind === 'directory' ? { ...store, path: directoryStorePath(store.path, platform) } : store);
  }

  /** One candidate store preparation sequence for install and upgrade, retaining the quiescent leases until the caller switches. */
  async function prepareStores(candidate: string, snapshotId: string, installing = false, stopService = !installing, journal?: Journal): Promise<{ stores: ServiceStoreVerdict[]; release: () => Promise<unknown[]> }> {
    // A first install stops only a marked unit of our owner. Absent and
    // allowed-unmarked units rely on the store lease alone.
    let release: () => Promise<unknown[]>;
    try {
      release = await stopQuiescent(stopService);
    } catch (error) {
      throw new PreparationFailure(typedParts(error));
    }
    let restoreOnFailure = false;
    try {
      // An upgrade removes `current` before the snapshot: from here no unit starts a payload (#2011).
      if (journal !== undefined) await setPointer('current', undefined);
      let stores = await precheck(candidate);
      const refused = stores.find(isRefused);
      if (refused !== undefined) {
        throw new ServiceInstallationError(refused.verdict === 'new-path-repair' ? 'store_repair_required' : 'store_rejected', stores);
      }
      await snapshot(snapshotId, stores);
      if (stores.some((store) => store.verdict === 'migration-required')) {
        restoreOnFailure = opts.migrate !== undefined;
        stores = await migrateStores(candidate, stores, journal);
      }
      return { stores, release };
    } catch (error) {
      const errors = typedParts(error);
      let unfinished: string | undefined;
      if (error instanceof MigrateRunning) unfinished = error.message;
      else if (restoreOnFailure) {
        const failed = installing ? await restoreInstallSnapshot(snapshotId) : await restoreSnapshot(snapshotId).then(() => undefined, (restoreError: unknown) => ({ errors: [restoreError], kept: path.join(snapshotsDir, snapshotId) }));
        if (failed !== undefined) {
          errors.push(...failed.errors);
          unfinished = `Store preparation failed and its stores could not be restored; the snapshot is retained at ${failed.kept}. Nothing was restarted.`;
        }
      }
      // A leftover is kept and never restored; its removal error must not replace the store code.
      if (installing && unfinished === undefined) await fs.rm(path.join(snapshotsDir, snapshotId), { recursive: true, force: true }).catch(() => undefined);
      errors.push(...await release());
      throw new PreparationFailure(errors, unfinished);
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
  async function migrateStores(to: string, stores: readonly ServiceStoreVerdict[], journal?: Journal): Promise<ServiceStoreVerdict[]> {
    if (opts.migrate === undefined) throw new ServiceInstallationError('store_migration_required', stores);
    let code: number | null;
    let migrated: ServiceStoreVerdict[];
    try {
      code = await runMigrate(opts.migrate(path.join(versionsDir, to)), journal);
      if (code !== 0) throw new ServiceInstallationError('store_migration_failed', stores);
      migrated = await precheck(to);
    } catch (error) {
      if (error instanceof MigrateRunning || (error instanceof ServiceInstallationError && error.code === 'store_migration_failed')) throw error;
      throw new ServiceInstallationError('store_migration_failed', stores, { cause: error });
    }
    if (!migrated.every((store) => store.verdict === 'accepted' || store.verdict === 'absent')) {
      throw new ServiceInstallationError('store_migration_failed', migrated);
    }
    return migrated;
  }

  /**
   * Runs `migrate` and resolves to its exit code (`null` when it cannot
   * start). Under an upgrade's journal (#2011) it is recorded in the pending
   * receipt (written and synced) before the wait: on POSIX the process group
   * it leads, on win32 its pid and start time. When the root exits while its
   * group still runs, nothing may restore or start on the stores, so this
   * throws {@link MigrateRunning} and the record stays. Not covered, the
   * Host's responsibility: the moment between spawn and the synced record, a
   * process that leaves the group (setsid, a daemon), and on win32 what the
   * root started.
   */
  async function runMigrate(program: ServiceProgram, journal?: Journal): Promise<number | null> {
    const tracked = journal !== undefined;
    const child = spawn(program.command, program.args, { cwd: program.cwd, stdio: 'ignore', detached: tracked && platform !== 'win32', windowsHide: true });
    const exit = new Promise<number | null>((resolve) => {
      child.once('error', () => resolve(null));
      child.once('exit', (code) => resolve(code));
    });
    let migrate: OwnedProcessGroupRecord | undefined;
    if (tracked && child.pid !== undefined) {
      try {
        migrate = ownedProcessGroupRecord(child, 'migrate', undefined, platform);
        if (migrate !== undefined) await writePending({ ...journal, migrate });
      } catch (error) {
        // Nothing unrecorded may outlive this call, and nothing restores until
        // the whole group is gone (#2011). win32 ends only the root.
        if (platform === 'win32') child.kill('SIGKILL');
        else {
          const pgid = child.pid;
          const signal = (name: NodeJS.Signals): void => {
            try {
              process.kill(-pgid, name);
            } catch {
              // The group already ended.
            }
          };
          signal('SIGTERM');
          if (!(await groupGone(pgid, 1000))) signal('SIGKILL');
          if (!(await groupGone(pgid))) throw new MigrateRunning(migrateNote(pgid));
        }
        await exit;
        throw error;
      }
    }
    const code = await exit;
    if (migrate !== undefined && ownedProcessGroupRuns(migrate, platform)) throw new MigrateRunning(migrateNote(migrate.pgid));
    return code;
  }

  /**
   * Copies every listed store to `snapshots/<to>`: a file store's files as
   * `<index><suffix>`, a directory store's tree as `<index>.d`. Every store
   * is checked with `lstat` first, so nothing is followed through a symlink.
   * `snapshot.json` is written last and marks a complete snapshot; a copy
   * that fails removes the partial snapshot. Each entry keeps the listed
   * path and its canonical form (#2106), in `snapshot.json` format 2: a
   * restore refuses a listed path that no longer resolves to that place,
   * and writes to the canonical path.
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
        const recorded = await canonical(store.path);
        if (typeof recorded !== 'string') throw storePathError(recorded);
        entries.push({ store: store.store, path: store.path, canonical: recorded, ...(store.kind === 'directory' ? { kind: 'directory' as const } : {}), files });
      }
      await writeFileAtomic(path.join(dir, 'snapshot.json'), `${JSON.stringify({ format: SNAPSHOT_FORMAT, entries }, null, 2)}\n`);
    } catch (error) {
      // The cleanup is best effort: the receipt must say snapshot_failed, with the copy error as its cause.
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw new ServiceInstallationError('snapshot_failed', undefined, { cause: error });
    }
  }

  /**
   * Checks every entry ({@link checkRestoreTargets}) before any store
   * changes, then restores each at the canonical path it recorded (#2106),
   * creating a missing parent as real directories.
   */
  async function restoreSnapshot(to: string): Promise<void> {
    const dir = path.join(snapshotsDir, to);
    const { entries } = await readSnapshot(to);
    const refusal = await checkRestoreTargets(entries, [root, ...serviceDirs], platform);
    if (refusal !== undefined) throw storePathError(refusal);
    for (const entry of entries) {
      const target = entry.canonical;
      const refused = await mkdirReal(path.dirname(target));
      if (refused !== undefined) throw storePathError(refused);
      if (entry.kind === 'directory') {
        await fs.rm(target, { recursive: true, force: true });
        if (entry.files[''] !== undefined) await fs.cp(path.join(dir, entry.files['']), target, TREE_COPY);
        continue;
      }
      for (const suffix of [...STORE_FILE_SUFFIXES, '-shm']) await fs.rm(`${target}${suffix}`, { force: true });
      for (const [suffix, name] of Object.entries(entry.files)) await fs.copyFile(path.join(dir, name), `${target}${suffix}`);
    }
  }

  /**
   * Restores a first install's snapshot. When the restore fails, one rename
   * marks the snapshot for repair and the result names where it is kept,
   * with every failure in order. When that rename fails too, the snapshot
   * keeps its ordinary name, which nothing restores automatically.
   */
  async function restoreInstallSnapshot(snapshotId: string): Promise<{ errors: unknown[]; kept: string } | undefined> {
    try {
      await restoreSnapshot(snapshotId);
      return undefined;
    } catch (error) {
      const kept = path.join(snapshotsDir, snapshotId);
      const repair = path.join(snapshotsDir, `${REPAIR_SNAPSHOT_PREFIX}${snapshotId.slice(INSTALL_SNAPSHOT_PREFIX.length)}`);
      try {
        await fs.rename(kept, repair);
        return { errors: [error], kept: repair };
      } catch (renameError) {
        return { errors: [error, renameError], kept: `${kept}, which recover() does not restore: restore or remove it by hand` };
      }
    }
  }

  /**
   * A symbolic link at `file` (`snapshots/` by default) is
   * `snapshots_symlinked` (#2061): each level a restore reads is checked
   * before anything under it is read or changed. A cheap fail-closed check:
   * a link swapped in after it is checked is the Host's responsibility,
   * like any other write to the install root during an operation.
   */
  async function refuseLinkedSnapshots(file = snapshotsDir): Promise<void> {
    const stat = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (stat?.isSymbolicLink()) {
      const error = new ServiceInstallationError('snapshots_symlinked');
      error.message = `${error.message} (${file})`;
      throw error;
    }
  }

  /**
   * The one reader of `snapshots/<name>/snapshot.json`. A record
   * {@link parseSnapshotRecord} refuses, such as one SDK 0.42 wrote, or one
   * naming a copy that is not in the snapshot, is `snapshot_upgrade_required` naming the snapshot, as a
   * version 1 pending receipt is `receipt_upgrade_required`: this version
   * cannot restore it safely.
   */
  async function readSnapshot(name: string): Promise<SnapshotRecord> {
    const dir = path.join(snapshotsDir, name);
    const record = parseSnapshotRecord(await fs.readFile(path.join(dir, 'snapshot.json'), 'utf8'));
    const copies = record === undefined ? [] : record.entries.flatMap((entry) => Object.values(entry.files));
    if (record !== undefined && (await Promise.all(copies.map((name) => exists(path.join(dir, name))))).every(Boolean)) return record;
    const error = new ServiceInstallationError('snapshot_upgrade_required');
    error.message = `${error.message} (${dir})`;
    throw error;
  }

  /** Checks `snapshots/<name>` and every copy in it a restore reads, and reads its record, before the operation's first side effect. */
  async function refuseLinkedSnapshot(name: string): Promise<void> {
    const dir = path.join(snapshotsDir, name);
    const index = path.join(dir, 'snapshot.json');
    await refuseLinkedSnapshots(dir);
    await refuseLinkedSnapshots(index);
    if (!(await exists(index))) return;
    const { entries } = await readSnapshot(name);
    for (const entry of entries) {
      for (const file of Object.values(entry.files)) {
        let at = dir;
        for (const part of file.split(/[\\/]/u)) await refuseLinkedSnapshots(at = path.join(at, part));
      }
    }
  }

  async function listInstallSnapshots(): Promise<string[]> {
    return (await listDir(snapshotsDir)).filter((entry) => entry.startsWith(INSTALL_SNAPSHOT_PREFIX));
  }

  /**
   * Run first by every operation, recover() included, holding the
   * install-root gate (#2010). Only an operation that holds it writes
   * snapshots/, so the list cannot change meanwhile. When an earlier first
   * install could not restore its stores, restores them from its repair
   * snapshot, as they were before that install, and retires it with one
   * rename. A repair snapshot is restored only with no current version
   * (one beside `current` is not its stores' last copy and stays). When the
   * service cannot be stopped, the leases cannot be taken, the restore or the
   * rename fails, or more than one repair snapshot exists (a uuid does not
   * order them in time, so an operator chooses), nothing starts, a marked
   * unit is removed, and the error is `upgrade_pending` naming the snapshots.
   */
  async function restoreRepairs(held: HeldServiceLifecycle): Promise<void> {
    if ((await currentVersion()) !== undefined) return;
    const repairs = (await listInstallSnapshots()).filter((name) => name.startsWith(REPAIR_SNAPSHOT_PREFIX));
    if (repairs.length === 0) return;
    const kept = repairs.map((name) => path.join(snapshotsDir, name)).join(', ');
    for (const name of repairs) await refuseLinkedSnapshot(name);
    let inspection: Awaited<ReturnType<typeof lifecycle.inspect>> | undefined;
    let note = `The stores of an earlier failed install were not restored; the snapshot is retained at ${kept}.`;
    try {
      inspection = await lifecycle.inspect();
      const stopMarked = inspection.state === 'exact' || inspection.state === 'repairable';
      if (repairs.length > 1) {
        note = `More than one install repair snapshot exists; nothing was restored. Keep the one to restore and remove the others: ${kept}.`;
        throw new Error('more than one repair snapshot');
      }
      const release = await stopQuiescent(stopMarked);
      try {
        await restoreSnapshot(repairs[0]!);
      } catch (error) {
        throw joinLater(error, await release());
      }
      // While the repair name stays, a later operation would restore it over
      // what a restarted service wrote, so a failed rename starts nothing.
      const done = path.join(snapshotsDir, `${INSTALL_SNAPSHOT_PREFIX}${randomUUID()}`);
      try {
        await fs.rename(path.join(snapshotsDir, repairs[0]!), done);
      } catch (error) {
        note = `The stores of an earlier failed install were restored, but its repair snapshot could not be retired; it is retained at ${kept} and is restored again first.`;
        throw joinLater(error, await release());
      }
      // Restored and retired: the copy is no longer needed. A failed removal
      // leaves an ordinary install snapshot the next install refuses: report it.
      const failures: unknown[] = [];
      await fs.rm(done, { recursive: true, force: true }).catch((error: unknown) => { failures.push(error); });
      const removed = failures.length === 0;
      failures.push(...await release());
      if (failures.length > 0) {
        note = `The stores of an earlier failed install were restored${removed ? '' : `, but the retired snapshot could not be removed; remove ${done} before the next install`}${failures.length > (removed ? 0 : 1) ? ', and their gates or leases could not be released' : ''}.`;
        throw new FailureList(failures, note);
      }
    } catch (error) {
      const later: unknown[] = [];
      if (inspection?.state === 'exact' || inspection?.state === 'repairable') {
        const { unitPath } = inspection;
        await held.uninstall().catch((removal: unknown) => { later.push(removal); note = `${note} The marked service unit could not be removed: ${unitPath}.`; });
      }
      throw unfinishedFailure([error, ...later], note);
    }
  }

  /**
   * Starts the version `current` points at and writes the final receipt
   * (#2011): `to` is `switched`, or `failed` with `switch_unhealthy`; `from`
   * is `failed` with a refusal's code, `rolled-back` with any other code
   * (`fallback` when the journal has none), or `failed` with
   * `rollback_unhealthy`. Until the final write the pending receipt stays,
   * and recover() starts the same version again. Removing a restored
   * snapshot afterwards is best effort: the outcome is written (#2062).
   */
  async function settle(journal: Journal, running: string, prior: readonly unknown[], fallback?: ServiceInstallationErrorCode, started?: Awaited<ReturnType<typeof startHealthy>>): Promise<{ receipt: ServiceUpgradeReceipt; unhealthy?: unknown }> {
    const health = started ?? await startHealthy();
    const code = journal.code ?? fallback;
    const fields = { from: journal.from, to: journal.to, ...(journal.previous === undefined ? {} : { previous: journal.previous }), ...(journal.stores === undefined ? {} : { stores: journal.stores }) };
    const final: Omit<StoredReceipt, 'format' | 'version' | 'at'> = running === journal.to
      ? (health.ok ? { state: 'switched', ...fields } : { state: 'failed', ...fields, code: 'switch_unhealthy' })
      : !health.ok ? { state: 'failed', ...fields, code: 'rollback_unhealthy' }
        : { state: code === undefined || ROLLED_BACK_CODES.has(code) ? 'rolled-back' : 'failed', ...fields, ...(code === undefined ? {} : { code }) };
    let receipt: ServiceUpgradeReceipt;
    try {
      receipt = await writeReceipt(final);
    } catch (error) {
      throw unfinishedFailure([...prior, ...(health.ok ? [] : [health.cause]), error], 'The final receipt could not be written.');
    }
    if (receipt.state === 'switched') await prune(journal.to, journal.from);
    else if (running === journal.from) await fs.rm(path.join(snapshotsDir, journal.to), { recursive: true, force: true }).catch(() => undefined);
    return health.ok ? { receipt } : { receipt, unhealthy: health.cause };
  }

  /**
   * With the service stopped, the stores leased and `current` absent,
   * restores the snapshot taken for `to` when it is complete, puts back
   * `previous`, then points `current` at `from` and settles. Any failure
   * before `current` is written leaves it absent, so nothing starts on
   * partial stores (#1992).
   */
  async function restoreFrom(journal: Journal, release: () => Promise<unknown[]>, prior: readonly unknown[], fallback?: ServiceInstallationErrorCode): Promise<{ receipt: ServiceUpgradeReceipt; unhealthy?: unknown }> {
    try {
      if (await exists(path.join(snapshotsDir, journal.to, 'snapshot.json'))) await restoreSnapshot(journal.to);
      await setPointer('previous', journal.previous);
      await setPointer('current', journal.from);
    } catch (error) {
      throw unfinishedFailure([...prior, error, ...await release()], `The stores or version pointers could not be restored; the snapshot is retained at ${path.join(snapshotsDir, journal.to)}.`);
    }
    const released = await release();
    if (released.length > 0) throw unfinishedFailure([...prior, ...released], RELEASE_NOTE);
    return settle(journal, journal.from, prior, fallback);
  }

  /**
   * Discards what `journal.to` wrote: stops it, leases the stores, journals
   * the rollback, removes `current`, then restores `from`. A rollback that
   * fails before its journal is written changed nothing but the stop.
   */
  async function rollBack(journal: Journal, prior: readonly unknown[]): Promise<{ receipt: ServiceUpgradeReceipt; unhealthy?: unknown }> {
    let release: () => Promise<unknown[]>;
    try {
      release = await stopQuiescent();
    } catch (error) {
      throw prior.length === 0 ? error : unfinishedFailure([...prior, error], STOP_NOTE);
    }
    let journaled = prior.length > 0;
    try {
      await writePending(journal);
      journaled = true;
      await setPointer('current', undefined);
    } catch (error) {
      const later = await release();
      throw journaled ? unfinishedFailure([...prior, error, ...later], 'The rollback could not begin.') : joinLater(error, later);
    }
    return restoreFrom(journal, release, prior);
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
    return rootOwned(async () => {
      await refusePending();
      const from = await currentVersion();
      if (from === undefined) throw new ServiceInstallationError('installation_absent');
      await requireExactUnit();
      const { id: to } = await stage(payloadDir, await readPayload(payloadDir));
      if (to === from) throw new ServiceInstallationError('version_current');
      const previous = await readPointer('previous');
      const journal: Journal = { kind: 'upgrade', from, to, ...(previous === undefined ? {} : { previous }) };

      // A failed attempt after its snapshot leaves snapshots/<to>. Remove it
      // before the intent: recover() restores any snapshot it finds for `to`.
      await refuseLinkedSnapshots(path.join(snapshotsDir, to));
      await fs.rm(path.join(snapshotsDir, to), { recursive: true, force: true });
      // Write-ahead: the service may be stopped and `current` removed from here on.
      await writePending(journal);
      let stores: ServiceStoreVerdict[];
      let release: () => Promise<unknown[]>;
      try {
        ({ stores, release } = await prepareStores(to, to, false, true, journal));
      } catch (error) {
        if (!(error instanceof PreparationFailure)) throw error;
        const [primary, ...later] = error.errors;
        // Partial stores, or a refusal without an installation code: `current` stays absent.
        if (error.unfinished !== undefined || !(primary instanceof ServiceInstallationError)) {
          throw unfinishedFailure(error.errors, error.unfinished ?? 'Store preparation failed; the previous version stays stopped.');
        }
        // The refusal's code is journaled before `current` is back, so recover() can finish it.
        const refused: Journal = { ...journal, code: primary.code, ...(primary.stores ? { stores: [...primary.stores] } : {}) };
        try {
          await writePending(refused);
          await setPointer('current', from);
        } catch (pointerError) {
          throw unfinishedFailure([...error.errors, pointerError], 'The previous version could not be made current again.');
        }
        const { unhealthy } = await settle(refused, from, error.errors);
        throw joinLater(primary, unhealthy === undefined ? later : [...later, unhealthy]);
      }

      // The commit point is `current` = `to`: the stores are journaled first, then `previous`.
      const committed: Journal = { ...journal, stores };
      try {
        await writePending(committed);
        await setPointer('previous', from);
        await setPointer('current', to);
      } catch (error) {
        throw unfinishedFailure([error, ...await release()], 'The version pointers could not be switched.');
      }
      const released = await release();
      if (released.length > 0) throw unfinishedFailure(released, RELEASE_NOTE);
      const health = await startHealthy();
      if (!health.ok) {
        // The final receipt is written: the first failure keeps its code, and the restored version's failed check joins it.
        const failure = new ServiceInstallationError('health_check_failed', undefined, { cause: health.cause });
        const { unhealthy } = await rollBack({ ...committed, code: 'health_check_failed' }, [failure]);
        throw joinLater(failure, unhealthy === undefined ? [] : [unhealthy]);
      }
      return (await settle(committed, to, [], undefined, health)).receipt;
    });
  }

  function rollback(): Promise<ServiceUpgradeReceipt> {
    return rootOwned(async () => {
      await refusePending();
      const [current, previous] = [await currentVersion(), await readPointer('previous')];
      if (current !== undefined) await refuseLinkedSnapshot(current);
      if (current === undefined || previous === undefined || !(await exists(path.join(snapshotsDir, current, 'snapshot.json')))) {
        throw new ServiceInstallationError('no_rollback');
      }
      await requireExactUnit();
      return (await rollBack({ kind: 'rollback', from: previous, to: current }, [])).receipt;
    });
  }

  /**
   * Resolves a pending receipt by {@link RECOVER}. A recorded migrate group
   * that still runs is left alone. A version 1 final receipt is rewritten
   * as version 2; a version 1 pending one is refused.
   */
  function recover(): Promise<ServiceUpgradeReceipt | undefined> {
    return rootOwned(async () => {
      const read = await readStoredReceipt(root);
      if (read === undefined) return undefined;
      const { receipt: last, v1 } = read;
      if (last.state !== 'pending') {
        if (v1) await writeFileAtomic(receiptPath, `${JSON.stringify(last, null, 2)}\n`);
        return last;
      }
      if (last.migrate !== undefined && ownedProcessGroupRuns(last.migrate, platform)) {
        throw unfinishedFailure([], migrateNote(last.migrate.pgid));
      }
      const current = await currentVersion();
      const at = current === undefined ? 'absent' : current === last.from ? 'from' : current === last.to ? 'to' : 'other';
      const codeClass = last.code === undefined ? 'none' : last.code === 'health_check_failed' ? 'health' : 'refusal';
      let action = RECOVER[`${last.kind} ${codeClass} ${at}`] ?? 'inconsistent';
      if (action === 'restore') {
        await refuseLinkedSnapshot(last.to);
        // A migration runs only after a complete snapshot.
        if (last.migrate !== undefined && !(await exists(path.join(snapshotsDir, last.to, 'snapshot.json')))) action = 'inconsistent';
      }
      const journal = last as Journal;
      switch (action) {
        case 'inconsistent':
          throw new ServiceInstallationError('receipt_state_inconsistent');
        case 'repair':
          // Clearing the pending receipt first lets the Host run the repair again.
          await writeBack(last.prior);
          throw new ServiceInstallationError('repair_interrupted');
        case 'unhealthy':
          // The candidate's writes are kept, and so is the snapshot rollback() restores: the Host decides.
          return writeReceipt({ state: 'failed', from: last.from, to: last.to, ...(last.previous === undefined ? {} : { previous: last.previous }), code: 'switch_unhealthy' });
        case 'restore': {
          let release: () => Promise<unknown[]>;
          try {
            release = await stopQuiescent();
          } catch (error) {
            throw unfinishedFailure([error], STOP_NOTE);
          }
          return (await restoreFrom(journal, release, [], 'upgrade_pending')).receipt;
        }
        default:
          return (await settle(journal, current!, [], 'upgrade_pending')).receipt;
      }
    });
  }

  function uninstall(): Promise<void> {
    return rootOwned(async (held) => {
      await refusePending();
      // Without `current` no unit starts a payload, even one this uninstall fails to remove (#2011).
      await setPointer('current', undefined);
      await held.uninstall();
      await setPointer('previous', undefined);
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

/** Whether two stores (at their canonical `paths`) share a path or one lies inside a directory store. */

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
      // On Windows the lease hardens the store root with icacls, whose timeout is public here (#1971).
      if (!(error instanceof DaemonOwnerActiveError) && !(error instanceof DaemonOwnerReclaimingError)) throwPublicCommandTimeout(error);
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
  const handle = await fs.open(temp, 'w');
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
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

