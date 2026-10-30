import type { AgentEvent } from '@byok-sdk/protocol';
import type { DaemonBranding, DaemonEvent, DaemonTaskInfo, LocalAgentReleaseIdentity } from '../index';
import { parseDaemonLifecycle, type DaemonHaltReason, type DaemonLifecycle } from '../daemon/daemon-lifecycle';
import type { ControlStatusResult, PendingApproval } from '../daemon/control-protocol';
import type { ServiceEnvironmentStatus } from '../login-shell-environment';
import type { McpToolsetReloadReceipt, McpToolsetStatus } from '../types';
import type { RuntimeObservation } from '../runtime-detection';
import type { TaskCounts, DerivedTaskInfo } from './tasks-view';

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

/** `phase=running connection=open`, `phase=halted reason=device_revoked` — closed values only; the caller prints the time. */
export function formatLifecycle(lifecycle: DaemonLifecycle): string {
  switch (lifecycle.phase) {
    case 'running':
      return `phase=running connection=${lifecycle.connection}`;
    case 'halted':
      return `phase=halted reason=${lifecycle.reason}`;
    default:
      return `phase=${lifecycle.phase}`;
  }
}

/** What an operator does about a run that ended (`halted` or `crashed`); `undefined` otherwise. */
export function formatLifecycleRemedy(lifecycle: DaemonLifecycle): string | undefined {
  if (lifecycle.phase === 'halted') return formatHaltRemedy(lifecycle.reason);
  if (lifecycle.phase === 'crashed') return 'the run crashed on an unexpected error: see the daemon log (a supervised service is restarted)';
  return undefined;
}

/** Issue #394: what an operator does about each halt. A restart alone fixes none of them. */
export function formatHaltRemedy(reason: DaemonHaltReason): string {
  switch (reason) {
    case 'unpaired':
      return 'this device is not paired: run `byok-agent pair <code> --server <url>`, then start again';
    case 're_pair_required':
      return 'the device record is unusable: run `byok-agent pair <code> --server <url>`, then start again';
    case 'store_not_bound':
      return 'the OS credential entry holds an enrollment this storeDir did not pair: if this store owns it, run `byok-agent doctor --repair restore-enrollment-metadata --expected-device-id <id> --expected-tenant-id <tenant> --yes`; otherwise pair this store under its own productId (or `byok-agent pair <code> --server <url> --replace-other-store` to replace the other store\'s enrollment), then start again';
    case 'store_owned':
      return 'another daemon owns this store: stop it first (`byok-agent service-stop`, or end the other `start`)';
    case 'device_revoked':
      return 'device revoked — re-pair needed: the server confirmed this device is no longer registered. Run `byok-agent pair <code> --server <url>`, then start again; pairing registers a new device id';
    case 'handshake_rejected':
      return 'the server rejected this device\'s hello: check productId and the SDK version, or pair again, then start again';
    case 'replay_cursor_too_old':
      return 'the server no longer holds this device\'s undelivered history: pair again (or run operator recovery), then start again';
    case 'cursor_unreadable':
      return 'the delivery cursor file is unreadable: run `byok-agent doctor --repair reset-cursor --yes`, then start again; the server replays this device\'s retained history and already-handled work is not run twice';
    case 'config_invalid':
      return 'the configuration is invalid: fix it, then start again';
  }
}

/**
 * One line per `DaemonEvent`, full content included — only for the
 * authenticated live view (`tasks --follow` over the control socket). A
 * durable sink writes `DaemonRecord`s instead (`daemon/daemon-record.ts`).
 */
