/**
 * A tiny append-only, multi-reader async queue backing the cross-task
 * `ByokServer.events.subscribe()` feed. `push` never blocks; `close` marks the
 * queue done. Each `subscribe()` replays what is retained and follows new
 * pushes until the queue closes; its `return()` also releases a pending
 * `next()`.
 *
 * Bounded: the feed is a notification stream, not a record — the durable facts
 * live in the cloud stores — so a subscriber that stops reading costs bounded
 * memory. On overflow the OLDEST entries are dropped silently: no
 * `ByokServerEvent` member could carry a truncation notice. Members carry no
 * block docs because comments on class members ship in the bundle, which has
 * an exact size budget.
 */
export class AsyncEventQueue<T> {
  private readonly buffer: Array<{ readonly sequence: number; readonly value: T }> = [];
  private nextSequence = 0;
  private closed = false;
  private waiters = new Set<() => void>();
  private readonly maxBuffered: number;

  constructor(options: { readonly maxBuffered: number }) {
    if (!Number.isSafeInteger(options.maxBuffered) || options.maxBuffered <= 0) {
      throw new TypeError(`AsyncEventQueue: maxBuffered must be a positive safe integer, got ${String(options.maxBuffered)}`);
    }
    this.maxBuffered = options.maxBuffered;
  }

  push(value: T): void {
    if (this.closed) return;
    this.buffer.push({ sequence: this.nextSequence++, value });
    if (this.buffer.length > this.maxBuffered) this.buffer.splice(0, this.buffer.length - this.maxBuffered);
    this.wake();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const waiters = this.waiters;
    this.waiters = new Set();
    for (const resolve of waiters) resolve();
  }

  subscribe(): AsyncIterable<T> {
    const queue = this;
    return {
      [Symbol.asyncIterator](): AsyncIterator<T> {
        let wanted = 0;
        let stopped = false;
        const localWaiters = new Set<() => void>();
        return {
          async next(): Promise<IteratorResult<T>> {
            for (;;) {
              if (stopped) return { value: undefined, done: true };
              const oldest = queue.buffer[0]?.sequence;
              if (oldest !== undefined) {
                wanted = Math.max(wanted, oldest);
                const entry = queue.buffer[wanted - oldest];
                if (entry !== undefined) {
                  wanted = entry.sequence + 1;
                  return { value: entry.value, done: false };
                }
              }
              if (queue.closed) return { value: undefined, done: true };
              await new Promise<void>(resolve => {
                const wake = () => { queue.waiters.delete(wake); localWaiters.delete(wake); resolve(); };
                localWaiters.add(wake); queue.waiters.add(wake);
              });
            }
          },
          async return(): Promise<IteratorResult<T>> {
            stopped = true;
            for (const wake of localWaiters) wake();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }
}
