import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, BlobRef, RuntimeInfo } from '@byok/protocol';
import { type ConnectionState, type DaemonEvent, type DaemonEventListener } from '../index';
import { atomicWriteFile } from '../util/atomic-write';

/**
 * The audit log is the ONLY channel a separate, short-lived CLI invocation
 * (`status`/`tasks`/`tasks --follow`) has into what an already-running
 * `byok-agent start` process has observed — see `byok-agent.ts`'s header
 * comment for the full read-model rationale. One JSON line per
 * `DaemonEvent`, oldest first, append-only.
 *
 * Finding P1 #3 (SECURITY): a `DaemonEvent` can carry a task's raw
 * instruction-derived output — `tool_use.input`/`tool_result.output` are
 * `z.unknown()` in `@byok/protocol` (a shell command, a whole file's
 * contents echoed back, anything), `progress`/`needs_approval`/`completed`/
 * `failed`/`cancelled` all carry free-form agent/operator text, and
 * `artifact.inline` is literally base64 file bytes. Persisting all of that
 * VERBATIM into a durable, append-only, potentially long-retained file —
 * previously created at the default `0666 & umask` mode (NOT 0600), with
 * `storeDir` only chmod'd 0700 at the moment it's first created (a
 * pre-existing custom `storeDir` kept whatever mode it already had) — is
 * exactly the kind of thing that turns "helpful audit trail" into "durable
 * secret/credential/source leak" the moment anything else on the machine can
 * read it. Fixed on two independent axes:
 *
 * 1. **Redaction** (`redactForAudit`/`redactAgentEvent`): only event type,
 *    taskId, timestamps, tool/runtime NAMES, sizes/counts, and closed-enum
 *    state fields are ever written to disk — every free-form text/bytes
 *    field is replaced with its byte SIZE. `readAuditEvents`/`followAuditLog`
 *    reconstruct a `DaemonEvent`-shaped value from that redacted projection
 *    for their callers (`tasks-view.ts`/`format.ts` stay unchanged and none
 *    the wiser) by substituting an unambiguous `[redacted: N bytes]`
 *    placeholder wherever real content used to be — so a replayed
 *    `tasks`/`status`/`tasks --follow` view degrades to showing sizes
 *    instead of content, which is the correct, honest trade-off for a
 *    broadly-readable-by-default durable file. The LIVE human-facing stdout
 *    stream (`bin/commands/start.ts`, fed directly from the in-memory
 *    `DaemonEvent` before it ever reaches this module) is unaffected and
 *    keeps full fidelity — this redaction applies ONLY to what's written to
 *    disk.
 * 2. **Permissions**: the file is tightened to 0600 BEFORE any new content
 *    is written, on every single append (mirrors `util/atomic-write.ts`'s
 *    own defensive re-chmod, for the identical reason: `open()`'s own
 *    `mode` argument only governs permissions at CREATION time, so a
 *    pre-existing file — predating this fix, or loosened by something else
 *    — keeps whatever mode it already had until explicitly chmod'd).
 *    `storeDir` gets the same defensive re-`chmod` to 0700 on every append.
 *
 *    Finding P1 #3b (STILL-OPEN, now fixed): the chmod used to run AFTER
 *    `appendFile` rather than before — for a pre-existing permissive file
 *    that meant the newly-appended line briefly landed in a file that was
 *    still world-readable, and if `appendFile` itself failed, the chmod
 *    (being sequenced after it) never ran at all, leaving the file exactly
 *    as permissive as it started. Fixed by reordering so the chmod always
 *    happens FIRST: there is no window where a new append lands in a
 *    still-permissive file, and the tightening takes effect even when the
 *    append that follows it fails. This closes the gap going forward; it
 *    does NOT retroactively scrub plaintext a pre-fix build of this code
 *    may have already written into an inherited permissive file — only
 *    that the file stops being world-readable from the first append
 *    onward.
 *
 * Finding P2/#11 (audit half): also bounded/rotated now — `appendAuditEvent`
 * checks the file's size (cheap `fs.stat`) on every append and, once it
 * exceeds `MAX_AUDIT_LOG_BYTES`, atomically rewrites it down to the most
 * recent `AUDIT_LOG_TRIM_TARGET_LINES` lines (reusing `atomicWriteFile`, so
 * a concurrent `tasks`/`tasks --follow` read never observes a torn file
 * mid-rotation) — so a long-lived daemon's audit.jsonl no longer grows
 * forever. `followAuditLog` no longer re-reads the entire file every poll
 * either; see its own doc comment.
 *
 * Finding P2 (new, round 1, now fixed): that trim used to be purely
 * positional (the most recent N lines, full stop) — which could evict
 * EVERY event a still-running task ever had if it went quiet for long
 * enough, permanently erasing it from `tasks`/`status` even though it was
 * never actually done. `compactPreservingLiveTasks` now preserves one
 * lifecycle-anchor line for any still-open (non-terminal) task that would
 * otherwise be fully evicted — see its own doc comment.
 *
 * Finding P2 (new, round 2, now fixed): round 1's anchor preservation had no
 * cap of its own — a daemon that crashes leaving many non-terminal tasks
 * behind (or one that keeps creating non-terminal tasks that never reach a
 * terminal kind) accumulates one anchor per distinct non-terminal taskId
 * FOREVER, defeating `MAX_AUDIT_LOG_BYTES`'s own size cap (the whole point
 * of rotation) and making every append past the cap an ever-larger O(n)
 * read + atomic-rewrite. `compactPreservingLiveTasks` now also bounds the
 * anchors themselves to `MAX_LIVE_TASK_ANCHORS`, keeping the most
 * recently-touched ones and dropping the oldest overflow with a single
 * logged warning — see that constant's own doc comment.
 */

