import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StoreCompatibility, StoreCompatibilityVerdict } from '@byok-sdk/core';
import { connectControlClient, isControlDaemonGone } from '../bin/control-client';
import type { ControlStatusResult } from '../daemon/control-protocol';
import { assertDaemonStoreQuiescent, DaemonOwnerActiveError } from '../daemon/daemon-owner';
import { OwnedProcessLedger, OwnedProcessResidueError } from '../daemon/owned-process-ledger';
import { acquirePathMutationGate, PathMutationGateBusyError, type PathMutationGate } from '../util/path-mutation-gate';
import { createManagedServiceLifecycle, type CreateServiceLifecycleOptions } from './create-service-lifecycle';
import type { ManagedServiceLifecycle } from './managed-lifecycle';
import { serviceStateDir } from './service-unit';
import type { ServiceDefinition, ServiceInstallOptions, ServiceLifecycle, ServiceProgram } from './service-types';

/** The manifest every payload directory carries at its root. */
export const SERVICE_PAYLOAD_MANIFEST = 'byok-payload.json';

/**
 * A payload's manifest (#1097). The Host verifies the payload's signature
 * before handing it to the SDK; the SDK checks every file against `files`
 * and accepts no file the manifest does not list.
 */
export interface ServicePayloadManifest {
  format: 'byok-service-payload';
  version: 1;
  /** The version id: 1-64 of `A-Z a-z 0-9 . _ -`, starting with a letter or digit. Becomes `versions/<id>`. */
  id: string;
  /** Every file of the payload except the manifest: `/`-separated relative path → lowercase hex SHA-256. */
  files: Record<string, string>;
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
   * every writer is stopped. It prints `{ "stores": StoreCompatibility[] }`
   * (what `byok-agent upgrade check --store --json` prints) and exits 0 or 2.
   * Every store the candidate rewrites must be listed: the snapshot covers
   * exactly the listed stores.
   */
  precheck(versionDir: string): ServiceProgram;
  /**
   * Resolves when the started version is healthy and throws when it is not.
   * Default: the daemon's control socket reports `lifecycle.phase` `running`
   * (connecting or open); `halted` or `crashed` fails at once.
   */
  healthCheck?(signal: AbortSignal): Promise<void>;
  /** How long the health check may take. Default 60000. */
  healthTimeoutMs?: number;
  /** How long a stop may take to leave the store quiescent. Default 30000. */
  stopTimeoutMs?: number;
  /** Test seams for the underlying lifecycle. */
  lifecycle?: CreateServiceLifecycleOptions;
}

/**
 * The upgrade receipt a Host UI reads (`upgrade-receipt.json`):
 *
 * - `pending`: an upgrade or a rollback began and has not been confirmed.
 *   Only `recover()` resolves it, by restoring `from` with the snapshot
 *   taken for `to`. A rollback journals its target as `from`, so recover
 *   completes it.
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
  stores?: StoreCompatibility[];
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
  /** Stages the payload as the first version, points `current` at it, installs and starts the service. */
  install(payloadDir: string, opts?: ServiceInstallOptions): Promise<void>;
  /**
   * Stages the payload, stops the service, runs the candidate's precheck,
   * snapshots the listed stores, switches `current` (the old one becomes
   * `previous`), starts it and checks its health. A store refusal stops
   * before the switch and restarts the old version; a failed health check
   * restores the old version and its snapshot together.
   */
  upgrade(payloadDir: string): Promise<ServiceUpgradeReceipt>;
  /**
   * Restores `previous` and the store snapshot taken when `current` was
   * switched to, under a `pending` receipt written first. Store writes since
   * that switch are discarded.
   */
  rollback(): Promise<ServiceUpgradeReceipt>;
  /** Resolves a `pending` receipt by restoring its `from` version and snapshot. Returns the receipt, or `undefined` when there is none. */
  recover(): Promise<ServiceUpgradeReceipt | undefined>;
  /** Uninstalls the service and removes `versions/`, the pointers, `snapshots/` and the receipt. The store is not touched. */
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
  store_busy: 'The store still has a running owner after the stop. Stop every process that uses this store and retry.',
  owned_process_residue: 'Processes from the previous daemon run survived; resolve them before upgrading.',
  precheck_failed: 'The candidate\'s store precheck did not produce a verdict.',
  store_repair_required: 'The candidate needs a new store path and a new pairing. Nothing was switched; decide before upgrading.',
  store_rejected: 'The candidate refuses a store. Nothing was switched; resolve the store first.',
  health_check_failed: 'The new version failed its health check; the previous version and its store snapshot were restored.',
  rollback_unhealthy: 'The previous version was restored but failed its health check too.',
  no_rollback: 'There is no previous version with a store snapshot to roll back to.',
} as const;

