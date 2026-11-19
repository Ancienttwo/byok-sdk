import { inspectDaemonStoreLock } from '../util/daemon-owner.js';
import { resolvePathWithoutCreate } from '../util/path-mutation-gate.js';
import { queryLaunchdService, type LaunchdDeps } from './launchd.js';
import { sanitizeServiceName, type ServiceManagerQuery } from './service-types.js';
import { readServiceLifecycleOwner } from './service-unit.js';
import { querySystemdService, type SystemdDeps } from './systemd.js';
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

  const owner = await readServiceLifecycleOwner(canonical).catch(() => undefined);
  const status = owner === undefined ? undefined : await (async () => {
    // Use the recorded name verbatim. Normalizing a corrupt record could
    // redirect the query to an unrelated service.
    if (sanitizeServiceName(owner.service) !== owner.service) return undefined;
    return queryRecordedService(canonical, owner.service, platform, deps);
  })().catch(() => undefined);
  const confirmed = status !== undefined && status.determinate && !status.running
    ? await readServiceLifecycleOwner(canonical).catch(() => undefined)
    : undefined;
  const lock = await inspectDaemonStoreLock(canonical).catch(() => 'unknown');
  const identity = owner === undefined ? {} : { owner };
  if (status?.running || lock === 'held') return { state: 'running', ...identity };
  if (lock === 'free' && confirmed !== undefined && confirmed.owner === owner?.owner && confirmed.service === owner.service) {
    return { state: 'stopped', ...identity };
  }
  return { state: 'unknown', ...identity };
}

async function queryRecordedService(
  storeDir: string, service: string, platform: NodeJS.Platform, deps: LaunchdDeps & SystemdDeps & WinswDeps,
): Promise<Pick<ServiceManagerQuery, 'running' | 'determinate'> | undefined> {
  switch (platform) {
    case 'darwin': return queryLaunchdService(service, deps);
    case 'linux': return querySystemdService(service, deps);
    case 'win32': {
      // An existing owner record does not distinguish WinSW and Startup scope.
      const results = await Promise.allSettled([queryWinswService(service, deps), queryWindowsUserService(storeDir, service, deps)]);
      return {
        running: results.some(result => result.status === 'fulfilled' && result.value.running),
        determinate: results.every(result => result.status === 'fulfilled' && result.value.determinate),
      };
    }
    default: return undefined;
  }
}
