import { EXPIRING_CLASS_IDS, PROTECTED_CLASS_IDS, type RetentionClassId, type RetentionTrigger } from './retention/registry';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { TASK_STATES, type TaskState, OUTBOUND_REFUSAL_REASONS, type OutboundRefusalReason } from '@byok-sdk/protocol';
import { parseDaemonLifecycle, type DaemonLifecycle } from './daemon-lifecycle';
import { isDaemonRecordKind, type DaemonRecord } from './daemon-record';
import type { ServiceEnvironmentStatus, ServiceEnvironmentRecord } from '../login-shell-environment';
import { parseEnvironmentRecord } from './daemon-record';
export { parseEnvironmentRecord } from './daemon-record';
import { atomicWriteFile } from '../util/atomic-write';
import { parseRuntimeObservations } from '../runtime-detection';

/**
 * `audit.jsonl`: the durable record of what a running `byok-agent start`
 * process observed, and the ONLY channel a separate, short-lived CLI
 * invocation (`status`/`tasks`/`doctor`/`service-status`/the support bundle)
 * has into it — see `byok-agent.ts`'s header comment. One JSON line per
 * {@link DaemonRecord} (`daemon/daemon-record.ts`), oldest first,
 * append-only.
 *
 * Issue #395: every sink that outlives the process writes the same
 * content-free projection. `start` prints each record to stdout as the very
 * line it appends here, so a service log (launchd/systemd do not rotate it)
 * and this file hold identical bytes. Task content — model text, tool
 * input/output, artifact names and bytes, approval summaries, completed
 * summaries, failure reasons — never reaches either: a record carries only
 * ids, closed codes, configured identifiers, sizes and counts. Full content
 * travels only over the authenticated control socket (`tasks --follow`).
 *
 * Permissions: the file is tightened to 0600 BEFORE any new content is
 * written, on every append (`open()`'s `mode` only governs creation, so a
 * pre-existing permissive file is chmod'd first; the tightening also takes
 * effect when the append that follows it fails). `storeDir` gets the same
 * defensive re-`chmod` to 0700 on every append.
 *
 * Bounded: past `MAX_AUDIT_LOG_BYTES` the file is atomically rewritten to its
 * most recent `AUDIT_LOG_TRIM_TARGET_LINES` lines, keeping one lifecycle
 * anchor per still-open task (capped at `MAX_LIVE_TASK_ANCHORS`) and the
 * latest `lifecycle`, `runtimes-detected` and `environment-resolved` records — see
 * {@link compactPreservingLiveTasks}.
 *
 * Readers drop any line that is not a well-formed record of a kind in
 * `DAEMON_RECORD_KINDS`, including lines an older build wrote in another
 * shape, so one bad line never breaks a read.
 */

export function auditLogPath(storeDir: string): string {
  return path.join(storeDir, 'audit.jsonl');
}

/** 0600: this file carries task ids, runtime and audience identifiers, and sizes/counts derived from potentially sensitive task data — never group/world-readable, same bar as `device.json` (`daemon/store.ts`). */
const AUDIT_LOG_MODE = 0o600;
const AUDIT_STORE_DIR_MODE = 0o700;

/**
 * Finding P2/#11 (audit half): rotate once the file exceeds this size,
 * trimming to the most recent `AUDIT_LOG_TRIM_TARGET_LINES` lines. Checked
 * via a cheap `fs.stat` (O(1), not a full read) on every single append; the
 * expensive read-all-lines + atomic-rewrite only actually runs once the cap
 * is crossed, and trimming well under the cap (records are small —
 * ids/sizes/counts) means it won't immediately re-trigger on the next
 * append either. Deliberately simple size/line based bounding, not a
 * time-based retention policy — "keep it simple" per this finding's own
 * scope note.
 */
export const MAX_AUDIT_LOG_BYTES = 10 * 1024 * 1024;
export const AUDIT_LOG_TRIM_TARGET_LINES = 5000;

