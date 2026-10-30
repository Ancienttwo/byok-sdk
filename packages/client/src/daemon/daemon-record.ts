import type { AgentEvent } from '@byok-sdk/protocol';
import type { ToolRiskReason } from '../tool-authorization';
import type { DaemonLifecycle } from './daemon-lifecycle';
import { MAX_TRACKED_TASKS, type AssertionLane, type DaemonEvent } from './observer';
import { SERVICE_ENVIRONMENT_UNAVAILABLE_CODES, type ServiceEnvironmentStatus, type ServiceEnvironmentRecord, type ServiceEnvironmentUnavailableCode } from '../login-shell-environment';
import type { RuntimeObservation } from '../runtime-detection';

/**
 * The content-free projection of what a daemon observed — the ONE shape every
 * sink that outlives the process writes (issue #395): `byok-agent start`'s
 * stdout (a service log under launchd/systemd/WinSW) and `audit.jsonl` hold the
 * same JSON line per record.
 *
 * A record carries lifecycle facts, ids, closed codes, configured identifiers
 * (runtime/tool/toolset ids, the assertion audience allowlist), sizes, counts
 * and timestamps — never content. Every free-form field of a `DaemonEvent`
 * (model text, tool input/output, artifact names and bytes, approval summaries,
 * completed summaries, failure/cancel/shutdown/disposal reasons) becomes its
 * UTF-8 byte count (`*Bytes`). `DaemonEvent` itself, with full content, is only
 * for authenticated live views (the control socket's `tasks.subscribe`).
 *
 * Progress is aggregated per turn: a task's `progress` events produce one
 * `turn` record when the runtime reports `turn_end`, or when the turn is still
 * open as the task ends, the daemon stops, or the task is evicted.
 */
export type DaemonRecord =
  | Extract<DaemonEvent, { kind: 'outbound-rejected' }>
  | Extract<DaemonEvent, { kind: 'retention-sweep' | 'retention-failure' }>
  | { kind: 'offered'; ts: string; taskId: string; runtime?: string }
  | { kind: 'claimed'; ts: string; taskId: string; claimedRuntime?: string }
  | { kind: 'started'; ts: string; taskId: string }
  | DaemonTurnRecord
  | {
      kind: 'artifact';
      ts: string;
      taskId: string;
      nameBytes: number;
      contentType: string;
      inlineBytes?: number;
      blobRef?: { blobId: string; contentHash: string; size: number };
    }
  | { kind: 'awaiting-approval'; ts: string; taskId: string; approvalId?: string; summaryBytes: number }
  | { kind: 'completed'; ts: string; taskId: string; sessionRef: string; summaryBytes: number }
  | { kind: 'failed'; ts: string; taskId: string; retryable: boolean; preClaim?: boolean; reasonBytes: number }
  | { kind: 'cancelled'; ts: string; taskId: string; reasonBytes?: number }
  | { kind: 'lifecycle'; ts: string; lifecycle: DaemonLifecycle }
  | { kind: 'paired'; ts: string; deviceId: string }
  | { kind: 'unpaired'; ts: string }
  | { kind: 'runtimes-detected'; ts: string; runtimes: Array<Omit<RuntimeObservation, 'version'>> }
  | { kind: 'shutdown-requested'; ts: string; reasonBytes: number }
  | { kind: 'shutdown-complete'; ts: string; reasonBytes: number; undeliveredOutboxCount?: number }
  | { kind: 'stale-approval-decision'; ts: string; taskId: string; decision: 'approve' | 'reject'; reasonBytes?: number }
  | { kind: 'tool-reminder'; ts: string; taskId: string; reasons: readonly ToolRiskReason[]; summaryBytes: number }
  | { kind: 'runtime-disposal-failed'; ts: string; taskId: string; runtimeId: string; stage: 'signal' | 'quiescence' | 'cleanup'; reasonBytes: number }
  /** Already content-free: counts and closed codes (`execution-record.ts`). */
  | Extract<DaemonEvent, { kind: 'execution-record' }>
  | { kind: 'agent-memory-intent-integrity'; ts: string; intentId: string; disposition: 'conflict' | 'host_terminal' }
  | { kind: 'device-assertion'; ts: string; result: 'issued'; lane: AssertionLane; taskId?: string; audience: string; jti: string; expiresAt: string }
  | { kind: 'device-assertion'; ts: string; result: 'denied'; lane: AssertionLane; taskId?: string; reason: string; audienceBytes?: number }
  /** Written by the process hosting the daemon (`byok-agent start`): where its environment came from (issue #392). */
  | ({ kind: 'environment-resolved'; ts: string } & ServiceEnvironmentStatus)
  /** Written by the process hosting the daemon once `start()` resolved. */
  | { kind: 'daemon-started'; ts: string; productId: string }
  /** Written by the process hosting the daemon once `stop()` resolved. */
  | { kind: 'daemon-stopped'; ts: string };

