import type { AgentEvent } from '@byok/protocol';
import type { ConnectionState, DaemonBranding, DaemonEvent, DaemonTaskInfo } from '../index';
import type { ControlStatusResult } from '../daemon/control-protocol';
import type { ProbedRuntime } from './runtime-probe';
import type { TaskCounts } from './tasks-view';

/**
 * Pure line-formatting helpers shared by every subcommand — no I/O, no
 * process/console access, just `string`/`string[]` in and out, so every
 * function here is directly assertable in a test. PLAIN text only: no
 * ANSI/SGR color codes and no TTY control sequences anywhere in this file
 * (see `byok-agent.ts`'s header comment on why this CLI stays
 * headless/plain-structured, not a TUI). `JSON.stringify` is used purely
 * for its string-escaping (embedded quotes/newlines never break a line),
 * not to imply the overall output is JSON.
 */

function quote(text: string): string {
  return JSON.stringify(text);
}

/** Renders one `task.progress`-derived `AgentEvent` compactly — the inner payload of a `progress`-kind `DaemonEvent`. */
export function formatAgentEvent(event: AgentEvent): string {
  switch (event.type) {
    case 'progress':
      return `progress: ${quote(event.text)}`;
    case 'tool_use':
      return `tool_use: ${event.tool}`;
    case 'tool_result':
      return `tool_result: ${event.tool}`;
    case 'artifact':
      return `artifact: ${event.name} (${event.contentType})`;
    case 'needs_approval':
      return `needs_approval: ${quote(event.summary)}`;
    case 'turn_end':
      return 'turn_end';
    case 'error':
      return `error: ${quote(event.message)}`;
    case 'usage': {
      const parts: string[] = [];
      if (event.inputTokens !== undefined) parts.push(`in=${event.inputTokens}`);
      if (event.outputTokens !== undefined) parts.push(`out=${event.outputTokens}`);
      if (event.totalTokens !== undefined) parts.push(`total=${event.totalTokens}`);
      return `usage: ${parts.length ? parts.join(' ') : '(no fields reported)'}`;
    }
  }
}

/**
 * One line per `DaemonEvent`. Shared by `start` (printed to stdout live
 * while it runs) and `tasks --follow` (tailing the identical shape back out
 * of the audit log) so the two ways of watching the same feed read
 * identically.
 */
export function formatDaemonEventLine(event: DaemonEvent): string {
  const prefix = `[${event.ts}]`;
  switch (event.kind) {
    case 'offered':
      return `${prefix} offered taskId=${event.taskId}${event.runtime ? ` runtime=${event.runtime}` : ''}`;
    case 'claimed':
      return `${prefix} claimed taskId=${event.taskId}`;
    case 'started':
      return `${prefix} started taskId=${event.taskId}`;
    case 'progress':
      return `${prefix} progress taskId=${event.taskId} ${formatAgentEvent(event.event)}`;
    case 'artifact':
      return `${prefix} artifact taskId=${event.taskId} name=${event.name} contentType=${event.contentType}`;
    case 'awaiting-approval':
      return `${prefix} awaiting-approval taskId=${event.taskId} summary=${quote(event.summary)}`;
    case 'completed':
      return `${prefix} completed taskId=${event.taskId} sessionRef=${event.sessionRef} summary=${quote(event.summary)}`;
    case 'failed':
      return `${prefix} failed taskId=${event.taskId} retryable=${event.retryable}${event.preClaim ? ' preClaim=true' : ''} reason=${quote(event.reason)}`;
    case 'cancelled':
      return `${prefix} cancelled taskId=${event.taskId}${event.reason ? ` reason=${quote(event.reason)}` : ''}`;
    case 'connection':
      return `${prefix} connection state=${event.state}`;
    case 'paired':
      return `${prefix} paired deviceId=${event.deviceId}`;
    case 'unpaired':
      return `${prefix} unpaired`;
    case 'runtimes-detected':
      return `${prefix} runtimes-detected ids=${event.runtimes.map((r) => r.id).join(',') || '(none)'}`;
    case 'shutdown-requested':
      return `${prefix} shutdown-requested reason=${quote(event.reason)}`;
    case 'shutdown-complete':
      return `${prefix} shutdown-complete reason=${quote(event.reason)}`;
    case 'stale-approval-decision':
      return `${prefix} stale-approval-decision taskId=${event.taskId} decision=${event.decision}${event.reason ? ` reason=${quote(event.reason)}` : ''}`;
  }
}