export function auditLogPath(storeDir: string): string {
  return path.join(storeDir, 'audit.jsonl');
}

/** 0600: this file can carry tool names, task ids, and sizes/counts derived from potentially sensitive task data — never group/world-readable, same bar as `device.json` (`daemon/store.ts`). */
const AUDIT_LOG_MODE = 0o600;
const AUDIT_STORE_DIR_MODE = 0o700;

/**
 * Finding P2/#11 (audit half): rotate once the file exceeds this size,
 * trimming to the most recent `AUDIT_LOG_TRIM_TARGET_LINES` lines. Checked
 * via a cheap `fs.stat` (O(1), not a full read) on every single append; the
 * expensive read-all-lines + atomic-rewrite only actually runs once the cap
 * is crossed, and trimming well under the cap (redacted lines are small —
 * mostly ids/sizes/counts) means it won't immediately re-trigger on the next
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
 * Mirrors `daemon/observer.ts`'s `MAX_TRACKED_TASKS`/`task-runner.ts`'s
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

function byteSize(text: string | undefined): number | undefined {
  return text === undefined ? undefined : Buffer.byteLength(text, 'utf8');
}

/**
 * Rough serialized-size estimate for an arbitrary (`unknown`) value —
 * `tool_use.input`/`tool_result.output` are typed `z.unknown()` in
 * `@byok/protocol` precisely because a tool's input/output can be anything
 * (a command string, a JSON object, a whole file's contents). `JSON.stringify`
 * can itself throw (a circular structure, a lone BigInt) — caught
 * defensively since this is only ever a size ESTIMATE for the audit trail,
 * never allowed to break the append it's part of.
 */
function valueByteSize(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(value);
    return json === undefined ? undefined : Buffer.byteLength(json, 'utf8');
  } catch {
    return undefined;
  }
}

/** Unambiguous, never-confusable-with-real-content marker substituted for a redacted text/bytes field on READ (see `reconstructDaemonEvent`/`reconstructAgentEvent`) — never written to disk itself (only the size is). */
function placeholderFor(size: number | undefined): string {
  return size === undefined ? '[redacted]' : `[redacted: ${size} bytes]`;
}

/** Git failures are serialized only as this closed, stable category set — never raw Git errors or command output. */
const STABLE_GIT_ERROR_CATEGORIES = new Set([
  'git-unavailable',
  'git-timeout',
  'git-output-limit',
  'git-command-failed',
  'workspace-root-invalid',
  'workspace-root-conflict',
  'workspace-not-owned',
  'repository-root-mismatch',
  'repository-invalid',
  'lease-busy',
  'ledger-invalid',
]);

function stableGitErrorCategory(value: unknown): string | undefined {
  return typeof value === 'string' && STABLE_GIT_ERROR_CATEGORIES.has(value) ? value : undefined;
}

function gitCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function gitDirty(value: unknown): { staged: number; unstaged: number; untracked: number; conflicted: number } | undefined {
  const dirty = asRecord(value);
  const staged = gitCount(dirty.staged);
  const unstaged = gitCount(dirty.unstaged);
  const untracked = gitCount(dirty.untracked);
  const conflicted = gitCount(dirty.conflicted);
  return staged !== undefined && unstaged !== undefined && untracked !== undefined && conflicted !== undefined
    ? { staged, unstaged, untracked, conflicted }
    : undefined;
}

/**
 * Finding P1 #3: the redacted projection of a `task.progress`-derived
 * `AgentEvent` that's actually written to disk — every free-form field
 * (`text`/`input`/`output`/`summary`/`message`) becomes a `*Size` byte count;
 * `tool`/`name`/`contentType` (identifiers, not content) and `usage`'s token
 * COUNTS survive verbatim.
 */