/** One turn of a task's progress, as sizes and counts. */
export interface DaemonTurnRecord {
  kind: 'turn';
  ts: string;
  taskId: string;
  /** 1-based turn number within the task, as this projector counted it. */
  turn: number;
  /** What closed the record: the runtime's `turn_end`, or a still-open turn at the task's terminal, the daemon's stop, or eviction. */
  closedBy: 'turn_end' | 'terminal' | 'stop' | 'evicted';
  /** Every `AgentEvent` of the turn, `turn_end` and `usage` included. */
  progressEvents: number;
  textBytes: number;
  toolUses: number;
  toolResults: number;
  artifacts: number;
  errors: number;
  /** The turn's last `usage` report, when it had one. */
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type DaemonRecordKind = DaemonRecord['kind'];

const KIND_SET: Record<DaemonRecordKind, true> = {
  'outbound-rejected': true,
  'retention-sweep': true,
  'retention-failure': true,
  offered: true,
  claimed: true,
  started: true,
  turn: true,
  artifact: true,
  'awaiting-approval': true,
  'tool-reminder': true,
  completed: true,
  failed: true,
  cancelled: true,
  lifecycle: true,
  paired: true,
  unpaired: true,
  'runtimes-detected': true,
  'shutdown-requested': true,
  'shutdown-complete': true,
  'stale-approval-decision': true,
  'runtime-disposal-failed': true,
  'execution-record': true,
  'agent-memory-intent-integrity': true,
  'device-assertion': true,
  'environment-resolved': true,
  'daemon-started': true,
  'daemon-stopped': true,
};

/** Every {@link DaemonRecord} kind — the one list readers (the support bundle, the audit reader) accept. */
export const DAEMON_RECORD_KINDS: readonly DaemonRecordKind[] = Object.freeze(Object.keys(KIND_SET) as DaemonRecordKind[]);

export function isDaemonRecordKind(value: unknown): value is DaemonRecordKind {
  return typeof value === 'string' && Object.hasOwn(KIND_SET, value);
}

export interface DaemonRecordProjector {
  /** The records `event` produces, in order: none (a progress event inside an open turn), one, or two (an open turn closed by a terminal). */
  project(event: DaemonEvent): DaemonRecord[];
  /** Closes every open turn (`closedBy: 'stop'`) — call once the daemon has stopped. */
  flush(ts: string): DaemonRecord[];
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

const UNAVAILABLE_CODES = new Set<string>(SERVICE_ENVIRONMENT_UNAVAILABLE_CODES);

/** The one closed environment shape, shared by projection and persistent/live readers. */
export function parseEnvironmentRecord(value: unknown): ServiceEnvironmentRecord | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'environment-resolved' || typeof record.ts !== 'string' || !Number.isFinite(Date.parse(record.ts))) return undefined;
  const keys = Object.keys(record);
  const only = (...allowed: string[]): boolean => keys.every((key) => ['kind', 'ts', 'source', ...allowed].includes(key));
  if (record.source === 'inherited' && only()) return { ts: record.ts, status: { source: 'inherited' } };
  if (record.source === 'windows-session' && only()) return { ts: record.ts, status: { source: 'windows-session' } };
  if (record.source === 'unavailable' && only('code') && typeof record.code === 'string' && UNAVAILABLE_CODES.has(record.code)) {
    return { ts: record.ts, status: { source: 'unavailable', code: record.code as ServiceEnvironmentUnavailableCode } };
  }
  if (record.source === 'login-shell' && only('shell', 'durationMs') && typeof record.shell === 'string'
    && /^[A-Za-z0-9._-]{1,64}$/u.test(record.shell) && typeof record.durationMs === 'number'
    && Number.isSafeInteger(record.durationMs) && record.durationMs >= 0) {
    return { ts: record.ts, status: { source: 'login-shell', shell: record.shell, durationMs: record.durationMs } };
  }
  return undefined;
}

interface TurnTally {
  progressEvents: number;
  textBytes: number;
  toolUses: number;
  toolResults: number;
  artifacts: number;
  errors: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

/** Per task: the last turn number used, and the open turn's tally. Bounded to `MAX_TRACKED_TASKS` tasks; released at the task's terminal record. */
interface TaskTurns {
  turn: number;
  open?: TurnTally;
}

function tally(open: TurnTally, event: AgentEvent): void {
  open.progressEvents += 1;
  switch (event.type) {
    case 'progress':
      open.textBytes += bytes(event.text);
      return;
    case 'tool_use':
      open.toolUses += 1;
      return;
    case 'tool_result':
      open.toolResults += 1;
      return;
    case 'artifact':
      open.artifacts += 1;
      return;
    case 'error':
      open.errors += 1;
      return;
    case 'usage':
      open.usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens, totalTokens: event.totalTokens };
      return;
    case 'turn_end':
      return;
  }
}