export function formatDaemonEventLine(event: DaemonEvent): string {
  const prefix = `[${event.ts}]`;
  switch (event.kind) {
    case 'outbound-rejected':
      return `${prefix} outbound-rejected envelopeId=${event.envelopeId} type=${event.type} reason=${event.reason} terminal=${event.terminal}${event.taskId === undefined ? '' : ` taskId=${event.taskId}`}`;
    case 'retention-sweep': return `${prefix} retention-sweep trigger=${event.trigger} deleted=${event.deleted} bytesReclaimed=${event.bytesReclaimed} failures=${event.failures} truncated=${event.truncated}`;
    case 'retention-failure': return `${prefix} retention-failure trigger=${event.trigger} class=${event.classId} count=${event.count} code=${event.code}`;
    case 'offered':
      return `${prefix} offered taskId=${event.taskId}${event.runtime ? ` runtime=${event.runtime}` : ''}`;
    case 'claimed':
      return `${prefix} claimed taskId=${event.taskId}${event.claimedRuntime !== undefined ? ` claimedRuntime=${event.claimedRuntime}` : ''}`;
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
      return `${prefix} awaiting-approval taskId=${event.taskId}${event.approvalId ? ` approvalId=${event.approvalId}` : ''} summary=${quote(event.summary)}`;
    }
    case 'completed':
      return `${prefix} completed taskId=${event.taskId} sessionRef=${event.sessionRef} summary=${quote(event.summary)}`;
    case 'failed':
      return `${prefix} failed taskId=${event.taskId} retryable=${event.retryable}${event.preClaim ? ' preClaim=true' : ''} reason=${quote(event.reason)}`;
    case 'cancelled':
      return `${prefix} cancelled taskId=${event.taskId}${event.reason ? ` reason=${quote(event.reason)}` : ''}`;
    case 'lifecycle':
      return `${prefix} lifecycle ${formatLifecycle(event.lifecycle)}`;
    case 'paired':
      return `${prefix} paired deviceId=${event.deviceId}`;
    case 'unpaired':
      return `${prefix} unpaired`;
    case 'environment-resolved':
      return `${prefix} environment-resolved ${formatServiceEnvironment(event.status)}`;
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
    case 'tool-reminder':
      return `${prefix} tool-reminder taskId=${event.taskId} tool=${quote(event.toolName)} reasons=${event.reasons.join(',')} summary=${quote(event.summary)}`;
    case 'agent-memory-intent-integrity':
      return `${prefix} agent-memory-intent-integrity intentId=${event.intentId} disposition=${event.disposition}`;
    case 'runtime-disposal-failed':
      return `${prefix} runtime-disposal-failed taskId=${event.taskId} runtime=${event.runtimeId} stage=${event.stage} reason=${quote(event.reason)}`;
    case 'execution-record': {
      const parts = [
        `${prefix} execution-record taskId=${event.taskId}`,
        `terminal=${event.terminal}`,
        `status=${event.status}`,
        `source=${event.source}`,
        event.unknownReason !== undefined ? `unknownReason=${event.unknownReason}` : undefined,
        event.gaps.length > 0 ? `gaps=${event.gaps.map((gap) => `${gap.reason}:${gap.count}`).join(',')}` : undefined,
      ].filter((part): part is string => part !== undefined);
      return parts.join(' ');
    }
    case 'device-assertion': {
      // Plan `device-assertion-broker`. No signature or envelope to render —
      // the event type cannot carry either. codex round-2 F4: the DENIED
      // variant has no raw audience field at all (only `audienceSize`), so a
      // caller-supplied secret shaped as an audience can never reach this
      // line. The ISSUED audience came from the allowlist.
      //
      // Contract §8.2(1): `lane` tells the two credential kinds apart on one
      // stream, and `taskId` names the task the nonce registry resolved. The
      // nonce itself is not a field of this event, so no filter here has to
      // remember to strip it.
      const parts =
        event.result === 'issued'
          ? [
              `${prefix} device-assertion result=issued`,
              `lane=${event.lane}`,
              event.taskId !== undefined ? `taskId=${event.taskId}` : undefined,
              `audience=${quote(event.audience)}`,
              `jti=${event.jti}`,
              `expiresAt=${event.expiresAt}`,
            ].filter((part): part is string => part !== undefined)
          : [
              `${prefix} device-assertion result=denied`,
              `lane=${event.lane}`,
              event.taskId !== undefined ? `taskId=${event.taskId}` : undefined,
              `reason=${event.reason}`,
              event.audienceSize !== undefined ? `audienceSize=${event.audienceSize}` : undefined,
            ].filter((part): part is string => part !== undefined);
      return parts.join(' ');
    }
  }
}

