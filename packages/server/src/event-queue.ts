/**
 * A tiny append-only, multi-reader async queue. `push` never blocks; `close`
 * marks the queue done. `subscribe()` returns a fresh async iterator that
 * always replays from the beginning of the buffer, so a consumer that calls
 * `events()` at any point still "sees everything" for that task's lifetime.
 *
 * Framework-agnostic on purpose (no Node/WS/Hono types here) so it can be
 * unit-tested and reused regardless of transport.
 */
export class AsyncEventQueue<T> {
  private readonly buffer: T[] = [];
  private closed = false;
  private waiters: Array<() => void> = [];

  push(value: T): void {
    if (this.closed) return;
    this.buffer.push(value);
    this.wake();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
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
        let index = 0;
        return {
          async next(): Promise<IteratorResult<T>> {
            for (;;) {
              if (index < queue.buffer.length) {
                return { value: queue.buffer[index++]!, done: false };
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
