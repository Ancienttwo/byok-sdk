import { type DaemonConfig, type RuntimeAdapter } from '../../index';
import { DeviceStore } from '../../daemon/store';
import type { ControlStatusResult } from '../../daemon/control-protocol';
import { auditLogPath, readAuditEvents } from '../audit-log';
import { connectControlClient } from '../control-client';
import { resolveStoreDir } from '../config';
import { formatLiveStatusLines, formatStatusLines, type StatusView } from '../format';
import { defaultRuntimeAdapters, probeRuntimes } from '../runtime-probe';
import { deriveTasksFromEvents, lastConnectionState, tallyTaskStates } from '../tasks-view';

export interface StatusDeps {
  log?: (line: string) => void;
  /** DI for tests: probe these adapters instead of constructing the real bundled pi/claude/codex set. */
  adapters?: RuntimeAdapter[];
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
 * uptime/transport/active-tasks are appended, clearly marked `live-`; if
 * not reachable, one line says so and the persisted view above stands on
 * its own, exactly as before this feature existed.
 */
export async function runStatusCommand(config: DaemonConfig, deps: StatusDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const storeDir = resolveStoreDir(config);
  const adapters = deps.adapters ?? defaultRuntimeAdapters(config.runtimeAllowlist);
  const connectControl = deps.connectControl ?? connectControlClient;

  const [record, events, runtimes] = await Promise.all([
    new DeviceStore(storeDir).load(),
    readAuditEvents(storeDir),
    probeRuntimes(adapters),
  ]);
  const tasks = deriveTasksFromEvents(events);

  const view: StatusView = {
    productName: config.productName,
    productId: config.productId,
    branding: config.branding,
    paired: record !== undefined,
    deviceId: record?.deviceId,
    connection: lastConnectionState(events),
    runtimes,
    taskCounts: tallyTaskStates(tasks),
    auditLogPath: auditLogPath(storeDir),
    auditLogLineCount: events.length,
  };
  for (const line of formatStatusLines(view)) log(line);

  const conn = await connectControl({ storeDir, productId: config.productId });
  if (!conn.ok) {
    log(`live status: daemon not reachable (${conn.reason})`);
    return;
  }
  try {
    const live = await conn.client.request<ControlStatusResult>('status');
    for (const line of formatLiveStatusLines(live)) log(line);
  } catch (err) {
    log(`live status unavailable: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    conn.client.close();
  }
}
