import { type DaemonConfig, type RuntimeAdapter } from '../../index';
import { DeviceStore } from '../../daemon/store';
import { auditLogPath, readAuditEvents } from '../audit-log';
import { resolveStoreDir } from '../config';
import { formatStatusLines, type StatusView } from '../format';
import { defaultRuntimeAdapters, probeRuntimes } from '../runtime-probe';
import { deriveTasksFromEvents, lastConnectionState, tallyTaskStates } from '../tasks-view';

export interface StatusDeps {
  log?: (line: string) => void;
  /** DI for tests: probe these adapters instead of constructing the real bundled pi/claude/codex set. */
  adapters?: RuntimeAdapter[];
}

/**
 * `paired`/`deviceId` are read straight off `DeviceStore` on disk (NOT via
 * a freshly-constructed `Daemon.status()`) — a `Daemon` this process just
 * constructed has never called `start()`/`pair()`, so its in-memory
 * `AuthManager` never loaded the on-disk record and would always report
 * `paired: false` even for a device that's genuinely paired. See
 * `byok-agent.ts`'s header comment for the full read-model rationale.
 */
export async function runStatusCommand(config: DaemonConfig, deps: StatusDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const storeDir = resolveStoreDir(config);
  const adapters = deps.adapters ?? defaultRuntimeAdapters(config.runtimeAllowlist);

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
}
