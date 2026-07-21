import { type DaemonConfig, type DaemonEvent } from '../../index';
import { auditLogPath, followAuditLog, readAuditEvents } from '../audit-log';
import { connectControlClient } from '../control-client';
import { resolveStoreDir } from '../config';
import { formatDaemonEventLine, formatTaskListLines } from '../format';
import { deriveTasksFromEvents } from '../tasks-view';

export interface TasksListDeps {
  log?: (line: string) => void;
}

/** `byok-agent tasks` (no `--follow`): current known tasks, reconstructed from the audit log — see `byok-agent.ts`'s header comment. */
export async function runTasksListCommand(config: DaemonConfig, deps: TasksListDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const storeDir = resolveStoreDir(config);
  const events = await readAuditEvents(storeDir);
  const tasks = deriveTasksFromEvents(events);
  for (const line of formatTaskListLines(tasks)) log(line);
}

export interface TasksFollowDeps {
  log?: (line: string) => void;
  /** Required — see `commands/start.ts`'s identical `StartDeps.signal` doc comment for why there's no sane default. */
  signal: AbortSignal;
  pollIntervalMs?: number;
  /** DI for tests: substitute the real control-socket connection attempt. */
  connectControl?: typeof connectControlClient;
}

/**
 * `byok-agent tasks --follow`: M4 Phase 2 — prefers a LIVE stream over the
 * control socket's `tasks.subscribe` method (see `control-client.ts`),
 * which taps the exact same `DaemonObserver` events `start`'s own stdout
 * already shows, full fidelity, as they happen. Falls back to tailing the
 * SAME `audit.jsonl` a running `start` appends to (like `tail -f`, not a
 * full replay — run plain `byok-agent tasks` first for history) whenever
 * the control socket isn't reachable (daemon not running, or an older
 * daemon build with no control socket at all) — see `byok-agent.ts`'s
 * header comment for the historical rationale this fallback preserves.
 */
export async function runTasksFollowCommand(config: DaemonConfig, deps: TasksFollowDeps): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const storeDir = resolveStoreDir(config);
  const connectControl = deps.connectControl ?? connectControlClient;

  const conn = await connectControl({ storeDir, productId: config.productId });
  if (conn.ok) {
    await new Promise<void>((resolve) => {
      const subscription = conn.client.subscribe('tasks.subscribe', {}, (event) => {
        log(formatDaemonEventLine(event as DaemonEvent));
      });
      const onAbort = (): void => {
        subscription.close();
        conn.client.close();
        resolve();
      };
      if (deps.signal.aborted) onAbort();
      else deps.signal.addEventListener('abort', onAbort, { once: true });
    });
    return;
  }

  const path = auditLogPath(storeDir);
  await followAuditLog(path, (event: DaemonEvent) => log(formatDaemonEventLine(event)), {
    signal: deps.signal,
    pollIntervalMs: deps.pollIntervalMs,
    fromEnd: true,
  });
}
