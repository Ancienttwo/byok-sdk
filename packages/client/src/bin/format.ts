import type { AgentEvent } from '@byok/protocol';
import type { ConnectionState, DaemonBranding, DaemonEvent, DaemonTaskInfo } from '../index';
import type { ControlStatusResult, PendingApproval } from '../daemon/control-protocol';
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

/**
 * Finding F8 (cross-model adversarial review): mirrors `bin/audit-log.ts`'s
 * own `[redacted: N bytes]` placeholder style EXACTLY (byte count, not a
 * hash — same convention, same wording), so a redacted stdout line and a
 * redacted (replayed-from-audit-log) line read identically. Deliberately
 * NOT imported from `audit-log.ts` itself — that module does real
 * filesystem I/O and this one is pure by design (see the module doc
 * comment above); duplicating this one small, stable string format is
 * cheaper than crossing that boundary.
 */
function redactedByteCountPlaceholder(text: string): string {
  return `[redacted: ${Buffer.byteLength(text, 'utf8')} bytes]`;
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

export interface FormatDaemonEventLineOptions {
  /**
   * Finding F8 (cross-model adversarial review): redact an
   * `awaiting-approval` event's `summary` to a `[redacted: N bytes]`
   * placeholder instead of the raw text. `summary` can carry the exact
   * tool-call text (a shell command, a file's contents) a `confirm`-mode
   * policy is gating — `start.ts`'s stdout is captured verbatim by
   * launchd/systemd/WinSW service logs, which have no business holding
   * that. Default `false` (full fidelity) — every OTHER caller
   * (`tasks --follow`'s control-socket path, which is authenticated;
   * and its audit-log-tailing fallback, whose events are ALREADY redacted
   * at the source by `audit-log.ts` regardless of this flag) keeps showing
   * whatever it already legitimately can. Only `bin/commands/start.ts`
   * sets this to `true`.
   */
  redactApprovalSummary?: boolean;
}

/**
 * One line per `DaemonEvent`. Shared by `start` (printed to stdout live
 * while it runs) and `tasks --follow` (tailing the identical shape back out
 * of the audit log) so the two ways of watching the same feed read
 * identically.
 */
export function formatDaemonEventLine(event: DaemonEvent, options: FormatDaemonEventLineOptions = {}): string {
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
    case 'awaiting-approval': {
      // Finding F4: approvalId is what an operator actually needs to call
      // `approve`/`reject`/`approvals` against this pending decision —
      // omitted (rather than shown as e.g. "approvalId=undefined") for the
      // rare event with none, so the plain-text shape never implies a
      // literal "undefined" id exists.
      // Finding F8: see `FormatDaemonEventLineOptions.redactApprovalSummary`'s
      // own doc comment.
      const summary = options.redactApprovalSummary ? redactedByteCountPlaceholder(event.summary) : event.summary;
      return `${prefix} awaiting-approval taskId=${event.taskId}${event.approvalId ? ` approvalId=${event.approvalId}` : ''} summary=${quote(summary)}`;
    }
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
      // Finding F5(b): undeliveredOutboxCount is an honest audit signal
      // (0 = drain genuinely finished; >0 = that many envelopes, e.g. a
      // task.fail, never actually left the outbox) — rendered whenever
      // defined (including 0), distinct from an older audit entry that
      // predates this fix and simply has no such field at all.
      return `${prefix} shutdown-complete reason=${quote(event.reason)}${event.undeliveredOutboxCount !== undefined ? ` undeliveredOutboxCount=${event.undeliveredOutboxCount}` : ''}`;
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
  // Finding F4: the actual pending approvals (not just the count above) —
  // an operator can read an approvalId straight off `status` without also
  // running the dedicated `approvals` command. Kept compact (no `age`
  // column, unlike `formatApprovalsListLines`'s dedicated listing) since
  // this is one section of a bigger status view, not a purpose-built table.
  if (live.approvals.length === 0) {
    lines.push('live-approvals: (none)');
  } else {
    for (const approval of live.approvals) {
      lines.push(`live-approval: ${approval.approvalId} taskId=${approval.taskId} summary=${quote(summaryExcerpt(approval.summary))}`);
    }
  }
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

/** Cap on a rendered approval summary's length before truncating with an ellipsis — these can be arbitrarily long tool-input dumps (see `docs/security.md`'s F8 note on why the FULL summary is only ever shown over the authenticated control socket, never service-log stdout); this is purely a display-width concern for a CLI table, not a redaction. */
const SUMMARY_EXCERPT_MAX_LEN = 60;

function summaryExcerpt(summary: string | undefined): string {
  if (!summary) return '(no summary)';
  return summary.length > SUMMARY_EXCERPT_MAX_LEN ? `${summary.slice(0, SUMMARY_EXCERPT_MAX_LEN)}…` : summary;
}

/** `Date.parse(createdAt)` failing (or an implausible clock skew making `nowMs - created` negative) never renders a negative/NaN age — clamped to 0 rather than surfacing an internal computation artifact in operator-facing output. */
function formatAge(ms: number): string {
  const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h`;
  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d`;
}

/**
 * Finding F4: renders `approvals.list`'s registry entries for the new
 * `byok-agent approvals` command (`bin/commands/approvals.ts`) — columns
 * approvalId, taskId, age, summary excerpt, per that finding's own spec.
 * `nowMs` is injected (rather than read via `Date.now()` here) so tests get
 * deterministic age rendering; the real caller passes `Date.now()`.
 */
export function formatApprovalsListLines(approvals: readonly PendingApproval[], nowMs: number): string[] {
  if (approvals.length === 0) return ['(no pending approvals)'];
  return approvals.map((approval) => {
    const ageMs = nowMs - Date.parse(approval.createdAt);
    return `${approval.approvalId} taskId=${approval.taskId} age=${formatAge(ageMs)} summary=${quote(summaryExcerpt(approval.summary))}`;
  });
}