export function formatTaskLine(task: DaemonTaskInfo | DerivedTaskInfo): string {
  const parts = [
    task.taskId,
    task.state,
    task.runtime ? `runtime=${task.runtime}` : undefined,
    task.claimedRuntime !== undefined ? `claimedRuntime=${task.claimedRuntime}` : undefined,
    `updatedAt=${task.updatedAt}`,
    task.sessionRef ? `sessionRef=${task.sessionRef}` : undefined,
    task.declined ? 'declined=true' : undefined,
    task.delivery === 'rejected' ? 'delivery=rejected' : undefined,
    'summary' in task && task.summary ? `summary=${quote(task.summary)}` : undefined,
    'summaryBytes' in task && task.summaryBytes !== undefined ? `summaryBytes=${task.summaryBytes}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(' ');
}

export function formatTaskListLines(tasks: readonly (DaemonTaskInfo | DerivedTaskInfo)[]): string[] {
  if (tasks.length === 0) return ['(no tasks observed yet)'];
  return tasks.map(formatTaskLine);
}

export function formatRuntimeLines(runtimes: readonly RuntimeObservation[]): string[] {
  if (runtimes.length === 0) return ['(no runtimes configured — check runtimeAllowlist)'];
  return runtimes.map((r) => {
    if (!r.present) return `${r.id}: ${r.outcome}${r.outcome === 'refused' ? `:${refusalText(r)}` : ''}`;
    const caps: string[] = [];
    if (r.steer) caps.push('steer');
    if (r.resume) caps.push('resume');
    const parts = [
      'present',
      r.version ? `version=${r.version}` : undefined,
      r.qualifiedVersion !== undefined ? `warning=unqualified-version(qualified=${r.qualifiedVersion})` : undefined,
      r.authPresent !== undefined ? `authPresent=${r.authPresent}` : undefined,
      `capabilities=${caps.length ? caps.join(',') : '(none)'}`,
    ].filter((part): part is string => Boolean(part));
    return `${r.id}: ${parts.join(' ')}`;
  });
}

export interface StatusView {
  localAgentRelease: Readonly<LocalAgentReleaseIdentity>;
  productName: string;
  productId: string;
  branding?: DaemonBranding;
  paired: boolean;
  deviceId?: string;
  /** Issues #391/#394: the last `lifecycle` record the audit log holds. */
  lifecycle?: { lifecycle: DaemonLifecycle; ts: string };
  runtimes: readonly RuntimeObservation[];
  taskCounts: TaskCounts;
  auditLogPath: string;
  /** Records the audit log holds (lines in another shape are not counted). */
  auditLogRecordCount: number;
  /** Issue #392: the environment the last `start` resolved, from its `environment-resolved` audit record. */
  environment?: { status: ServiceEnvironmentStatus; ts: string };
  runtimesDetectedAt?: string;
}

/** Issue #392: `login-shell shell=zsh durationMs=530`, `inherited`, `windows-session` or `unavailable code=timeout` — closed values and a shell basename only. */
export function formatServiceEnvironment(status: ServiceEnvironmentStatus): string {
  switch (status.source) {
    case 'login-shell':
      return `login-shell shell=${status.shell} durationMs=${status.durationMs}`;
    case 'inherited':
      return 'inherited';
    case 'windows-session':
      return 'windows-session';
    case 'unavailable':
      return `unavailable code=${status.code}`;
  }
}

export function formatStatusLines(view: StatusView): string[] {
  const lines: string[] = [];
  const label = view.branding?.displayName ?? view.productName;
  lines.push(`product: ${label} (${view.productId})`);
  lines.push(
    `local-agent-release: ${view.localAgentRelease.version}${view.localAgentRelease.buildId ? ` buildId=${view.localAgentRelease.buildId}` : ''}`,
  );
  if (view.branding?.supportUrl) lines.push(`support: ${view.branding.supportUrl}`);
  lines.push(`paired: ${view.paired ? 'yes' : 'no'}${view.deviceId ? ` deviceId=${view.deviceId}` : ''}`);
  lines.push(
    view.lifecycle
      ? `lifecycle: last-known ${formatLifecycle(view.lifecycle.lifecycle)} at=${view.lifecycle.ts}`
      : 'lifecycle: unknown (no lifecycle event yet — run `byok-agent start` at least once to begin observing)',
  );
  const remedy = view.lifecycle ? formatLifecycleRemedy(view.lifecycle.lifecycle) : undefined;
  if (remedy !== undefined) lines.push(`lifecycle-remedy: ${remedy}`);
  lines.push(
    view.environment
      ? `environment: ${formatServiceEnvironment(view.environment.status)} at=${view.environment.ts}`
      : 'environment: unknown (no environment-resolved record yet)',
  );
  const runtimeSummary = formatRuntimeObservations(view.runtimes);
  lines.push(view.runtimesDetectedAt
    ? `runtimes: last-known ${runtimeSummary} at=${view.runtimesDetectedAt}`
    : 'runtimes: unknown (no runtimes-detected record yet)');
  const c = view.taskCounts;
  lines.push(
    `tasks: total=${c.total} offered=${c.Offered} claimed=${c.Claimed} running=${c.Running} awaitApproval=${c.AwaitApproval} complete=${c.Complete} failed=${c.Failed} cancelled=${c.Cancelled}`,
  );
  lines.push(`audit-log: ${view.auditLogPath} (${view.auditLogRecordCount} record${view.auditLogRecordCount === 1 ? '' : 's'})`);
  return lines;
}

/** `runtime_environment_unavailable:timeout` carries the capture failure code (#1095). */
function refusalText(runtime: RuntimeObservation): string {
  return runtime.code === undefined ? `${runtime.reason}` : `${runtime.reason}:${runtime.code}`;
}

function formatRuntimeObservations(runtimes: readonly RuntimeObservation[]): string {
  return runtimes.map(runtime => `${runtime.id}=${runtime.outcome === 'refused' ? `refused:${refusalText(runtime)}` : runtime.outcome}`).join(' ') || '(none)';
}

/**
 * M4 Phase 2: renders the control socket's live `status` result — appended
 * after {@link formatStatusLines}' persisted-state view when a running
 * daemon is actually reachable (see `bin/commands/status.ts`). Every line
 * is prefixed `live-` (or is the single `live:` summary line) so it's
 * unambiguous which lines are a live snapshot of a running process versus
 * the historical/persisted view above them.
 */
/**
 * The control `status` answer comes from another process, possibly an older
 * daemon that reports `transport` and no `lifecycle`: read it strictly, as
 * `doctor` does, and say so instead of failing the whole live view.
 */
function formatLiveLifecycle(value: unknown): string {
  const lifecycle = parseDaemonLifecycle(value);
  return lifecycle ? formatLifecycle(lifecycle) : 'lifecycle unknown (daemon predates lifecycle)';
}

export function formatLiveStatusLines(live: ControlStatusResult): string[] {
  const liveRelease = live.localAgentRelease;
  const lines: string[] = [
    `live: pid=${live.pid} uptimeMs=${live.uptimeMs} ${formatLiveLifecycle(live.lifecycle)}`,
    liveRelease
      ? `live-local-agent-release: ${liveRelease.version}${liveRelease.buildId ? ` buildId=${liveRelease.buildId}` : ''}`
      : 'live-local-agent-release: unknown',
    `live-paired: ${live.paired ? 'yes' : 'no'}${live.deviceId ? ` deviceId=${live.deviceId}` : ''}`,
    `live-environment: ${live.environment === undefined ? 'unknown' : formatServiceEnvironment(live.environment)}`,
    `live-runtimes: ${live.runtimes === undefined ? 'unknown' : formatRuntimeObservations(live.runtimes)}`,
    `live-toolsets: revision=${live.toolsets.revision} count=${live.toolsets.toolsets.length}`,
  ];
  for (const toolset of live.toolsets.toolsets) lines.push(formatToolsetStatusLine('live-toolset', toolset));
  const outbound = live.outbound;
  lines.push(`live-outbound: accepted=${outbound.accepted} duplicate=${outbound.duplicate} rejected=${outbound.rejected} rejectedTerminals=${outbound.rejectedTerminals} droppedEphemeral=${outbound.droppedEphemeral}`);
  const health = live.operationalHealth;
  if (health.availability === 'unavailable') {
    lines.push(`live-operational-health: unavailable reason=${quote(health.reason)}`);
  } else {
    lines.push(
      `live-operational-health: state=${health.state} failures=${health.failureCount}/${health.failureThreshold} windowMs=${health.windowMs} crashes=${health.crashCount}${health.lastCrashAt ? ` lastCrashAt=${health.lastCrashAt}` : ''}`,
    );
  }
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
  const storage = live.storage;
  if (storage !== undefined) {
    lines.push(`live-storage: used=${storage.usedBytes} free=${storage.freeBytes ?? 'unknown'} measuredAt=${storage.measuredAt ?? 'unknown'}`);
    if (storage.budget) lines.push(`live-storage-budget: state=${storage.budget.pressureState} bytes=${storage.budget.budgetBytes}`);
    for (const entry of storage.classes) lines.push(`live-storage-class: ${entry.classId} bytes=${entry.bytes} entries=${entry.entries} protected=${entry.protected} measured=${entry.measured} truncated=${entry.truncated}`);
    if (storage.lastSweep) lines.push(`live-storage-sweep: trigger=${storage.lastSweep.trigger} deleted=${storage.lastSweep.deleted} failures=${storage.lastSweep.failures} truncated=${storage.lastSweep.truncated}`);
  }
  return lines;
}

function formatToolsetStatusLine(prefix: string, toolset: Readonly<McpToolsetStatus>): string {
  const observation = toolset.observation;
  return [
    `${prefix}: ${toolset.id}`,
    `servers=${toolset.serverCount}`,
    `definitionRevision=${toolset.definitionRevision}`,
    `state=${observation?.state ?? 'unobserved'}`,
    observation?.version === undefined ? undefined : `version=${quote(observation.version)}`,
    observation?.observedAt === undefined ? undefined : `observedAt=${observation.observedAt}`,
    observation?.reasonCode === undefined ? undefined : `reasonCode=${observation.reasonCode}`,
  ].filter((part): part is string => part !== undefined).join(' ');
}

/** Plain, redacted operator receipt for one host-owned registry reload. */
export function formatToolsetsReloadReceiptLines(receipt: Readonly<McpToolsetReloadReceipt>): string[] {
  return [
    `toolsets-reload: changed=${receipt.changed ? 'yes' : 'no'} previousRevision=${receipt.previousRevision} revision=${receipt.revision}`,
    ...receipt.toolsets.map((toolset) => formatToolsetStatusLine('toolset', toolset)),
  ];
}

/** Cap on a rendered approval summary's length before truncating with an ellipsis — these can be arbitrarily long tool-input dumps (the full summary is only ever shown over the authenticated control socket, never in a durable sink — `docs/security.md`); this is purely a display-width concern for a CLI table, not a redaction. */
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