export type ServiceInstallationErrorCode = keyof typeof ERROR_MESSAGES;

/** Closed codes; a store refusal carries the precheck verdicts. */
export class ServiceInstallationError extends Error {
  constructor(readonly code: ServiceInstallationErrorCode, readonly stores?: readonly StoreCompatibility[]) {
    super(ERROR_MESSAGES[code]);
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

const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const POINTERS = ['current', 'previous'] as const;
type Pointer = (typeof POINTERS)[number];
/** A SQLite store is its main file plus a WAL or a hot rollback journal; `-shm` is rebuilt and is removed on restore. */
const STORE_FILE_SUFFIXES = ['', '-wal', '-journal'] as const;
const VERDICTS: ReadonlySet<StoreCompatibilityVerdict> = new Set(['accepted', 'new-path-repair', 'rejected', 'absent']);

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

/**
 * @internal The installation over a given lifecycle; tests drive it with a
 * fake service manager. Every mutation runs inside `lifecycle.owned()`, so
 * another recorded lifecycle owner is refused before anything is written.
 */
export function serviceInstallationOver(opts: ServiceInstallationOptions, lifecycle: ManagedServiceLifecycle): ServiceInstallation {
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
  async function stage(payloadDir: string): Promise<string> {
    const manifest = await readPayloadManifest(payloadDir);
    const target = path.join(versionsDir, manifest.id);
    if (await exists(target)) {
      if (!(await matchesManifest(target, manifest))) throw new ServiceInstallationError('version_conflict');
      return manifest.id;
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
      await fs.copyFile(path.join(payloadDir, SERVICE_PAYLOAD_MANIFEST), path.join(staging, SERVICE_PAYLOAD_MANIFEST));
      await fs.rename(staging, target);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
    return manifest.id;
  }

  async function writeRecord(): Promise<void> {
    const record: ServiceInstallationRecord = { format: 'byok-service-installation', version: 1, installRoot: root };
    await fs.mkdir(path.dirname(serviceInstallationRecordPath(storeDir)), { recursive: true });
    await writeFileAtomic(serviceInstallationRecordPath(storeDir), `${JSON.stringify(record, null, 2)}\n`);
  }

  /** Running it again with the installed payload rewrites the unit and launcher, as `lifecycle.install` does. */
  function install(payloadDir: string, installOpts: ServiceInstallOptions = {}): Promise<void> {
    return lifecycle.owned(async (held) => {
      await refusePending();
      const installed = await currentVersion();
      const id = await stage(payloadDir);
      if (installed !== undefined && installed !== id) throw new ServiceInstallationError('installation_exists');
      await setPointer('current', id);
      await writeRecord();
      await held.install(installOpts);
    });
  }

  /**
   * Stops the service and waits until no daemon owns the store, then holds
   * the store gate (taken after the service gate, the documented order) and
   * ends whatever the stopped run left in the owned-process ledger.
   */
  async function stopQuiescent(): Promise<PathMutationGate> {
    await lifecycle.stop();
    const deadline = Date.now() + (opts.stopTimeoutMs ?? 30_000);
    for (;;) {
      try {
        if (await isControlDaemonGone(storeDir, opts.productId)) {
          await assertDaemonStoreQuiescent(storeDir);
          break;
        }
      } catch (error) {
        if (!(error instanceof DaemonOwnerActiveError)) throw error;
      }
      if (Date.now() >= deadline) throw new ServiceInstallationError('store_busy');
      await delay(100);
    }
    let gate: PathMutationGate;
    try {
      gate = await acquirePathMutationGate({ scope: 'store', targetPath: storeDir }, { waitMs: 5_000 });
    } catch (error) {
      if (error instanceof PathMutationGateBusyError) throw new ServiceInstallationError('store_busy');
      throw error;
    }
    try {
      await assertDaemonStoreQuiescent(storeDir);
      await new OwnedProcessLedger(storeDir).reconcile();
    } catch (error) {
      await gate.release();
      if (error instanceof DaemonOwnerActiveError) throw new ServiceInstallationError('store_busy');
      if (error instanceof OwnedProcessResidueError) throw new ServiceInstallationError('owned_process_residue');
      throw error;
    }
    return gate;
  }

  /** Starts the installed `current` and reports whether it became healthy in time. A start the manager refuses is unhealthy. */
  async function startHealthy(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), opts.healthTimeoutMs ?? 60_000);
    try {
      await lifecycle.start();
      await (opts.healthCheck ?? defaultHealthCheck)(controller.signal);
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function defaultHealthCheck(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const phase = await daemonPhase();
      if (phase === 'running') return;
      if (phase === 'halted' || phase === 'crashed') throw new Error(`the daemon is ${phase}`);
      await delay(250);
    }
    throw new Error('the daemon did not report running in time');
  }

  /** The live daemon's lifecycle phase, or `undefined` while its control socket does not answer. */
  async function daemonPhase(): Promise<ControlStatusResult['lifecycle']['phase'] | undefined> {
    const connection = await connectControlClient({ storeDir, productId: opts.productId });
    if (!connection.ok) return undefined;
    try {
      return (await connection.client.request<ControlStatusResult>('status')).lifecycle.phase;
    } catch {
      return undefined;
    } finally {
      connection.client.close();
    }
  }

  /** Runs the staged candidate's precheck and returns its verdicts. */
  async function precheck(id: string): Promise<StoreCompatibility[]> {
    const program = opts.precheck(path.join(versionsDir, id));
    const { code, stdout } = await runProgram(program);
    if (code !== 0 && code !== 2) throw new ServiceInstallationError('precheck_failed');
    let stores: unknown;
    try {
      stores = (JSON.parse(stdout) as { stores?: unknown }).stores;
    } catch {
      throw new ServiceInstallationError('precheck_failed');
    }
    if (!Array.isArray(stores) || !stores.every(isStoreCompatibility)) throw new ServiceInstallationError('precheck_failed');
    if (stores.some((store) => store.verdict !== 'accepted' && store.verdict !== 'absent') !== (code === 2)) throw new ServiceInstallationError('precheck_failed');
    return stores;
  }

  /** Copies every listed store's files to `snapshots/<to>`. `snapshot.json` is written last and marks a complete snapshot. */
  async function snapshot(to: string, stores: readonly StoreCompatibility[]): Promise<void> {
    const dir = path.join(snapshotsDir, to);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    const entries: SnapshotEntry[] = [];
    for (const [index, store] of stores.entries()) {
      const files: Record<string, string> = {};
      for (const suffix of STORE_FILE_SUFFIXES) {
        const source = `${store.path}${suffix}`;
        if (!(await exists(source))) continue;
        const name = `${index}${suffix}`;
        await fs.copyFile(source, path.join(dir, name));
        files[suffix] = name;
      }
      entries.push({ store: store.store, path: store.path, files });
    }
    await writeFileAtomic(path.join(dir, 'snapshot.json'), `${JSON.stringify({ entries }, null, 2)}\n`);
  }

  async function restoreSnapshot(to: string): Promise<void> {
    const dir = path.join(snapshotsDir, to);
    const { entries } = JSON.parse(await fs.readFile(path.join(dir, 'snapshot.json'), 'utf8')) as { entries: SnapshotEntry[] };
    for (const entry of entries) {
      for (const suffix of [...STORE_FILE_SUFFIXES, '-shm']) await fs.rm(`${entry.path}${suffix}`, { force: true });
      for (const [suffix, name] of Object.entries(entry.files)) await fs.copyFile(path.join(dir, name), `${entry.path}${suffix}`);
    }
  }

  /**
   * Brings `from` back under a `pending` receipt: stops whatever runs,
   * restores the snapshot taken for `to`, points `current` at `from` and
   * `previous` at `previous`, then starts `from` and checks its health. The
   * snapshot is removed only after the final receipt is written, so until
   * then `recover()` can run every step again from what is on disk.
   */
  async function restore(from: string, to: string, previous: string | undefined, code?: ServiceInstallationErrorCode): Promise<ServiceUpgradeReceipt> {
    const gate = await stopQuiescent();
    try {
      await restoreSnapshot(to);
      await setPointer('current', from);
      await setPointer('previous', previous);
    } finally {
      await gate.release();
    }
    const kept = previous === undefined ? {} : { previous };
    const receipt = (await startHealthy())
      ? await writeReceipt({ state: 'rolled-back', from, to, ...kept, ...(code === undefined ? {} : { code }) })
      : await writeReceipt({ state: 'failed', from, to, ...kept, code: 'rollback_unhealthy' });
    await fs.rm(path.join(snapshotsDir, to), { recursive: true, force: true });
    return receipt;
  }

  /** Keeps `current` and `previous` and the snapshot of the last switch; removes every other version and snapshot. */
  async function prune(current: string, previous: string): Promise<void> {
    for (const name of await listDir(versionsDir)) {
      if (name !== current && name !== previous) await fs.rm(path.join(versionsDir, name), { recursive: true, force: true });
    }
    for (const name of await listDir(snapshotsDir)) {
      if (name !== current) await fs.rm(path.join(snapshotsDir, name), { recursive: true, force: true });
    }
  }

  function upgrade(payloadDir: string): Promise<ServiceUpgradeReceipt> {
    return lifecycle.owned(async () => {
      await refusePending();
      const from = await currentVersion();
      if (from === undefined) throw new ServiceInstallationError('installation_absent');
      const to = await stage(payloadDir);
      if (to === from) throw new ServiceInstallationError('version_current');
      const previous = await readPointer('previous');
      const kept = previous === undefined ? {} : { previous };

      // Until the pending receipt is written nothing has changed: any failure restarts `from`.
      let stores: StoreCompatibility[];
      try {
        const gate = await stopQuiescent();
        try {
          stores = await precheck(to);
          const refused = stores.find((store) => store.verdict === 'new-path-repair' || store.verdict === 'rejected');
          if (refused !== undefined) {
            throw new ServiceInstallationError(refused.verdict === 'new-path-repair' ? 'store_repair_required' : 'store_rejected', stores);
          }
          await snapshot(to, stores);
          await writeReceipt({ state: 'pending', from, to, ...kept, stores });
        } finally {
          await gate.release();
        }
      } catch (error) {
        if (error instanceof ServiceInstallationError) {
          await writeReceipt({ state: 'failed', from, to, code: error.code, ...(error.stores ? { stores: [...error.stores] } : {}) });
        }
        await lifecycle.start();
        throw error;
      }

      // From here a crash leaves the pending receipt, which recover() resolves.
      const gate = await acquirePathMutationGate({ scope: 'store', targetPath: storeDir }, { waitMs: 5_000 });
      try {
        await setPointer('previous', from);
        await setPointer('current', to);
      } finally {
        await gate.release();
      }
      if (!(await startHealthy())) {
        const receipt = await restore(from, to, previous, 'health_check_failed');
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
      await held.uninstall();
      for (const name of POINTERS) await setPointer(name, undefined);
      await fs.rm(versionsDir, { recursive: true, force: true });
      await fs.rm(snapshotsDir, { recursive: true, force: true });
      await fs.rm(receiptPath, { force: true });
      await fs.rm(serviceInstallationRecordPath(storeDir), { force: true });
    });
  }

  return { lifecycle, install, upgrade, rollback, recover, uninstall, receipt: readReceipt, currentVersion };
}

interface SnapshotEntry {
  store: StoreCompatibility['store'];
  path: string;
  /** Saved files by suffix (`''`, `-wal`, `-journal`); empty when the store was absent. */
  files: Record<string, string>;
}

export async function readPayloadManifest(payloadDir: string): Promise<ServicePayloadManifest> {
  let manifest: Partial<ServicePayloadManifest>;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(payloadDir, SERVICE_PAYLOAD_MANIFEST), 'utf8')) as Partial<ServicePayloadManifest>;
  } catch {
    throw new ServiceInstallationError('payload_invalid');
  }
  const files = manifest.files;
  const valid = manifest.format === 'byok-service-payload' && manifest.version === 1
    && typeof manifest.id === 'string' && VERSION_ID.test(manifest.id)
    && typeof files === 'object' && files !== null && Object.keys(files).length > 0
    && Object.entries(files).every(([relative, digest]) => isPayloadPath(relative) && typeof digest === 'string' && SHA256_HEX.test(digest));
  if (!valid) throw new ServiceInstallationError('payload_invalid');
  const listed = new Set(Object.keys(files!));
  for (const relative of await listFiles(payloadDir)) {
    if (relative !== SERVICE_PAYLOAD_MANIFEST && !listed.has(relative)) throw new ServiceInstallationError('payload_invalid');
  }
  return manifest as ServicePayloadManifest;
}

