import { promises as fs } from 'node:fs';
import path from 'node:path';
import { type DaemonEvent, type DaemonEventListener } from '../index';

/**
 * The audit log is the ONLY channel a separate, short-lived CLI invocation
 * (`status`/`tasks`/`tasks --follow`) has into what an already-running
 * `byok-agent start` process has observed — see `byok-agent.ts`'s header
 * comment for the full read-model rationale. One JSON line per
 * `DaemonEvent`, oldest first, append-only. Bounded/rotated is a documented
 * nice-to-have this module doesn't implement (see the M3-2b task notes) —
 * `readAuditEvents`/`followAuditLog` are the two things worth revisiting
 * first if that ever becomes necessary (e.g. only reading the tail of a
 * very large file).
 */

export function auditLogPath(storeDir: string): string {
  return path.join(storeDir, 'audit.jsonl');
}

/**
 * Appends one `DaemonEvent` as a single JSON line. Plain `fs.appendFile` —
 * sufficient for an append-only log (no torn-read risk the way a
 * whole-file replace has; see `util/atomic-write.ts`'s own doc comment for
 * why THAT helper exists for whole-file writes instead of just being used
 * here too).
 */
export async function appendAuditEvent(storeDir: string, event: DaemonEvent): Promise<void> {
  await fs.mkdir(storeDir, { recursive: true, mode: 0o700 });
  await fs.appendFile(auditLogPath(storeDir), `${JSON.stringify(event)}\n`, 'utf8');
}

/**
 * Adapts {@link appendAuditEvent} into a `DaemonEventListener` for
 * `daemon.subscribe()` (used by the `start` command). `DaemonEventListener`
 * is synchronous — `observer.ts`'s `emit()` only catches a listener that
 * throws SYNCHRONOUSLY, never a rejected Promise — so a naive
 * fire-and-forget `appendAuditEvent(...).catch(...)` per call would have two
 * problems: an unhandled rejection is never actually a risk (we do attach
 * `.catch`), but the underlying `fs.appendFile` calls could complete OUT OF
 * ORDER under load, silently corrupting the log's own event ordering. This
 * chains each append onto the previous one (still async/non-blocking from
 * the listener's point of view) so writes always land in emission order,
 * and a failed write (reported via `onError`) never breaks the chain for
 * subsequent events.
 */
export function createAuditAppender(storeDir: string, onError: (err: unknown) => void = () => {}): DaemonEventListener {
  let chain: Promise<void> = Promise.resolve();
  return (event: DaemonEvent) => {
    chain = chain.then(() => appendAuditEvent(storeDir, event)).catch(onError);
  };
}

function isDaemonEventShaped(value: unknown): value is DaemonEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string' &&
    typeof (value as { ts?: unknown }).ts === 'string'
  );
}

/** Parses one line; returns `undefined` (never throws) for a blank or corrupt line so one bad line can't take down a whole `status`/`tasks` read. */
function parseAuditLine(line: string): DaemonEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isDaemonEventShaped(parsed) ? parsed : undefined;
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
 * atomic writes this package uses elsewhere for OTHER files): a small poll
 * loop re-reads the file and emits whichever lines are newly complete (see
 * {@link completeLines}). Resolves once `signal` aborts (e.g. SIGINT/SIGTERM
 * wired up in `byok-agent.ts`, or a test's own `AbortController`).
 */
export async function followAuditLog(
  filePath: string,
  onEvent: (event: DaemonEvent) => void,
  options: FollowOptions,
): Promise<void> {
  const { signal, pollIntervalMs = 200, fromEnd = true } = options;

  let emitted = fromEnd ? (await readCompleteLines(filePath)).length : 0;

  while (!signal.aborted) {
    const lines = await readCompleteLines(filePath);
    if (lines.length < emitted) {
      // The log was truncated/replaced/removed out from under us — not
      // expected in normal operation (this log is append-only) — reset
      // rather than throw, so a `--follow` session survives it.
      emitted = 0;
    }
    for (; emitted < lines.length; emitted++) {
      const event = parseAuditLine(lines[emitted] ?? '');
      if (event) onEvent(event);
    }

    if (signal.aborted) break;
    await delay(pollIntervalMs, signal);
  }
}