function redactAgentEvent(event: AgentEvent): Record<string, unknown> {
  switch (event.type) {
    case 'progress':
      return { type: 'progress', textSize: byteSize(event.text) };
    case 'tool_use':
      return { type: 'tool_use', tool: event.tool, inputSize: valueByteSize(event.input) };
    case 'tool_result':
      return { type: 'tool_result', tool: event.tool, outputSize: valueByteSize(event.output) };
    case 'artifact':
      return { type: 'artifact', name: event.name, contentType: event.contentType };
    case 'needs_approval':
      return { type: 'needs_approval', summarySize: byteSize(event.summary) };
    case 'turn_end':
      return { type: 'turn_end' };
    case 'error':
      return { type: 'error', messageSize: byteSize(event.message) };
    case 'usage':
      return {
        type: 'usage',
        inputTokens: event.inputTokens,
        cachedInputTokens: event.cachedInputTokens,
        outputTokens: event.outputTokens,
        reasoningTokens: event.reasoningTokens,
        totalTokens: event.totalTokens,
      };
  }
}

/**
 * Finding P1 #3: the redacted projection of a `DaemonEvent` that's actually
 * written to disk. See this file's module doc comment for the full
 * rationale; `reconstructDaemonEvent` is this function's read-side inverse.
 */