/**
 * Finding P2 (new, round 2): the hard cap on how many non-terminal-task
 * lifecycle anchors {@link compactPreservingLiveTasks} will ever preserve in
 * a single rotation — without this, a daemon that crashes leaving many
 * non-terminal tasks behind (or a bug that keeps creating tasks that never
 * reach a terminal kind) accumulates one anchor per distinct taskId with no
 * upper bound, defeating `MAX_AUDIT_LOG_BYTES`'s own size cap and turning
 * every subsequent append into an ever-larger O(n) read + atomic-rewrite.
 * Mirrors `daemon/observer.ts`'s `MAX_TRACKED_TASKS`/`task-runner/state.ts`'s
 * `MAX_TRACKED_TASK_IDS` registries: bounded to a generously-sized "a
 * handful of genuinely concurrent tasks never gets close to this" cap, kept
 * the most RECENTLY-touched (by last-seen line index) and dropping the
 * oldest overflow with a single `console.warn` per rotation (not one per
 * dropped anchor — a runaway leak should be visible without spamming the
 * log). A dropped task simply reverts to the pre-round-1 behavior (falls
 * out of `tasks`/`status` once its own events age out of the retained
 * tail) rather than the file growing without bound.
 */
export const MAX_LIVE_TASK_ANCHORS = 500;

/**
 * The line a record occupies in `audit.jsonl` and on `start`'s stdout, without
 * the trailing newline. One serializer for both sinks, so their bytes are
 * identical.
 */
export function formatDaemonRecordLine(record: DaemonRecord): string {
  if (record.kind === 'environment-resolved' && parseEnvironmentRecord(record) === undefined) {
    throw new TypeError('invalid environment-resolved record');
  }
  return JSON.stringify(record);
}

/**
 * Appends one record at 0600, then rotates the file if it has grown past
 * the size cap. Plain `fs.open('a')` + `appendFile` — an append has no
 * torn-read risk; rotation, the one whole-file replace, uses
 * `atomicWriteFile`.
 */
export async function appendAuditRecord(storeDir: string, record: DaemonRecord): Promise<void> {
  const line = formatDaemonRecordLine(record);
  await appendAuditLine(storeDir, line);
}

/** The already-serialized line is immutable while filesystem work is queued. */
async function appendAuditLine(storeDir: string, line: string): Promise<void> {
  await fs.mkdir(storeDir, { recursive: true, mode: AUDIT_STORE_DIR_MODE });
  // `mkdir`'s own `mode` only applies at CREATION time. Re-assert on every
  // append, best-effort: a failure here (e.g. a storeDir owned by a
  // different user) must never block the append itself.
  await fs.chmod(storeDir, AUDIT_STORE_DIR_MODE).catch(() => {});

  const filePath = auditLogPath(storeDir);
  const handle = await fs.open(filePath, 'a', AUDIT_LOG_MODE);
  try {
    // chmod BEFORE appending: `open()`'s `mode` only governs creation, so a
    // pre-existing permissive file is tightened before the new line lands in
    // it, even when the append below then fails.
    await handle.chmod(AUDIT_LOG_MODE);
    await handle.appendFile(`${line}\n`, 'utf8');
  } finally {
    await handle.close();
  }

  await rotateIfNeeded(filePath);
}

/** Record kinds that end a task: a task with one of these anywhere in the file is fully described by it, so none of its earlier lines need to survive a rotation. */
const TERMINAL_RECORD_KINDS = new Set<DaemonRecord['kind']>(['completed', 'failed', 'cancelled']);

/** The task a record anchors, for the kinds that create or move a task row in `deriveTasksFromRecords`. Artifacts and disposal diagnostics never anchor one. */
function lifecycleRecordTaskId(record: DaemonRecord): string | undefined {
  switch (record.kind) {
    case 'outbound-rejected':
      return record.terminal ? record.taskId : undefined;
    case 'offered':
    case 'claimed':
    case 'started':
    case 'turn':
    case 'awaiting-approval':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return record.taskId;
    default:
      return undefined;
  }
}