function turnRecord(ts: string, taskId: string, turn: number, open: TurnTally, closedBy: DaemonTurnRecord['closedBy']): DaemonTurnRecord {
  return {
    kind: 'turn',
    ts,
    taskId,
    turn,
    closedBy,
    progressEvents: open.progressEvents,
    textBytes: open.textBytes,
    toolUses: open.toolUses,
    toolResults: open.toolResults,
    artifacts: open.artifacts,
    errors: open.errors,
    ...(open.usage?.inputTokens === undefined ? {} : { inputTokens: open.usage.inputTokens }),
    ...(open.usage?.outputTokens === undefined ? {} : { outputTokens: open.usage.outputTokens }),
    ...(open.usage?.totalTokens === undefined ? {} : { totalTokens: open.usage.totalTokens }),
  };
}

/** The one-to-one part of the projection: every `DaemonEvent` kind except `progress`. */
function recordOf(event: Exclude<DaemonEvent, { kind: 'progress' }>): DaemonRecord {
  const { ts } = event;
  switch (event.kind) {
    case 'outbound-rejected': {
      const record = {
        kind: 'outbound-rejected' as const,
        ts,
        envelopeId: event.envelopeId,
        type: event.type,
        reason: event.reason,
        ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      };
      return event.terminal
        ? { ...record, terminal: true, taskState: event.taskState }
        : { ...record, terminal: false };
    }
    case 'retention-sweep':
      return { kind: event.kind, ts, trigger: event.trigger, at: event.at, deleted: event.deleted,
        bytesReclaimed: event.bytesReclaimed, failures: event.failures, truncated: event.truncated, durationMs: event.durationMs };
    case 'retention-failure':
      return { kind: event.kind, ts, trigger: event.trigger, classId: event.classId, count: event.count, code: event.code };
    case 'offered':
      return { kind: 'offered', ts, taskId: event.taskId, ...(event.runtime === undefined ? {} : { runtime: event.runtime }) };
    case 'claimed':
      return { kind: 'claimed', ts, taskId: event.taskId, ...(event.claimedRuntime === undefined ? {} : { claimedRuntime: event.claimedRuntime }) };
    case 'started':
      return { kind: 'started', ts, taskId: event.taskId };
    case 'artifact':
      // `blobRef.url` is a presigned URL — a bearer credential for the bytes —
      // so only the pointer and size survive.
      return {
        kind: 'artifact',
        ts,
        taskId: event.taskId,
        nameBytes: bytes(event.name),
        contentType: event.contentType,
        ...(event.inline === undefined ? {} : { inlineBytes: bytes(event.inline) }),
        ...(event.blobRef === undefined
          ? {}
          : { blobRef: { blobId: event.blobRef.blobId, contentHash: event.blobRef.contentHash, size: event.blobRef.size } }),
      };
    case 'awaiting-approval':
      return {
        kind: 'awaiting-approval',
        ts,
        taskId: event.taskId,
        ...(event.approvalId === undefined ? {} : { approvalId: event.approvalId }),
        summaryBytes: bytes(event.summary),
      };
    case 'completed':
      return { kind: 'completed', ts, taskId: event.taskId, sessionRef: event.sessionRef, summaryBytes: bytes(event.summary) };
    case 'failed':
      return {
        kind: 'failed',
        ts,
        taskId: event.taskId,
        retryable: event.retryable,
        ...(event.preClaim === undefined ? {} : { preClaim: event.preClaim }),
        reasonBytes: bytes(event.reason),
      };
    case 'cancelled':
      return { kind: 'cancelled', ts, taskId: event.taskId, ...(event.reason === undefined ? {} : { reasonBytes: bytes(event.reason) }) };
    case 'lifecycle':
      return { kind: 'lifecycle', ts, lifecycle: event.lifecycle };
    case 'paired':
      return { kind: 'paired', ts, deviceId: event.deviceId };
    case 'unpaired':
      return { kind: 'unpaired', ts };
    case 'runtimes-detected':
      // Actual runtime output is untrusted text; the advisory's qualified
      // version is adapter configuration and preserves its warning offline.
      return { kind: 'runtimes-detected', ts, runtimes: event.runtimes.map(({ version: _version, ...observation }) => observation) };
    case 'environment-resolved': {
      const record = parseEnvironmentRecord({ kind: 'environment-resolved', ts, ...event.status });
      if (record === undefined) throw new TypeError('invalid environment-resolved event');
      return { kind: 'environment-resolved', ts: record.ts, ...record.status };
    }
    case 'shutdown-requested':
      return { kind: 'shutdown-requested', ts, reasonBytes: bytes(event.reason) };
    case 'shutdown-complete':
      return {
        kind: 'shutdown-complete',
        ts,
        reasonBytes: bytes(event.reason),
        ...(event.undeliveredOutboxCount === undefined ? {} : { undeliveredOutboxCount: event.undeliveredOutboxCount }),
      };
    case 'stale-approval-decision':
      return {
        kind: 'stale-approval-decision',
        ts,
        taskId: event.taskId,
        decision: event.decision,
        ...(event.reason === undefined ? {} : { reasonBytes: bytes(event.reason) }),
      };
    case 'tool-reminder':
      return { kind: 'tool-reminder', ts, taskId: event.taskId, reasons: [...event.reasons], summaryBytes: bytes(event.summary) };
    case 'runtime-disposal-failed':
      return {
        kind: 'runtime-disposal-failed',
        ts,
        taskId: event.taskId,
        runtimeId: event.runtimeId,
        stage: event.stage,
        reasonBytes: bytes(event.reason),
      };
    case 'execution-record':
      return {
        kind: 'execution-record',
        ts,
        taskId: event.taskId,
        terminal: event.terminal,
        status: event.status,
        source: event.source,
        gaps: event.gaps.map(({ reason, count }) => ({ reason, count })),
        ...(event.unknownReason === undefined ? {} : { unknownReason: event.unknownReason }),
      };
    case 'agent-memory-intent-integrity':
      return { kind: 'agent-memory-intent-integrity', ts, intentId: event.intentId, disposition: event.disposition };
    case 'device-assertion':
      // The issued audience comes from the configured allowlist; the denied
      // reason is an `ASSERTION_ISSUE_ERROR_CODES` code. A denied caller's raw
      // audience was never a field of the event (`observer.ts`).
      return event.result === 'issued'
        ? {
            kind: 'device-assertion',
            ts,
            result: 'issued',
            lane: event.lane,
            ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
            audience: event.audience,
            jti: event.jti,
            expiresAt: event.expiresAt,
          }
        : {
            kind: 'device-assertion',
            ts,
            result: 'denied',
            lane: event.lane,
            ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
            reason: event.reason,
            ...(event.audienceSize === undefined ? {} : { audienceBytes: event.audienceSize }),
          };
  }
}

