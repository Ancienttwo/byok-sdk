/**
 * A tiny append-only, multi-reader async queue. `push` never blocks; `close`
 * marks the queue done. `subscribe()` returns a fresh async iterator that
 * always replays from the beginning of the retained buffer, so a consumer that
 * calls `events()` at any point still sees everything still retained for that
 * task's lifetime.
 *
 * Bounded, deliberately (WP3B §3): this queue is a NOTIFICATION relay, not a
 * record of what happened — the durable facts live in the cloud stores a
 * `ByokServer` reads back (`tasks.get`, `TaskHandle.result()`). A consumer that
 * stops iterating must therefore cost bounded memory, not unbounded growth. On
 * overflow the OLDEST entries are dropped and, exactly once per queue, a
 * caller-supplied `truncationMarker` is appended so a reader can tell a
 * complete feed from a clipped one instead of silently seeing a gap.
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
   * Appended once, after the first drop, so the truncation is observable.
   * Omitted means a bounded queue that drops silently.
   */
  readonly truncationMarker?: T;
}

export class AsyncEventQueue<T> {
  private readonly buffer: Array<{ readonly sequence: number; readonly value: T }> = [];
  private nextSequence = 0;
  private closed = false;
  private waiters: Array<() => void> = [];
  private readonly maxBuffered: number | undefined;
  private readonly truncationMarker: T | undefined;
  private truncationNoted = false;

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

  /** True once this queue has dropped at least one entry. */
  get truncated(): boolean {
    return this.truncationNoted;
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
   * Drop the oldest entries back down to the bound. The marker is queue
   * metadata, not a buffered entry: every subscriber observes it at most once
   * after the first drop, while all retained capacity remains available to
   * real events.
   */
  private enforceBound(): void {
    const limit = this.maxBuffered;
    if (limit === undefined || this.buffer.length <= limit) return;
    this.buffer.splice(0, this.buffer.length - limit);
    this.truncationNoted = true;
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  private waitForMore(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  /** Async-iterate the buffer from index 0, waiting for new pushes until closed. */
  subscribe(): AsyncIterable<T> {
    const queue = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        let sequence = queue.buffer[0]?.sequence ?? queue.nextSequence;
        let truncationDelivered = false;
        return {
          async next(): Promise<IteratorResult<T>> {
            for (;;) {
              if (queue.truncationNoted && !truncationDelivered && queue.truncationMarker !== undefined) {
                truncationDelivered = true;
                return { value: queue.truncationMarker, done: false };
              }

              const oldest = queue.buffer[0]?.sequence;
              if (oldest !== undefined && sequence < oldest) sequence = oldest;
              if (oldest !== undefined) {
                const offset = sequence - oldest;
                const entry = queue.buffer[offset];
                if (entry !== undefined) {
                  sequence = entry.sequence + 1;
                  return { value: entry.value, done: false };
                }
              }
              if (queue.closed) {
                return { value: undefined, done: true };
              }
              await queue.waitForMore();
            }
          },
        };
      },
    };
  }
}