/**
 * Trims `lines` to the most recent `targetLines`, preserving what the
 * dropped prefix would otherwise erase from `tasks`/`status`:
 *
 * - for every task with no terminal record anywhere in the file whose last
 *   lifecycle record falls in the dropped prefix, that one line (an anchor),
 *   capped at {@link MAX_LIVE_TASK_ANCHORS} — the most recently touched are
 *   kept and one warning is logged per rotation for the overflow;
 * - the latest `environment-resolved`, `runtimes-detected` and `lifecycle` records, which describe
 *   the daemon for as long as it runs (issues #392, #391/#394).
 *
 * Anchors are spliced in before the kept tail, so the file stays oldest
 * first. `kept.length` is bounded by `targetLines + MAX_LIVE_TASK_ANCHORS + 3`.
 */
function compactPreservingLiveTasks(lines: readonly string[], targetLines: number): string[] {
  if (lines.length <= targetLines) return [...lines];

  const cutIndex = lines.length - targetLines; // lines[0, cutIndex) would normally be dropped entirely
  const hasTerminalRecord = new Set<string>();
  const lastIndexForTask = new Map<string, number>();
  let lastEnvironmentIndex: number | undefined;
  let lastLifecycleIndex: number | undefined;
  let lastRuntimesIndex: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    const record = parseRecordLine(lines[i]);
    if (!record) continue;
    if (record.kind === 'environment-resolved') lastEnvironmentIndex = i;
    if (record.kind === 'lifecycle') lastLifecycleIndex = i;
    if (record.kind === 'runtimes-detected') lastRuntimesIndex = i;
    const taskId = lifecycleRecordTaskId(record);
    if (taskId === undefined) continue;
    lastIndexForTask.set(taskId, i);
    if (TERMINAL_RECORD_KINDS.has(record.kind) || (record.kind === 'outbound-rejected' && record.terminal)) hasTerminalRecord.add(taskId);
  }

  let anchorIndices: number[] = [];
  for (const [taskId, lastIndex] of lastIndexForTask) {
    if (hasTerminalRecord.has(taskId)) continue; // reconstructable from its own terminal record, wherever that falls
    if (lastIndex < cutIndex) anchorIndices.push(lastIndex); // otherwise about to be fully evicted
  }
  anchorIndices.sort((a, b) => a - b); // ascending: oldest-touched first, most-recently-touched last

  if (anchorIndices.length > MAX_LIVE_TASK_ANCHORS) {
    const totalCandidates = anchorIndices.length;
    const droppedCount = totalCandidates - MAX_LIVE_TASK_ANCHORS;
    anchorIndices = anchorIndices.slice(-MAX_LIVE_TASK_ANCHORS); // keep the most RECENTLY-touched, drop the oldest overflow
    console.warn(
      `[byok/client] audit log rotation: ${totalCandidates} non-terminal task lifecycle anchors exceeded MAX_LIVE_TASK_ANCHORS (${MAX_LIVE_TASK_ANCHORS}) — dropped the oldest ${droppedCount}, kept the most recently-touched ${MAX_LIVE_TASK_ANCHORS}; dropped tasks will stop appearing in tasks/status once their own records age out of the retained tail`,
    );
  }

  for (const index of [lastEnvironmentIndex, lastLifecycleIndex, lastRuntimesIndex]) {
    if (index !== undefined && index < cutIndex) anchorIndices = [...anchorIndices, index].sort((a, b) => a - b);
  }
  return [...anchorIndices.map((i) => lines[i]), ...lines.slice(cutIndex)].filter((l): l is string => l !== undefined);
}

/** See `MAX_AUDIT_LOG_BYTES` and {@link compactPreservingLiveTasks}. */
async function rotateIfNeeded(filePath: string): Promise<void> {
  let size: number;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    return; // ENOENT or similar — nothing to rotate
  }
  if (size <= MAX_AUDIT_LOG_BYTES) return;

  const lines = await readCompleteLines(filePath);
  const kept = compactPreservingLiveTasks(lines, AUDIT_LOG_TRIM_TARGET_LINES);
  const content = kept.length > 0 ? `${kept.join('\n')}\n` : '';
  // Atomic (temp file + rename), so a concurrent reader never observes a
  // torn file mid-rotation.
  await atomicWriteFile(filePath, content, { mode: AUDIT_LOG_MODE });
}