function isPayloadPath(relative: string): boolean {
  return relative !== SERVICE_PAYLOAD_MANIFEST && relative.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes('\\'));
}

async function matchesManifest(dir: string, manifest: ServicePayloadManifest): Promise<boolean> {
  const files = await listFiles(dir);
  if (files.length !== Object.keys(manifest.files).length + 1) return false;
  for (const [relative, digest] of Object.entries(manifest.files)) {
    const file = path.join(dir, ...relative.split('/'));
    if (!(await exists(file)) || (await sha256File(file)) !== digest) return false;
  }
  return true;
}

/** Every regular file under `dir`, `/`-separated and relative. A symlink or other entry fails the payload. */
async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await listFiles(path.join(dir, entry.name), relative));
    else if (entry.isFile()) result.push(relative);
    else throw new ServiceInstallationError('payload_invalid');
  }
  return result;
}

function isStoreCompatibility(value: unknown): value is StoreCompatibility {
  if (typeof value !== 'object' || value === null) return false;
  const store = value as Record<string, unknown>;
  return typeof store.store === 'string' && typeof store.path === 'string' && path.isAbsolute(store.path)
    && typeof store.reason === 'string' && VERDICTS.has(store.verdict as StoreCompatibilityVerdict);
}

function runProgram(program: ServiceProgram): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve) => {
    execFile(program.command, program.args, { cwd: program.cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : null;
      resolve({ code, stdout });
    });
  });
}

async function sha256File(file: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

