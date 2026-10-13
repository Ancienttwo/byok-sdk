import type { DaemonConfig } from '../../index';
import { DeviceStore } from '../../daemon/store';
import type { PeerControlStatusResult } from '../../daemon/control-protocol';
import { auditLogPath, readAuditEvents } from '../audit-log';
import { connectControlClient } from '../control-client';
import { resolveStoreDir } from '../config';
import { formatLiveStatusLines, formatStatusLines, type StatusView } from '../format';
import { deriveTasksFromEvents, lastEventOfKind, lastLifecycle, tallyTaskStates } from '../tasks-view';

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
 *
 * Issue #392: runtimes and the environment are what the DAEMON saw, never a
 * probe in this CLI's own environment (which is not the service's). Online,
 * the live section carries the daemon's startup detection outcomes and
 * environment source; offline, the persisted view shows the last
 * `environment-resolved` and `runtimes-detected` events. `byok-agent
 * runtimes` remains the explicit probe of the current shell.
 */
export async function runStatusCommand(config: DaemonConfig, deps: StatusDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const storeDir = resolveStoreDir(config);
  const connectControl = deps.connectControl ?? connectControlClient;

  const [record, events, live] = await Promise.all([
    new DeviceStore(storeDir).load(),
    readAuditEvents(storeDir),
    readLiveStatus(connectControl, storeDir, config.productId),
  ]);
  const tasks = deriveTasksFromEvents(events);

  const view: StatusView = {
    localAgentRelease: config.localAgentRelease,
    productName: config.productName,
    productId: config.productId,
    branding: config.branding,
    paired: record !== undefined,
    deviceId: record?.deviceId,
    lifecycle: lastLifecycle(events),
    taskCounts: tallyTaskStates(tasks),
    auditLogPath: auditLogPath(storeDir),
    auditLogLineCount: events.length,
    ...(live.kind === 'online'
      ? {}
      : {
          lastStart: {
            environment: lastEventOfKind(events, 'environment-resolved'),
            runtimesDetected: lastEventOfKind(events, 'runtimes-detected'),
          },
        }),
  };
  for (const line of formatStatusLines(view)) log(line);

  switch (live.kind) {
    case 'online':
      for (const line of formatLiveStatusLines(live.status)) log(line);
      return;
    case 'unreachable':
      log(`live status: daemon not reachable (${live.reason})`);
      return;
    case 'failed':
      log(`live status unavailable: ${live.reason}`);
      return;
  }
}

type LiveStatus =
  | { kind: 'online'; status: PeerControlStatusResult }
  | { kind: 'unreachable'; reason: string }
  | { kind: 'failed'; reason: string };

async function readLiveStatus(connectControl: typeof connectControlClient, storeDir: string, productId: string): Promise<LiveStatus> {
  const conn = await connectControl({ storeDir, productId });
  if (!conn.ok) return { kind: 'unreachable', reason: conn.reason };
  try {
    return { kind: 'online', status: await conn.client.request<PeerControlStatusResult>('status') };
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
  } finally {
    conn.client.close();
  }
}
