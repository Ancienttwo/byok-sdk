import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { inspectServiceLogs } from './service-log';
import {
  assertServiceOwner,
  claimHeldServiceLifecycleOwner,
  classifyServiceUnit,
  readServiceLifecycleOwner,
  releaseHeldServiceLifecycleOwner,
  ServiceUnitError,
  withServiceOwnerGate,
  type ServiceUnitFile,
  type ServiceUnitInspection,
} from './service-unit';
import type { ServiceDefinition, ServiceInstallOptions, ServiceLifecycle, ServiceStatusResult } from './service-types';

export type ManagedLifecycleFs = Pick<typeof fsp, 'mkdir' | 'writeFile' | 'readFile' | 'rm' | 'rename' | 'chmod'>;

/** The platform half of a lifecycle: where its files go and how its manager loads them. */
export interface PlatformUnit {
  serviceName: string;
  unitPath: string;
  launcherPath: string;
  /** The unit first, then the launcher, with their exact expected content. */
  files(): ServiceUnitFile[];
  /** Runs after the files are written: register with the manager and start. Throws if it does not end running. */
  activate(): Promise<void>;
  /** Stops and unregisters. Tolerates only a known "not loaded"; a real failure throws and the files stay. */
  deactivate(): Promise<void>;
  /** Removes every file `files()` lists, plus platform extras. Runs only after `deactivate()` succeeded. */
  removeFiles(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  query(): Promise<Pick<ServiceStatusResult, 'running' | 'determinate' | 'detail'>>;
  /** Extra preparation before the files are written (WinSW copies its executable). */
  prepare?(): Promise<void>;
  /** Whether what `prepare()` puts in place is already exact; asked only once `files()` classify exact. */
  preparedArtifactsExact?(): Promise<boolean>;
}

/** install and uninstall for an operation already inside `owned()`, which holds the owner gate they would take. */
export interface HeldServiceLifecycle {
  install(opts?: ServiceInstallOptions): Promise<void>;
  uninstall(): Promise<void>;
}

/** A lifecycle whose owner check other installation steps run behind (#1097). */
export interface ManagedServiceLifecycle extends ServiceLifecycle {
  /**
   * Runs `operation` inside the store's owner gate, after the same owner
   * check install, repair and uninstall make: another recorded owner throws
   * `lifecycle_owner_conflict` before `operation` writes anything.
   */
  owned<T>(operation: (held: HeldServiceLifecycle) => Promise<T>): Promise<T>;
}

/**
 * The install, repair, uninstall and status rules all three platforms share
 * (#1097): a `foreign` unit is never changed (`install` replaces it only
 * with `replaceUnmarked`), one lifecycle owner per product store, and the
 * unit and launcher are written whole on every install or repair. install,
 * repair and uninstall run whole inside the store's owner gate, so the owner
 * they checked is still the owner when they write, deactivate or release.
 */
export function createManagedLifecycle(def: ServiceDefinition, unit: PlatformUnit, fs: ManagedLifecycleFs = fsp): ManagedServiceLifecycle {
  assertServiceOwner(def.owner);
  const owner = def.owner;

  async function inspect(): Promise<ServiceUnitInspection> {
    const [files, record] = await Promise.all([classifyServiceUnit(fs, unit.files()), readServiceLifecycleOwner(def.storeDir, fs)]);
    const state = files === 'exact' && unit.preparedArtifactsExact && !(await unit.preparedArtifactsExact()) ? 'repairable' : files;
    return { state, unitPath: unit.unitPath, launcherPath: unit.launcherPath, ...(record ? { owner: record.owner } : {}) };
  }

  async function requireOwner(): Promise<void> {
    const record = await readServiceLifecycleOwner(def.storeDir, fs);
    if (record !== undefined && record.owner !== owner) throw new ServiceUnitError('lifecycle_owner_conflict');
  }

  async function writeFiles(): Promise<void> {
    await fs.mkdir(def.logDir, { recursive: true });
    await unit.prepare?.();
    for (const file of unit.files()) {
      await fs.mkdir(path.dirname(file.path), { recursive: true });
      await fs.writeFile(file.path, file.content, 'utf8');
      if (file.mode !== undefined) await fs.chmod(file.path, file.mode);
    }
  }

  async function heldInstall(opts: ServiceInstallOptions = {}): Promise<void> {
    const { state } = await inspect();
    if (state === 'foreign' && opts.replaceUnmarked !== true) throw new ServiceUnitError('service_unit_unmarked');
    await requireOwner();
    await claimHeldServiceLifecycleOwner({ storeDir: def.storeDir, owner, service: unit.serviceName }, fs);
    await writeFiles();
    await unit.activate();
  }

  async function heldUninstall(): Promise<void> {
    const { state } = await inspect();
    if (state === 'foreign') throw new ServiceUnitError('service_unit_unmarked');
    await requireOwner();
    await unit.deactivate();
    await unit.removeFiles();
    await releaseHeldServiceLifecycleOwner({ storeDir: def.storeDir, owner }, fs);
  }

  function owned<T>(operation: (held: HeldServiceLifecycle) => Promise<T>): Promise<T> {
    return withServiceOwnerGate(async () => {
      await requireOwner();
      return operation({ install: heldInstall, uninstall: heldUninstall });
    });
  }

  function repair() {
    return withServiceOwnerGate(async () => {
      const { state } = await inspect();
      if (state === 'foreign') throw new ServiceUnitError('service_unit_unmarked');
      if (state === 'exact' || state === 'absent') return { status: 'not-needed', state } as const;
      await requireOwner();
      await writeFiles();
      await unit.activate();
      return { status: 'repaired' } as const;
    });
  }

  async function start(): Promise<void> {
    const { state } = await inspect();
    if (state === 'absent') {
      throw new Error(`service "${unit.serviceName}" is not installed (no unit at ${unit.unitPath}) — call install() first`);
    }
    if (state === 'foreign') throw new ServiceUnitError('service_unit_unmarked');
    await unit.start();
  }

  async function stop(): Promise<void> {
    const { state } = await inspect();
    if (state === 'foreign') throw new ServiceUnitError('service_unit_unmarked');
    await unit.stop();
  }

  async function status(): Promise<ServiceStatusResult> {
    const [inspection, query, logs] = await Promise.all([inspect(), unit.query(), inspectServiceLogs(def.logDir)]);
    return { installed: inspection.state !== 'absent', ...query, unit: inspection, logs };
  }

  return {
    install: (opts) => withServiceOwnerGate(() => heldInstall(opts)),
    repair,
    uninstall: () => withServiceOwnerGate(heldUninstall),
    start,
    stop,
    status,
    inspect,
    owned,
  };
}