function redactForAudit(event: DaemonEvent): Record<string, unknown> {
  const base = { kind: event.kind, ts: event.ts };
  switch (event.kind) {
    case 'offered':
      return { ...base, taskId: event.taskId, runtime: event.runtime };
    case 'claimed':
      return { ...base, taskId: event.taskId };
    case 'started':
      return { ...base, taskId: event.taskId };
    case 'progress':
      return { ...base, taskId: event.taskId, event: redactAgentEvent(event.event) };
    case 'artifact':
      return {
        ...base,
        taskId: event.taskId,
        name: event.name,
        contentType: event.contentType,
        // `inline` is base64 file bytes (up to the 64KB inline cap) — never
        // persisted. `blobRef.url` is a presigned URL — itself effectively a
        // time-limited bearer credential for the actual bytes, so it's
        // dropped too; only the safe pointer/size metadata survives.
        inlineSize: byteSize(event.inline),
        blobRef: event.blobRef
          ? {
              blobId: event.blobRef.blobId,
              contentHash: event.blobRef.contentHash,
              size: event.blobRef.size,
              contentType: event.blobRef.contentType,
            }
          : undefined,
      };
    case 'awaiting-approval':
      return { ...base, taskId: event.taskId, summarySize: byteSize(event.summary) };
    case 'completed':
      return { ...base, taskId: event.taskId, summarySize: byteSize(event.summary), sessionRef: event.sessionRef };
    case 'failed':
      return {
        ...base,
        taskId: event.taskId,
        reasonSize: byteSize(event.reason),
        retryable: event.retryable,
        preClaim: event.preClaim,
      };
    case 'cancelled':
      return { ...base, taskId: event.taskId, reasonSize: byteSize(event.reason) };
    case 'connection':
      return { ...base, state: event.state };
    case 'paired':
      return { ...base, deviceId: event.deviceId };
    case 'unpaired':
      return { ...base };
    case 'runtimes-detected':
      return { ...base, runtimes: event.runtimes };
    case 'shutdown-requested':
      // Not sensitive/free-form the way task instruction/output text is —
      // this is an internally-constructed operational message (see
      // `create-daemon.ts`'s control-socket shutdown wiring), so it's kept
      // verbatim rather than redacted to a size.
      return { ...base, reason: event.reason };
    case 'shutdown-complete':
      // Finding R3 (cross-model re-review): `undeliveredOutboxCount`
      // (finding F5(b)) is a plain NUMBER, not free-form text — no
      // redaction concern at all — but this branch used to share the
      // `shutdown-requested` case above verbatim, which only ever copied
      // `reason` across, silently dropping this field on every persisted
      // write. A replayed `tasks --follow`/audit read therefore always saw
      // `undeliveredOutboxCount: undefined`, indistinguishable from "0
      // undelivered" — exactly the false "everything was delivered"
      // impression F5(b) exists to prevent. See `reconstructDaemonEvent`'s
      // own `shutdown-complete` case for the read-side symmetry this needs.
      return { ...base, reason: event.reason, undeliveredOutboxCount: event.undeliveredOutboxCount };
    case 'stale-approval-decision':
      // `reason` here is an operator-supplied free-text reject reason (same
      // redaction rule as `failed`/`cancelled` above) — `decision` is just
      // the fixed 'approve'|'reject' identifier, kept verbatim.
      return { ...base, taskId: event.taskId, decision: event.decision, reasonSize: byteSize(event.reason) };
    case 'git-workspace':
      // Git observations are deliberately coarse: paths, commit ids,
      // filenames, messages, raw Git output, and free-form errors never cross
      // this boundary. The opaque workspaceId is safe to retain for correlation.
      return {
        ...base,
        taskId: event.taskId,
        workspaceId: event.workspaceId,
        phase: event.phase,
        headChanged: event.headChanged,
        commitsSinceBaseline: event.commitsSinceBaseline,
        dirty: event.dirty,
        errorCategory: stableGitErrorCategory(event.errorCategory),
      };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Read-side inverse of {@link redactAgentEvent}: reconstructs an `AgentEvent`-SHAPED value with a `[redacted: N bytes]` placeholder wherever real content used to be. An unrecognized/corrupt inner `type` degrades to a harmless opaque `error` event rather than throwing — mirrors this whole module's "never let one bad line break the read" contract. */
function reconstructAgentEvent(raw: unknown): AgentEvent {
  const r = asRecord(raw);
  const type = str(r.type);
  switch (type) {
    case 'progress':
      return { type: 'progress', text: placeholderFor(num(r.textSize)) };
    case 'tool_use':
      return { type: 'tool_use', tool: str(r.tool), input: placeholderFor(num(r.inputSize)) };
    case 'tool_result':
      return { type: 'tool_result', tool: str(r.tool), output: placeholderFor(num(r.outputSize)) };
    case 'artifact':
      return { type: 'artifact', name: str(r.name), contentType: str(r.contentType) };
    case 'needs_approval':
      return { type: 'needs_approval', summary: placeholderFor(num(r.summarySize)) };
    case 'turn_end':
      return { type: 'turn_end' };
    case 'error':
      return { type: 'error', message: placeholderFor(num(r.messageSize)) };
    case 'usage':
      return {
        type: 'usage',
        inputTokens: num(r.inputTokens),
        cachedInputTokens: num(r.cachedInputTokens),
        outputTokens: num(r.outputTokens),
        reasoningTokens: num(r.reasoningTokens),
        totalTokens: num(r.totalTokens),
      };
    default:
      return { type: 'error', message: `[unrecognized audit event type: ${type || '(missing)'}]` };
  }
}

/** Read-side inverse of {@link redactForAudit} — see this file's module doc comment. `raw` has already passed {@link isAuditRecordShaped} (has string `kind`/`ts`) by the time this is called; an unrecognized `kind` (corrupt line, or a future version's new kind) returns `undefined` and is dropped by the caller like any other bad line. */
function reconstructDaemonEvent(raw: Record<string, unknown>): DaemonEvent | undefined {
  const kind = str(raw.kind);
  const ts = str(raw.ts);
  switch (kind) {
    case 'offered':
      return { kind: 'offered', ts, taskId: str(raw.taskId), runtime: typeof raw.runtime === 'string' ? raw.runtime : undefined };
    case 'claimed':
      return { kind: 'claimed', ts, taskId: str(raw.taskId) };
    case 'started':
      return { kind: 'started', ts, taskId: str(raw.taskId) };
    case 'progress':
      return { kind: 'progress', ts, taskId: str(raw.taskId), event: reconstructAgentEvent(raw.event) };
    case 'artifact': {
      const blobRefPresent = raw.blobRef !== undefined && raw.blobRef !== null;
      const blobRefRaw = asRecord(raw.blobRef);
      const blobRef: BlobRef | undefined = blobRefPresent
        ? {
            blobId: str(blobRefRaw.blobId),
            contentHash: str(blobRefRaw.contentHash),
            size: num(blobRefRaw.size) ?? 0,
            contentType: str(blobRefRaw.contentType),
          }
        : undefined;
      const inlineSize = num(raw.inlineSize);
      return {
        kind: 'artifact',
        ts,
        taskId: str(raw.taskId),
        name: str(raw.name),
        contentType: str(raw.contentType),
        inline: inlineSize === undefined ? undefined : placeholderFor(inlineSize),
        blobRef,
      };
    }
    case 'awaiting-approval':
      return { kind: 'awaiting-approval', ts, taskId: str(raw.taskId), summary: placeholderFor(num(raw.summarySize)) };
    case 'completed':
      return {
        kind: 'completed',
        ts,
        taskId: str(raw.taskId),
        summary: placeholderFor(num(raw.summarySize)),
        sessionRef: str(raw.sessionRef),
      };
    case 'failed':
      return {
        kind: 'failed',
        ts,
        taskId: str(raw.taskId),
        reason: placeholderFor(num(raw.reasonSize)),
        retryable: bool(raw.retryable, false),
        preClaim: typeof raw.preClaim === 'boolean' ? raw.preClaim : undefined,
      };
    case 'cancelled': {
      const reasonSize = num(raw.reasonSize);
      return {
        kind: 'cancelled',
        ts,
        taskId: str(raw.taskId),
        reason: reasonSize === undefined ? undefined : placeholderFor(reasonSize),
      };
    }
    case 'connection':
      return { kind: 'connection', ts, state: str(raw.state) as ConnectionState };
    case 'paired':
      return { kind: 'paired', ts, deviceId: str(raw.deviceId) };
    case 'unpaired':
      return { kind: 'unpaired', ts };
    case 'runtimes-detected':
      return { kind: 'runtimes-detected', ts, runtimes: Array.isArray(raw.runtimes) ? (raw.runtimes as RuntimeInfo[]) : [] };
    case 'shutdown-requested':
      return { kind: 'shutdown-requested', ts, reason: str(raw.reason) };
    case 'shutdown-complete':
      // Finding R3: read-side symmetry with `redactForAudit`'s own
      // `shutdown-complete` case — `undeliveredOutboxCount` is a plain
      // number, reconstructed verbatim (never a placeholder — there was
      // never anything to redact here), `undefined` only for an
      // audit-log line written before this fix existed (or a
      // corrupt/non-numeric value).
      return { kind: 'shutdown-complete', ts, reason: str(raw.reason), undeliveredOutboxCount: num(raw.undeliveredOutboxCount) };
    case 'stale-approval-decision': {
      const reasonSize = num(raw.reasonSize);
      return {
        kind: 'stale-approval-decision',
        ts,
        taskId: str(raw.taskId),
        decision: str(raw.decision) as 'approve' | 'reject',
        reason: reasonSize === undefined ? undefined : placeholderFor(reasonSize),
      };
    }
    case 'git-workspace': {
      const commitsSinceBaseline = gitCount(raw.commitsSinceBaseline);
      const dirty = gitDirty(raw.dirty);
      return {
        kind: 'git-workspace',
        ts,
        taskId: str(raw.taskId),
        workspaceId: str(raw.workspaceId),
        phase: str(raw.phase),
        headChanged: typeof raw.headChanged === 'boolean' ? raw.headChanged : undefined,
        commitsSinceBaseline,
        dirty,
        errorCategory: stableGitErrorCategory(raw.errorCategory),
      };
    }
    default:
      return undefined;
  }
}

/**
 * Appends one `DaemonEvent` as a single redacted JSON line (finding P1 #3 —
 * see this file's module doc comment) at 0600, and rotates the file if it's
 * grown past the size cap (finding P2/#11). Plain `fs.open('a')` +
 * `appendFile` — sufficient for an append-only log (no torn-read risk the
 * way a whole-file replace has; see `util/atomic-write.ts`'s own doc comment
 * for why THAT helper exists for whole-file writes instead of just being
 * used here too — rotation below is the one path in this file that DOES
 * replace the whole file, and does use it).
 */
export async function appendAuditEvent(storeDir: string, event: DaemonEvent): Promise<void> {
  await fs.mkdir(storeDir, { recursive: true, mode: AUDIT_STORE_DIR_MODE });
  // `mkdir`'s own `mode` only applies at CREATION time — a pre-existing
  // storeDir (predating this fix, or created by something else with a more
  // permissive mode) keeps whatever it already had. Re-assert explicitly on
  // every append, best-effort: this directory also holds device.json/cursor
  // state, so locking it down helps those as a side effect, but a failure
  // here (e.g. a storeDir owned by a different user) must never block the
  // append itself.
  await fs.chmod(storeDir, AUDIT_STORE_DIR_MODE).catch(() => {});

  const filePath = auditLogPath(storeDir);
  const line = `${JSON.stringify(redactForAudit(event))}\n`;
  const handle = await fs.open(filePath, 'a', AUDIT_LOG_MODE);
  try {
    // Finding P1 #3b: chmod BEFORE appending, not after. `open()`'s own
    // `mode` argument only governs permissions at file-CREATION time, so a
    // PRE-EXISTING file (predating this fix, or loosened by something else)
    // keeps whatever mode it already had until explicitly chmod'd here —
    // doing that FIRST means there is never a window where the line we're
    // about to write lands in a still-permissive file, and the tightening
    // still takes effect even if the `appendFile` below then fails (it's no
    // longer gated behind a write that might throw before ever reaching
    // it). Mirrors `util/atomic-write.ts`'s own defensive re-chmod, for the
    // identical reason (don't trust "governed at creation only" for a file
    // that can carry sensitive metadata).
    await handle.chmod(AUDIT_LOG_MODE);
    await handle.appendFile(line, 'utf8');
  } finally {
    await handle.close();
  }

  await rotateIfNeeded(filePath);
}

/**
 * `DaemonEvent.kind`s that end a task's lifecycle — once one of these
 * appears anywhere for a taskId, `deriveTasksFromEvents` (`tasks-view.ts`)
 * can reconstruct that task's final state from that ONE event alone
 * (`upsert` seeds a fresh record from whatever patch a terminal event
 * carries), so no earlier event of its needs to survive a rotation. A small
 * local set rather than importing from `@byok/protocol`/`tasks-view.ts`:
 * those describe reducer OUTPUT states, not `DaemonEvent.kind`s, and only
 * these three kinds ever end a task (mirrors `tasks-view.ts`'s own
 * `deriveTasksFromEvents` switch).
 */
const TERMINAL_EVENT_KINDS = new Set(['completed', 'failed', 'cancelled']);

function eventTaskId(event: DaemonEvent): string | undefined {
  // Git observations are audit metadata, never task lifecycle events. In
  // particular they must not keep an otherwise-evicted task alive during
  // rotation or manufacture a task in the replay reducer.
  if (event.kind === 'git-workspace') return undefined;
  return 'taskId' in event ? event.taskId : undefined;
}

/**
 * Finding P2 (new, round 1): a pure positional "keep the last N lines" trim
 * can evict EVERY event a still-running (non-terminal) task ever had — if a
 * task's `offered`/`started`/`progress` events are all old enough to fall
 * in the dropped prefix, and it hasn't reached a terminal kind
 * (`completed`/`failed`/`cancelled`) anywhere in the file, there is
 * nothing left for `deriveTasksFromEvents` to reconstruct it from —
 * `tasks`/`status` silently forget a task that is still actually running.
 *
 * Deliberately simple (a full retention policy is more than this finding's
 * own scope calls for): scan every line once, tracking per taskId whether
 * a terminal kind occurs anywhere in the file and the index of its LAST
 * occurrence. Any taskId with no terminal kind whose last occurrence falls
 * in the portion about to be dropped gets exactly that one line preserved
 * — spliced in immediately before the kept tail (so the file stays
 * oldest-first overall, matching every other invariant this module
 * documents) as a lifecycle anchor. That's just enough for the reducer to
 * know the task exists and its last-known state; it does NOT preserve that
 * task's entire historical event stream (which could itself be unbounded
 * for a long-running task with many `progress` events — preserving all of
 * it would defeat the point of rotation). A task that already reached a
 * terminal kind needs no anchor at all: it's fully reconstructable from
 * that one terminal event, wherever it happens to fall.
 *
 * Finding P2 (new, round 2): round 1's anchor count had no cap of its own —
 * bounded by "the number of DISTINCT non-terminal tasks old enough to be
 * affected", which in realistic operation is small, but is NOT actually
 * bounded when a daemon crashes leaving many non-terminal tasks behind, or
 * a bug keeps creating tasks that never reach a terminal kind. Anchors are
 * now additionally capped at {@link MAX_LIVE_TASK_ANCHORS}: once the number
 * of candidate anchors exceeds it, only the most RECENTLY-touched ones (by
 * last-seen line index) are kept, the oldest overflow is dropped, and a
 * single warning is logged for the whole rotation (not once per dropped
 * anchor). This keeps `kept.length` bounded by `targetLines +
 * MAX_LIVE_TASK_ANCHORS` in the worst case — still slightly over
 * `targetLines`, by design (see round 1's own trade-off), but no longer
 * unboundedly so. Self-correcting either way: once an anchored task reaches
 * a terminal kind, a later rotation stops preserving it at all.
 */
function compactPreservingLiveTasks(lines: readonly string[], targetLines: number): string[] {
  if (lines.length <= targetLines) return [...lines];

  const cutIndex = lines.length - targetLines; // lines[0, cutIndex) would normally be dropped entirely
  const hasTerminalEvent = new Set<string>();
  const lastIndexForTask = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const event = parseAuditLine(line);
    if (!event) continue;
    const taskId = eventTaskId(event);
    if (taskId === undefined) continue;
    lastIndexForTask.set(taskId, i);
    if (TERMINAL_EVENT_KINDS.has(event.kind)) hasTerminalEvent.add(taskId);
  }

  let anchorIndices: number[] = [];
  for (const [taskId, lastIndex] of lastIndexForTask) {
    if (hasTerminalEvent.has(taskId)) continue; // reconstructable from its own terminal event, wherever that falls
    if (lastIndex < cutIndex) anchorIndices.push(lastIndex); // otherwise about to be fully evicted
  }
  anchorIndices.sort((a, b) => a - b); // ascending: oldest-touched first, most-recently-touched last

  if (anchorIndices.length > MAX_LIVE_TASK_ANCHORS) {
    const totalCandidates = anchorIndices.length;
    const droppedCount = totalCandidates - MAX_LIVE_TASK_ANCHORS;
    anchorIndices = anchorIndices.slice(-MAX_LIVE_TASK_ANCHORS); // keep the most RECENTLY-touched, drop the oldest overflow
    console.warn(
      `[byok/client] audit log rotation: ${totalCandidates} non-terminal task lifecycle anchors exceeded MAX_LIVE_TASK_ANCHORS (${MAX_LIVE_TASK_ANCHORS}) — dropped the oldest ${droppedCount}, kept the most recently-touched ${MAX_LIVE_TASK_ANCHORS}; dropped tasks will stop appearing in tasks/status once their own events age out of the retained tail`,
    );
  }

  return [...anchorIndices.map((i) => lines[i]), ...lines.slice(cutIndex)].filter((l): l is string => l !== undefined);
}

/** Finding P2/#11 (audit half): see `MAX_AUDIT_LOG_BYTES`'s own doc comment. Finding P2 (new): see {@link compactPreservingLiveTasks}. */
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
  // Atomic (temp file + rename) so a concurrent `readAuditEvents`/
  // `followAuditLog` reader never observes a torn/partial file mid-rotation
  // — same helper `daemon/store.ts`/`daemon/cursor-store.ts` use for their
  // own whole-file replaces.
  await atomicWriteFile(filePath, content, { mode: AUDIT_LOG_MODE });
}