/**
 * A stateful `DaemonEvent` → {@link DaemonRecord} projector. One per event
 * stream: it holds each task's open turn until the turn closes.
 */
export function createDaemonRecordProjector(): DaemonRecordProjector {
  const tasks = new Map<string, TaskTurns>();

  function close(taskId: string, state: TaskTurns, ts: string, closedBy: DaemonTurnRecord['closedBy']): DaemonRecord[] {
    const open = state.open;
    if (open === undefined) return [];
    state.open = undefined;
    return [turnRecord(ts, taskId, state.turn, open, closedBy)];
  }

  function track(taskId: string, ts: string): { state: TaskTurns; evicted: DaemonRecord[] } {
    const existing = tasks.get(taskId);
    if (existing !== undefined) return { state: existing, evicted: [] };
    const evicted: DaemonRecord[] = [];
    if (tasks.size >= MAX_TRACKED_TASKS) {
      const [oldestId, oldest] = tasks.entries().next().value as [string, TaskTurns];
      tasks.delete(oldestId);
      evicted.push(...close(oldestId, oldest, ts, 'evicted'));
    }
    const state: TaskTurns = { turn: 0 };
    tasks.set(taskId, state);
    return { state, evicted };
  }

  return {
    project(event) {
      if (event.kind === 'progress') {
        const { state, evicted } = track(event.taskId, event.ts);
        if (state.open === undefined) {
          state.turn += 1;
          state.open = { progressEvents: 0, textBytes: 0, toolUses: 0, toolResults: 0, artifacts: 0, errors: 0 };
        }
        tally(state.open, event.event);
        return event.event.type === 'turn_end' ? [...evicted, ...close(event.taskId, state, event.ts, 'turn_end')] : evicted;
      }
      const terminalTaskId = event.kind === 'completed' || event.kind === 'failed' || event.kind === 'cancelled'
        ? event.taskId
        : event.kind === 'outbound-rejected' && event.terminal ? event.taskId : undefined;
      if (terminalTaskId !== undefined) {
        const state = tasks.get(terminalTaskId);
        tasks.delete(terminalTaskId);
        return [...(state === undefined ? [] : close(terminalTaskId, state, event.ts, 'terminal')), recordOf(event)];
      }
      return [recordOf(event)];
    },
    flush(ts) {
      const records: DaemonRecord[] = [];
      for (const [taskId, state] of tasks) records.push(...close(taskId, state, ts, 'stop'));
      return records;
    },
  };
}