export function formatTaskLine(task: DaemonTaskInfo): string {
  const parts = [
    task.taskId,
    task.state,
    task.runtime ? `runtime=${task.runtime}` : undefined,
    `updatedAt=${task.updatedAt}`,
    task.sessionRef ? `sessionRef=${task.sessionRef}` : undefined,
    task.declined ? 'declined=true' : undefined,
    task.summary ? `summary=${quote(task.summary)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(' ');
}

export function formatTaskListLines(tasks: readonly DaemonTaskInfo[]): string[] {
  if (tasks.length === 0) return ['(no tasks observed yet)'];
  return tasks.map(formatTaskLine);
}

export function formatRuntimeLines(runtimes: readonly ProbedRuntime[]): string[] {
  if (runtimes.length === 0) return ['(no runtimes configured — check runtimeAllowlist)'];
  return runtimes.map((r) => {
    if (!r.present) return `${r.id}: absent`;
    const caps: string[] = [];
    if (r.steer) caps.push('steer');
    if (r.resume) caps.push('resume');
    const parts = [
      'present',
      r.version ? `version=${r.version}` : undefined,
      r.authPresent !== undefined ? `authPresent=${r.authPresent}` : undefined,
      `capabilities=${caps.length ? caps.join(',') : '(none)'}`,
      `modes=${r.permissionModes.length ? r.permissionModes.join(',') : '(none)'}`,
    ].filter((part): part is string => Boolean(part));
    return `${r.id}: ${parts.join(' ')}`;
  });
}

export interface StatusView {
  productName: string;
  productId: string;
  branding?: DaemonBranding;
  paired: boolean;
  deviceId?: string;
  connection?: { state: ConnectionState; ts: string };
  runtimes: readonly ProbedRuntime[];
  taskCounts: TaskCounts;
  auditLogPath: string;
  auditLogLineCount: number;
}

export function formatStatusLines(view: StatusView): string[] {
  const lines: string[] = [];
  const label = view.branding?.displayName ?? view.productName;
  lines.push(`product: ${label} (${view.productId})`);
  if (view.branding?.supportUrl) lines.push(`support: ${view.branding.supportUrl}`);
  lines.push(`paired: ${view.paired ? 'yes' : 'no'}${view.deviceId ? ` deviceId=${view.deviceId}` : ''}`);
  lines.push(
    view.connection
      ? `connection: last-known=${view.connection.state} at=${view.connection.ts}`
      : 'connection: unknown (no audit log yet — run `byok-agent start` at least once to begin observing)',
  );
  const runtimeSummary = view.runtimes.map((r) => `${r.id}=${r.present ? 'present' : 'absent'}`).join(' ');
  lines.push(`runtimes: ${runtimeSummary || '(none configured)'}`);
  const c = view.taskCounts;
  lines.push(
    `tasks: total=${c.total} offered=${c.Offered} claimed=${c.Claimed} running=${c.Running} awaitApproval=${c.AwaitApproval} complete=${c.Complete} failed=${c.Failed} cancelled=${c.Cancelled}`,
  );
  lines.push(`audit-log: ${view.auditLogPath} (${view.auditLogLineCount} event${view.auditLogLineCount === 1 ? '' : 's'})`);
  return lines;
}

/**
 * M4 Phase 2: renders the control socket's live `status` result — appended
 * after {@link formatStatusLines}' persisted-state view when a running
 * daemon is actually reachable (see `bin/commands/status.ts`). Every line
 * is prefixed `live-` (or is the single `live:` summary line) so it's
 * unambiguous which lines are a live snapshot of a running process versus
 * the historical/persisted view above them.
 */
export function formatLiveStatusLines(live: ControlStatusResult): string[] {
  const lines: string[] = [
    `live: pid=${live.pid} uptimeMs=${live.uptimeMs} transport=${live.transport}`,
    `live-paired: ${live.paired ? 'yes' : 'no'}${live.deviceId ? ` deviceId=${live.deviceId}` : ''}`,
    `live-runtimes: ${live.runtimeIds.length ? live.runtimeIds.join(',') : '(none)'}`,
  ];
  if (live.activeTasks.length === 0) {
    lines.push('live-active-tasks: (none)');
  } else {
    for (const task of live.activeTasks) {
      lines.push(`live-active-task: ${task.taskId} ${task.state}`);
    }
  }
  // M4 Phase 4 (part B.3): queue watermarks — see ControlStatusResult's own
  // doc comment (control-protocol.ts) for why this is a progress-batcher
  // backlog + in-flight-approval-count proxy, not the adapter's own event
  // queue depth.
  lines.push(`live-approvals-pending: ${live.approvalsPending}`);
  if (live.queueWatermarks.length === 0) {
    lines.push('live-queue-watermarks: (none)');
  } else {
    for (const watermark of live.queueWatermarks) {
      lines.push(
        `live-queue-watermark: ${watermark.taskId} progressBatcherPending=${watermark.progressBatcherPending} pendingApprovals=${watermark.pendingApprovals}`,
      );
    }
  }
  return lines;
}