/**
 * Adapts {@link appendAuditEvent} into a `DaemonEventListener` for
 * `daemon.subscribe()` (used by the `start` command). `DaemonEventListener`
 * is synchronous — `observer.ts`'s `emit()` never awaits a listener (see its
 * own doc comment on why, including the finding #6 async-safety fix) — so a
 * naive fire-and-forget `appendAuditEvent(...).catch(...)` per call would
 * have a real problem: the underlying `fs.open`/`appendFile` calls could
 * complete OUT OF ORDER under load, silently corrupting the log's own event
 * ordering. This chains each append onto the previous one (still
 * async/non-blocking from the listener's point of view) so writes always
 * land in emission order, and a failed write (reported via `onError`) never
 * breaks the chain for subsequent events.
 */
export function createAuditAppender(storeDir: string, onError: (err: unknown) => void = () => {}): DaemonEventListener {
  let chain: Promise<void> = Promise.resolve();
  return (event: DaemonEvent) => {
    chain = chain.then(() => appendAuditEvent(storeDir, event)).catch(onError);
  };
}

function isAuditRecordShaped(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string' &&
    typeof (value as { ts?: unknown }).ts === 'string'
  );
}

/** Parses one line; returns `undefined` (never throws) for a blank, corrupt, or unrecognized-kind line so one bad line can't take down a whole `status`/`tasks` read. Reconstructs a `DaemonEvent`-shaped value from the redacted on-disk projection — see the module doc comment. */
function parseAuditLine(line: string): DaemonEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!isAuditRecordShaped(parsed)) return undefined;
    return reconstructDaemonEvent(parsed);
  } catch {
    return undefined;
  }
}

