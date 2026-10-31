import { type DaemonConfig } from '../../index';
import { DeviceStore } from '../../daemon/store';
import { createDeviceCredentialStore } from '../../daemon/device-credential-provider';
import type { ControlStatusResult } from '../../daemon/control-protocol';
import { auditLogPath, readAuditRecords, readLastEnvironmentRecord, parseEnvironmentRecord } from '../../daemon/audit-log';
import { attachRuntimeVersionChanges, attachRuntimeVersionVerdicts, parseRuntimeObservations } from '../../runtime-detection';
import { connectControlClient } from '../../daemon/control-client';
import { resolveStoreDir } from '../config';
import { serviceLogDir } from '../../daemon/host-layout';
import { inspectServiceLogs } from '../../lifecycle/service-log';
import { formatLiveStatusLines, formatStatusLines, type StatusView } from '../../diagnostics/format';
import { deriveTasksFromRecords, lastLifecycle, tallyTaskStates } from '../../diagnostics/tasks-view';

export interface StatusDeps {
  log?: (line: string) => void;
  /** DI for tests: substitute the real control-socket connection attempt. */
  connectControl?: typeof connectControlClient;
}

/**
 * `paired`/`deviceId` are read straight off `DeviceStore` on disk (NOT via
 * a freshly-constructed `Daemon.status()`) — a `Daemon` this process just
 * constructed has never called `start()`/`pair()`, so its in-memory
 * `AuthManager` never loaded the on-disk record and would always report
 * `paired: false` even for a device that's genuinely paired. See
 * `byok-agent.ts`'s header comment for the full read-model rationale.
 *
 * M4 Phase 2: after the persisted-state view above, this ALSO tries the
 * control socket (see `control-client.ts`) — if a `byok-agent start` (or
 * the installed service) is actually running right now, its live pid/
 * uptime/lifecycle/active-tasks are appended, clearly marked `live-`; if
 * not reachable, one line says so and the persisted view above stands on
 * its own, exactly as before this feature existed.
 */
export async function runStatusCommand(config: DaemonConfig, deps: StatusDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const storeDir = resolveStoreDir(config);
  const connectControl = deps.connectControl ?? connectControlClient;

  const [record, records, environment, logs] = await Promise.all([
    new DeviceStore(storeDir, createDeviceCredentialStore({ productId: config.productId, storeDir, deviceCredentials: config.deviceCredentials })).load(),
    readAuditRecords(storeDir),
    readLastEnvironmentRecord(storeDir),
    inspectServiceLogs(serviceLogDir(storeDir)),
  ]);
  const tasks = deriveTasksFromRecords(records);
  const lastRuntimes = records.findLast(event => event.kind === 'runtimes-detected');

  const view: StatusView = {
    localAgentRelease: config.localAgentRelease,
    productName: config.productName,
    productId: config.productId,
    branding: config.branding,
    paired: record !== undefined,
    deviceId: record?.deviceId,
    lifecycle: lastLifecycle(records),
    runtimes: lastRuntimes?.kind === 'runtimes-detected' ? lastRuntimes.runtimes : [],
    ...(lastRuntimes === undefined ? {} : { runtimesDetectedAt: lastRuntimes.ts }),
    taskCounts: tallyTaskStates(tasks),
    auditLogPath: auditLogPath(storeDir),
    auditLogRecordCount: records.length,
    ...(environment ? { environment } : {}),
  };
  for (const line of formatStatusLines(view)) log(line);
  // #1097: where the daemon log and the service manager's redirect files are, and how large.
  log(`logs: ${logs.dir} ${logs.status} totalBytes=${logs.totalBytes}`);

  const conn = await connectControl({ storeDir, productId: config.productId });
  if (!conn.ok) {
    log(`live status: daemon not reachable (${conn.reason})`);
    return;
  }
  try {
    const live = await conn.client.request<ControlStatusResult>('status');
    const environment = parseEnvironmentRecord({ kind: 'environment-resolved', ts: live.environmentResolvedAt, ...live.environment });
    const observed = parseRuntimeObservations(live.runtimes);
    const runtimes = observed === undefined
      ? undefined
      : attachRuntimeVersionChanges(attachRuntimeVersionVerdicts(observed, live.runtimeVersionVerdicts), live.runtimeVersionChanges);
    for (const line of formatLiveStatusLines({ ...live, runtimes, environment: environment?.status })) log(line);
  } catch (err) {
    log(`live status unavailable: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    conn.client.close();
  }
}
