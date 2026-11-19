import { isDeepStrictEqual } from 'node:util';
import { inspectDaemonStoreLock } from '../util/daemon-owner.js';
import { resolvePathWithoutCreate } from '../util/path-mutation-gate.js';
import { queryLaunchdService, type LaunchdDeps } from './launchd.js';
import { sanitizeServiceName, type ServiceManagerQuery } from './service-types.js';
import { inspectServiceOwnerRecord, serviceLauncherPath, type ServiceRegistration } from './service-unit.js';
import { querySystemdService, systemdLocalUserUid, type SystemdDeps } from './systemd.js';
import { queryWindowsUserService } from './windows-user.js';
import { queryWinswService, type WinswDeps } from './winsw.js';

export interface StoreServiceState {
  readonly state: 'stopped' | 'running' | 'unknown';
  readonly owner?: { readonly owner: string; readonly service: string };
}

/**
 * Inspect the service recorded for an absolute store directory and the store's
 * live daemon lock. This is an observation only, with no reservation against a
 * subsequent service start.
 */
export function inspectStoreServiceState(storeDir: string): Promise<StoreServiceState> {
  return inspectStoreServiceStateWith(storeDir, process.platform);
}

/** @internal Inject the existing service-manager fakes without exposing them publicly. */
export async function inspectStoreServiceStateWith(
  storeDir: string,
  platform: NodeJS.Platform,
  deps: LaunchdDeps & SystemdDeps & WinswDeps = {},
): Promise<StoreServiceState> {
  const canonical = await resolvePathWithoutCreate(storeDir).catch(() => undefined);
  if (canonical === undefined) return { state: 'unknown' };

  const owner = await inspectServiceOwnerRecord(canonical).catch(() => undefined);
  const status = owner === undefined ? undefined : await queryRecordedService(canonical, owner.service, owner.registration, platform, deps).catch(() => undefined);
  const lock = await inspectDaemonStoreLock(canonical).catch(() => 'unknown');
  const identity = owner === undefined ? {} : { owner: { owner: owner.owner, service: owner.service } };
  if (status?.running || lock === 'held') return { state: 'running', ...identity };
  if (lock === 'free' && status?.determinate) {
    const confirmed = await inspectServiceOwnerRecord(canonical).catch(() => undefined);
    if (isDeepStrictEqual(owner, confirmed)) return { state: 'stopped', ...identity };
  }
  return { state: 'unknown', ...identity };
}

async function queryRecordedService(
  storeDir: string, service: string, registration: ServiceRegistration | undefined, platform: NodeJS.Platform,
  deps: LaunchdDeps & SystemdDeps & WinswDeps,
): Promise<Pick<ServiceManagerQuery, 'running' | 'determinate'> | undefined> {
  // Normalizing a corrupt name could redirect the query to a different service.
  if (sanitizeServiceName(service) !== service) return undefined;
  switch (platform) {
    case 'darwin': {
      if (registration?.manager === 'launchd') return queryLaunchdService(service, { ...deps, getuid: () => registration.uid });
      if (registration !== undefined) return undefined;
      // Old records did not identify the GUI domain. A live label gives
      // positive evidence, but its absence cannot confirm the store stopped.
      const current = await queryLaunchdService(service, deps);
      return { running: current.running, determinate: current.running };
    }
    case 'linux': {
      const current = await querySystemdService(service, deps);
      const local = registration?.manager === 'systemd' && systemdLocalUserUid(deps.getuid) === registration.uid;
      return { running: current.running, determinate: (local && current.determinate) || current.running };
    }
    case 'win32': {
      if (registration?.manager === 'winsw') return queryWinswService(service, deps);
      if (registration?.manager === 'windows-user') return queryWindowsUserService(registration.launcher, deps);
      if (registration !== undefined) return undefined;
      const results = await Promise.allSettled([
        queryWinswService(service, deps),
        queryWindowsUserService(serviceLauncherPath(storeDir, service, 'win32'), deps),
      ]);
      // A legacy user-scope install may have used a junction when constructing
      // the launcher command. Only a recorded scope and path establish a stop.
      const running = results.some(result => result.status === 'fulfilled' && result.value.running);
      return { running, determinate: running };
    }
    default: return undefined;
  }
}