/**
 * Serializes appends from a synchronous listener. Each `append` is chained
 * onto the previous one, so lines land in call order even though every
 * `fs.open`/`appendFile` is async, and a failed write (reported to
 * `onError`) never breaks the chain for the records after it.
 */
export function createAuditAppender(storeDir: string, onError: (err: unknown) => void = () => {}): AuditAppender {
  let chain: Promise<void> = Promise.resolve();
  return {
    append(record) {
      const line = formatDaemonRecordLine(record);
      chain = chain.then(() => appendAuditLine(storeDir, line)).catch(onError);
      return line;
    },
    flush: () => chain,
  };
}

/** Appends records to `audit.jsonl` in call order; see {@link createAuditAppender}. */
export interface AuditAppender {
  /** Validates, captures and queues the one line synchronously; returns it without a newline for stdout. */
  append(record: DaemonRecord): string;
  /** Resolves once every append queued so far has been written (or reported to `onError`). */
  flush(): Promise<void>;
}

/** The `environment-resolved` record (issue #392), as `status`, `doctor` and the support bundle report it. */
export type EnvironmentRecord = ServiceEnvironmentRecord;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Parses one line into a record, or `undefined` (never throws) for a blank,
 * corrupt or foreign line. A record needs a known kind and a string `ts`; a
 * task record also needs a string `taskId`; `lifecycle` and
 * `environment-resolved` are validated in full, because the offline readers
 * render them.
 */
function parseRecordLine(line: string | undefined): DaemonRecord | undefined {
  const trimmed = line?.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  const raw = asRecord(parsed);
  if (!isDaemonRecordKind(raw.kind) || typeof raw.ts !== 'string') return undefined;
  switch (raw.kind) {
    case 'outbound-rejected': {
      const reason = raw.reason;
      if (typeof reason !== 'string' || !([...OUTBOUND_REFUSAL_REASONS, 'unknown'] as readonly string[]).includes(reason)
        || typeof raw.envelopeId !== 'string' || typeof raw.type !== 'string' || typeof raw.terminal !== 'boolean'
        || (raw.taskId !== undefined && typeof raw.taskId !== 'string')) return undefined;
      const record = {
        kind: 'outbound-rejected' as const,
        ts: raw.ts,
        envelopeId: raw.envelopeId,
        type: raw.type,
        reason: reason as OutboundRefusalReason,
        ...(typeof raw.taskId === 'string' ? { taskId: raw.taskId } : {}),
      };
      if (raw.terminal) {
        if (typeof raw.taskState !== 'string' || !(TASK_STATES as readonly string[]).includes(raw.taskState)) return undefined;
        return { ...record, terminal: true, taskState: raw.taskState as TaskState };
      }
      return { ...record, terminal: false };
    }
    case 'retention-sweep': {
      if (typeof raw.trigger !== 'string' || !['startup', 'periodic', 'pressure', 'home-lease'].includes(raw.trigger)
        || !['deleted', 'bytesReclaimed', 'failures', 'durationMs'].every(key => typeof raw[key] === 'number' && Number.isFinite(raw[key]) && (raw[key] as number) >= 0)
        || typeof raw.truncated !== 'boolean' || raw.at !== raw.ts) return undefined;
      return { kind: 'retention-sweep', ts: raw.ts, trigger: raw.trigger as RetentionTrigger, at: raw.at,
        deleted: raw.deleted as number, bytesReclaimed: raw.bytesReclaimed as number, failures: raw.failures as number,
        truncated: raw.truncated, durationMs: raw.durationMs as number };
    }
    case 'retention-failure': {
      if (typeof raw.trigger !== 'string' || !['startup', 'periodic', 'pressure', 'home-lease'].includes(raw.trigger)
        || ![...EXPIRING_CLASS_IDS, ...PROTECTED_CLASS_IDS].includes(raw.classId as RetentionClassId)
        || typeof raw.code !== 'string' || !['sweep_failed', 'measurement_failed'].includes(raw.code) || !Number.isSafeInteger(raw.count) || (raw.count as number) < 0) return undefined;
      return { kind: 'retention-failure', ts: raw.ts, trigger: raw.trigger as RetentionTrigger, classId: raw.classId as RetentionClassId,
        code: raw.code as string, count: raw.count as number };
    }
    case 'lifecycle': {
      const lifecycle = parseDaemonLifecycle(raw.lifecycle);
      return lifecycle === undefined ? undefined : { kind: 'lifecycle', ts: raw.ts, lifecycle };
    }
    case 'environment-resolved': {
      const environment = parseEnvironmentRecord(raw);
      return environment === undefined ? undefined : { kind: 'environment-resolved', ts: environment.ts, ...environment.status };
    }
    case 'runtimes-detected': {
      const runtimes = parseRuntimeObservations(raw.runtimes);
      // The installed version, the local policy verdict and the executable
      // never enter audit (#1103); a record that carries one is not a record
      // this reader wrote.
      if (runtimes?.some(runtime => runtime.version !== undefined || runtime.versionVerdict !== undefined
        || runtime.executablePath !== undefined || runtime.executableSource !== undefined)) return undefined;
      return runtimes === undefined ? undefined : { kind: 'runtimes-detected', ts: raw.ts, runtimes };
    }
    case 'offered':
    case 'claimed':
    case 'started':
    case 'turn':
    case 'artifact':
    case 'awaiting-approval':
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'stale-approval-decision':
    case 'runtime-disposal-failed':
    case 'execution-record':
      return typeof raw.taskId === 'string' ? (raw as unknown as DaemonRecord) : undefined;
    default:
      return raw as unknown as DaemonRecord;
  }
}

