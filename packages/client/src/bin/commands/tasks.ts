import { type DaemonConfig, type DaemonEvent } from '../../index';
import { readAuditRecords } from '../../daemon/audit-log';
import { connectControlClient } from '../../daemon/control-client';
import { resolveStoreDir } from '../config';
import { formatDaemonEventLine, formatTaskListLines } from '../../diagnostics/format';
import { deriveTasksFromRecords } from '../../diagnostics/tasks-view';

export interface TasksListDeps {
  log?: (line: string) => void;
}

/** `byok-agent tasks` (no `--follow`): current known tasks, reconstructed from the audit log — see `byok-agent.ts`'s header comment. */
export async function runTasksListCommand(config: DaemonConfig, deps: TasksListDeps = {}): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const storeDir = resolveStoreDir(config);
  const tasks = deriveTasksFromRecords(await readAuditRecords(storeDir));
  for (const line of formatTaskListLines(tasks)) log(line);
}

export interface TasksFollowDeps {
  log?: (line: string) => void;
  /** Required — see `commands/start.ts`'s identical `StartDeps.signal` doc comment for why there's no sane default. */
  signal: AbortSignal;
  /** DI for tests: substitute the real control-socket connection attempt. */
  connectControl?: typeof connectControlClient;
}

/**
 * `byok-agent tasks --follow`: the LIVE `DaemonEvent` stream over the
 * control socket's `tasks.subscribe` method (see `control-client.ts`), full
 * fidelity, as it happens. The control socket is the only authenticated
 * channel that carries task content (issue #395), so there is no offline
 * fallback: when no daemon is reachable this throws, and plain `byok-agent
 * tasks` shows what the audit log recorded.
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

  throw new Error(`tasks --follow needs a running daemon: control socket not reachable (${conn.reason}); run \`byok-agent tasks\` for the recorded task list`);
}