/**
 * Every line that's definitely COMPLETE — i.e. every line except the last
 * element `raw.split('\n')` produces, which is either `''` (when `raw` ends
 * with `\n`, the normal fully-flushed case) or a genuinely not-yet-terminated
 * partial line (when `raw` was read mid-write). Dropping that last element
 * either way means a `--follow` reader can never observe — and thus never
 * permanently skip — a torn line from a write it caught mid-flush; it just
 * gets picked up whole on a later poll once the writer finishes it.
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

/** Full historical read (oldest first) — `[]` if the log doesn't exist yet (e.g. `start` has never run). Used by `status`/`tasks` (no `--follow`). */
export async function readAuditEvents(storeDir: string): Promise<DaemonEvent[]> {
  const lines = await readCompleteLines(auditLogPath(storeDir));
  const events: DaemonEvent[] = [];
  for (const line of lines) {
    const event = parseAuditLine(line);
    if (event) events.push(event);
  }
  return events;
}

export interface FollowOptions {
  signal: AbortSignal;
  /** How often to check the file for new bytes. Default 200ms — plenty responsive for a human tailing output, without busy-looping. */
  pollIntervalMs?: number;
  /**
   * `true` (default): start at the file's CURRENT length — a `tail -f`,
   * streaming only events appended from the moment `followAuditLog` was
   * called. `false`: replay the full existing log first, then keep
   * streaming — mainly useful for tests that want both in one pass.
   */
  fromEnd?: boolean;
}

