/**
 * A tiny append-only, multi-reader async queue. `push` never blocks; `close`
 * marks the queue done. Every pushed entry gets a sequence number, strictly
 * increasing within the queue. `entries(after)` returns a fresh async iterator
 * that starts after that sequence, or at the beginning of the queue when none
 * is given, and follows new pushes until the queue closes.
 *
 * Bounded, deliberately (WP3B §3): this queue is a NOTIFICATION relay, not a
 * record of what happened — the durable facts live in the cloud stores a
 * `ByokServer` reads back (`tasks.get`, `TaskHandle.result()`). A consumer that
 * stops iterating must therefore cost bounded memory, not unbounded growth. On
 * overflow the OLDEST entries are dropped. A subscriber whose next wanted entry
 * was dropped receives the caller-supplied `truncationMarker` once for that gap,
 * so a reader can tell a complete feed from a clipped one instead of silently
 * seeing a gap.
 *
 * Framework-agnostic on purpose (no Node/WS/Hono types here) so it can be
 * unit-tested and reused regardless of transport.
 */
export interface AsyncEventQueueOptions<T> {
  /**
   * Maximum entries retained before drop-oldest engages. Omitted means
   * unbounded — only appropriate for a queue whose producer is itself bounded.
   */
  readonly maxBuffered?: number;
  /**
   * Yielded to a subscriber in place of each run of entries dropped before it
   * read them, so the truncation is observable. Omitted means a bounded queue
   * that drops silently.
   */
  readonly truncationMarker?: T;
}

/** One queue position: a pushed value, or the truncation marker standing just before the oldest retained entry. */
export interface QueueEntry<T> {
  readonly sequence: number;
  readonly value: T;
}

export class AsyncEventQueue<T> {
  private readonly buffer: QueueEntry<T>[] = [];
  private nextSequence = 0;
  private closed = false;
  private waiters = new Set<() => void>();
  private readonly maxBuffered: number | undefined;
  private readonly truncationMarker: T | undefined;

  constructor(options: AsyncEventQueueOptions<T> = {}) {
    if (options.maxBuffered !== undefined) {
      if (!Number.isSafeInteger(options.maxBuffered) || options.maxBuffered <= 0) {
        throw new TypeError(
          `AsyncEventQueue: maxBuffered must be a positive safe integer, got ${String(options.maxBuffered)}`,
        );
      }
      this.maxBuffered = options.maxBuffered;
    }
    this.truncationMarker = options.truncationMarker;
  }

  /** True when `sequence` names a position this queue has handed out (pushed, or a marker's). */
  isPosition(sequence: number): boolean {
    return Number.isSafeInteger(sequence) && sequence >= 0 && sequence < this.nextSequence;
  }

  push(value: T): void {
    if (this.closed) return;
    this.buffer.push({ sequence: this.nextSequence++, value });
    this.enforceBound();
    this.wake();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
  }

  /**
   * Drop the oldest entries back down to the bound. The marker is not a
   * buffered entry: each subscriber derives it from its own position, so all
   * retained capacity remains available to real events.
   */
  private enforceBound(): void {
    const limit = this.maxBuffered;
    if (limit === undefined || this.buffer.length <= limit) return;
    this.buffer.splice(0, this.buffer.length - limit);
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = new Set();
    for (const resolve of waiters) resolve();
  }

  /** The values only, from the beginning of the queue. */
  subscribe(): AsyncIterable<T> {
    const queue = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        const entries = queue.entries()[Symbol.asyncIterator]();
        return {
          async next(): Promise<IteratorResult<T>> {
            const next = await entries.next();
            return next.done ? next : { value: next.value.value, done: false };
          },
          async return(): Promise<IteratorResult<T>> {
            await entries.return!();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  /**
   * Async-iterate the entries after `after` (a position {@link isPosition}
   * accepts), or from the beginning of the queue, waiting for new pushes until
   * closed. `return()` also releases a pending `next()`.
   */
  entries(after?: number): AsyncIterable<QueueEntry<T>> {
    const queue = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<QueueEntry<T>> {
        let wanted = after === undefined ? 0 : after + 1;
        let stopped = false;
        const localWaiters = new Set<() => void>();
        return {
          async next(): Promise<IteratorResult<QueueEntry<T>>> {
            for (;;) {
              if (stopped) return { value: undefined, done: true };
              const oldest = queue.buffer[0]?.sequence;
              if (oldest !== undefined) {
                if (wanted < oldest) {
                  // Everything from `wanted` up to the oldest retained entry
                  // was dropped before this subscriber read it.
                  wanted = oldest;
                  if (queue.truncationMarker !== undefined) {
                    return { value: { sequence: oldest - 1, value: queue.truncationMarker }, done: false };
                  }
                }
                const entry = queue.buffer[wanted - oldest];
                if (entry !== undefined) {
                  wanted = entry.sequence + 1;
                  return { value: entry, done: false };
                }
              }
              if (queue.closed) {
                return { value: undefined, done: true };
              }
              await new Promise<void>(resolve => {
                const wake = () => { queue.waiters.delete(wake); localWaiters.delete(wake); resolve(); };
                localWaiters.add(wake); queue.waiters.add(wake);
              });
            }
          },
          async return(): Promise<IteratorResult<QueueEntry<T>>> {
            stopped = true;
            for (const wake of localWaiters) wake();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}
