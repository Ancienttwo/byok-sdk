import { type DaemonConfig, type DaemonEvent } from '../../index';
import { auditLogPath, followAuditLog, readAuditEvents } from '../audit-log';
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
}

/**
 * `byok-agent tasks --follow`: tails the SAME `audit.jsonl` a running
 * `start` appends to, starting from its current end (like `tail -f`, not a
 * full replay — run plain `byok-agent tasks` first for history). This CLI
 * invocation is a separate OS process from `start`; there is no IPC to
 * attach to its live in-memory feed, so tailing the file it already writes
 * is the only channel available. See `byok-agent.ts`'s header comment.
 */
export async function runTasksFollowCommand(config: DaemonConfig, deps: TasksFollowDeps): Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const storeDir = resolveStoreDir(config);
  const path = auditLogPath(storeDir);
  await followAuditLog(path, (event: DaemonEvent) => log(formatDaemonEventLine(event)), {
    signal: deps.signal,
    pollIntervalMs: deps.pollIntervalMs,
    fromEnd: true,
  });
}