/** Cancellable delay: resolves early the instant `signal` aborts, so a follow loop stops promptly instead of waiting out a full poll interval. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Tails `filePath` (the audit log) for newly-appended `DaemonEvent` lines
 * until `options.signal` aborts. No native filesystem-event watching (no
 * `fs.watch` — inconsistent across platforms, especially the rename-based
 * atomic writes this package uses elsewhere for OTHER files).
 *
 * Finding P2/#11 (audit half): the previous implementation re-read the
 * ENTIRE file from byte 0 on every single poll, re-parsing every
 * already-emitted line just to find the handful of new ones at the end —
 * O(file size) work every `pollIntervalMs`, forever, for as long as
 * `tasks --follow` stays attached. This tracks a byte OFFSET across polls
 * instead: each poll opens the file and reads only the bytes appended since
 * the last read (`FileHandle.read` at a specific position), advancing
 * `offset` by exactly that many bytes — only genuinely new bytes are ever
 * read or decoded.
 *
 * UTF-8 safety: the new bytes are split on the RAW BYTE `0x0a` ('\n')
 * BEFORE any UTF-8 decoding happens, not on an already-decoded string —
 * `0x0A` can only ever appear as an actual newline in valid UTF-8
 * (continuation bytes are always `0x80`-`0xBF`), so this never risks
 * decoding a torn multi-byte character that happened to straddle a chunk
 * boundary. Bytes after the last `\n` in a chunk are held in `pending`
 * (as a `Buffer`, still undecoded) until a future poll's bytes complete
 * that line — mirrors `completeLines`'s existing "never guess at a torn
 * trailing line" contract for `readAuditEvents`, just incremental.
 *
 * Rotation tolerance: if `appendAuditEvent`'s own size-cap rotation (or
 * anything else) replaces the file out from under an in-progress follow,
 * `offset` resets to 0 and `pending` is cleared — the follow session
 * survives (rather than throwing or garbling) at the cost of re-emitting
 * the post-rotation file's retained lines as if they were new.
 *
 * Finding P2 (new): that replacement is detected by file IDENTITY
 * (`dev:ino`), not by comparing sizes. The previous implementation only
 * reset `offset` when the new file was SMALLER than it (`st.size <
 * offset`) — sufficient for the common case (a big pre-rotation file
 * trimmed down to a small one), but `rotateIfNeeded`'s replace is an atomic
 * temp-file + `fs.rename` (see `atomicWriteFile`), which swaps the
 * underlying INODE regardless of whether the new file happens to be
 * smaller OR LARGER than the reader's current offset. A `--follow` session
 * that attached while the log was still tiny (a small `offset`) can have a
 * rotation land a compacted-but-still-much-bigger-than-that-tiny-offset
 * file in its place — the old size-only check missed exactly that case
 * (`st.size < offset` was false), so it kept reading from the stale
 * `offset` INTO THE NEW FILE's bytes: skipping that file's own prefix
 * entirely and very likely starting mid-JSON-line. Tracking `dev:ino`
 * across polls catches ANY replacement — smaller, larger, anything — and
 * resets `offset` to 0 so the new file is always re-read from its own
 * start. The size-based check is kept as a secondary fallback (a
 * same-identity in-place truncate, or a platform where `ino` isn't a
 * reliable identity signal).
 */
