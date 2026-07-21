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
 * 2. **Permissions**: the file is opened/created at 0600 and that mode is
 *    re-asserted via an explicit `chmod` on every append (mirrors
 *    `util/atomic-write.ts`'s own defensive re-chmod, for the identical
 *    reason: `open()`'s own `mode` argument only governs permissions at
 *    creation time). `storeDir` gets the same defensive re-`chmod` to 0700 on
 *    every append.
 *
 * Finding P2/#11 (audit half): also bounded/rotated now — `appendAuditEvent`
 * checks the file's size (cheap `fs.stat`) on every append and, once it
 * exceeds `MAX_AUDIT_LOG_BYTES`, atomically rewrites it down to the most
 * recent `AUDIT_LOG_TRIM_TARGET_LINES` lines (reusing `atomicWriteFile`, so
 * a concurrent `tasks`/`tasks --follow` read never observes a torn file
 * mid-rotation) — so a long-lived daemon's audit.jsonl no longer grows
 * forever. `followAuditLog` no longer re-reads the entire file every poll
 * either; see its own doc comment.
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
    await handle.appendFile(line, 'utf8');
    // Same reasoning as `mkdir`'s mode above: `open()`'s own `mode` argument
    // only governs permissions at file-CREATION time. Re-assert 0600 on
    // every single append — mirrors `util/atomic-write.ts`'s own defensive
    // re-chmod, for the identical reason (don't trust "governed at creation
    // only" for a file that can carry sensitive metadata).
    await handle.chmod(AUDIT_LOG_MODE);
  } finally {
    await handle.close();
  }

  await rotateIfNeeded(filePath);
}

/** Finding P2/#11 (audit half): see `MAX_AUDIT_LOG_BYTES`'s own doc comment. */
async function rotateIfNeeded(filePath: string): Promise<void> {
  let size: number;
  try {
    size = (await fs.stat(filePath)).size;
  } catch {
    return; // ENOENT or similar — nothing to rotate
  }
  if (size <= MAX_AUDIT_LOG_BYTES) return;

  const lines = await readCompleteLines(filePath);
  const kept = lines.slice(-AUDIT_LOG_TRIM_TARGET_LINES);
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
 * anything else) replaces the file with a SMALLER one out from under an
 * in-progress follow, `offset` resets to 0 and `pending` is cleared — the
 * follow session survives (rather than throwing) at the cost of re-emitting
 * the post-rotation file's retained lines as if they were new, identical in
 * spirit to the previous implementation's own tolerance for this exact
 * "log replaced/truncated out from under us" case.
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

  if (fromEnd) {
    try {
      offset = (await fs.stat(filePath)).size;
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
      if (st.size < offset) {
        // Truncated/replaced (e.g. a rotation) out from under us — reset
        // rather than throw; see this function's own doc comment.
        offset = 0;
        pending = Buffer.alloc(0);
      }
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