/**
 * Every line that is definitely COMPLETE — every element `raw.split('\n')`
 * produces except the last, which is either `''` (a fully flushed file) or a
 * line a writer has not finished, picked up whole by a later read.
 */
function completeLines(raw: string): string[] {
  const parts = raw.split('\n');
  parts.pop();
  return parts;
}

async function readCompleteLines(filePath: string): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return completeLines(raw);
}

/** Every record, oldest first — `[]` when the log does not exist yet (`start` has never run). Used by `status` and `tasks`. */
export async function readAuditRecords(storeDir: string): Promise<DaemonRecord[]> {
  const records: DaemonRecord[] = [];
  for (const line of await readCompleteLines(auditLogPath(storeDir))) {
    const record = parseRecordLine(line);
    if (record) records.push(record);
  }
  return records;
}

/**
 * The most recent record `pick` accepts, or `undefined` when there is none,
 * no log, or the log is not a regular file. Opened non-blocking and without
 * following a symlink: `doctor`, `service-status` and the support bundle
 * call this, and must not hang on a FIFO planted at the path.
 */
async function readLastRecord<T>(storeDir: string, pick: (record: DaemonRecord) => T | undefined): Promise<T | undefined> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(auditLogPath(storeDir), fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return undefined;
  }
  let raw: string;
  try {
    if (!(await handle.stat()).isFile()) return undefined;
    raw = await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
  const lines = completeLines(raw);
  for (let i = lines.length - 1; i >= 0; i--) {
    const record = parseRecordLine(lines[i]);
    const picked = record === undefined ? undefined : pick(record);
    if (picked !== undefined) return picked;
  }
  return undefined;
}

/** The last `environment-resolved` record (issue #392). */
export function readLastEnvironmentRecord(storeDir: string): Promise<EnvironmentRecord | undefined> {
  return readLastRecord(storeDir, (record) => {
    if (record.kind !== 'environment-resolved') return undefined;
    const { kind: _kind, ts, ...status } = record;
    return { ts, status: status as ServiceEnvironmentStatus };
  });
}

/** The last `lifecycle` record (issue #394), for the offline readers (`doctor`, `service-status`). */
export function readLastLifecycleRecord(storeDir: string): Promise<{ lifecycle: DaemonLifecycle; ts: string } | undefined> {
  return readLastRecord(storeDir, (record) => (record.kind === 'lifecycle' ? { lifecycle: record.lifecycle, ts: record.ts } : undefined));
}