export async function followAuditLog(
  filePath: string,
  onEvent: (event: DaemonEvent) => void,
  options: FollowOptions,
): Promise<void> {
  const { signal, pollIntervalMs = 200, fromEnd = true } = options;

  let offset = 0;
  // Explicit `Buffer` (not the narrower type `Buffer.alloc(0)` alone would
  // infer): this gets reassigned from `Buffer.concat`/`.subarray`, whose
  // return types don't always narrow identically across @types/node
  // versions — the plain `Buffer` alias covers all of them.
  let pending: Buffer = Buffer.alloc(0);
  // Finding P2 (new): `dev:ino` of the file `offset` was last measured
  // against — `undefined` until the first successful stat of an existing
  // file. See this function's own doc comment ("Rotation tolerance").
  let lastFileIdentity: string | undefined;

  if (fromEnd) {
    try {
      const st = await fs.stat(filePath);
      offset = st.size;
      lastFileIdentity = `${st.dev}:${st.ino}`;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      offset = 0;
    }
  }

  async function readNewBytes(): Promise<Buffer> {
    let handle;
    try {
      handle = await fs.open(filePath, 'r');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
      throw err;
    }
    try {
      const st = await handle.stat();
      const identity = `${st.dev}:${st.ino}`;
      if (lastFileIdentity !== undefined && identity !== lastFileIdentity) {
        // The file at this path was replaced (e.g. an atomic rotation)
        // since our last read — a different inode means our byte offset no
        // longer means anything for THIS file's bytes, regardless of
        // whether the new file is smaller OR LARGER than the old offset
        // (a purely size-based check misses the latter — finding P2 (new)).
        offset = 0;
        pending = Buffer.alloc(0);
      } else if (st.size < offset) {
        // Same identity but shrunk (e.g. truncated in place rather than
        // replaced) — keep the original size-based fallback for that case,
        // and as a safety net on a platform where `ino` isn't reliable.
        offset = 0;
        pending = Buffer.alloc(0);
      }
      lastFileIdentity = identity;
      if (st.size <= offset) return Buffer.alloc(0);
      const length = st.size - offset;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      offset += bytesRead;
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  while (!signal.aborted) {
    const chunk = await readNewBytes();
    if (chunk.length > 0) {
      const combined = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      const lastNewline = combined.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        pending = combined;
      } else {
        const completeText = combined.subarray(0, lastNewline + 1).toString('utf8');
        pending = Buffer.from(combined.subarray(lastNewline + 1));
        for (const line of completeText.split('\n')) {
          if (!line) continue;
          const event = parseAuditLine(line);
          if (event) onEvent(event);
        }
      }
    }

    if (signal.aborted) break;
    await delay(pollIntervalMs, signal);
  }
}
