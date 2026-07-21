/**
 * A minimal push/pull async queue: producers call `push`/`end`, consumers
 * `for await` over the queue itself. Shared by the pi RPC client's event
 * stream, the claude/codex adapters' own event streams, and test fixtures
 * (stub sessions) so all of them get the same order-preserving semantics
 * without duplicating it.
 *
 * M4 hardening: this used to be genuinely back-pressure-free — an unbounded
 * internal `buffered` array, so a producer that outpaces its consumer (a
 * runaway/misbehaving runtime adapter, or simply nobody ever reading
 * `session.events`) could grow it without limit. Bounded now: `capacity`
 * (default {@link DEFAULT_ASYNC_QUEUE_CAPACITY}) caps how many items may sit
 * in `buffered` unconsumed. On overflow this fails fast rather than either of
 * the two worse alternatives — silently dropping the newest/oldest event (a
 * consumer would never know its view of the stream has a hole in it) or
 * blocking `push()` (every producer in this codebase calls `push()`
 * synchronously from an I/O callback; blocking there would stall reading the
 * underlying process/socket entirely). Instead, once `capacity` is exceeded,
 * the queue transitions into a permanent error state: every pending and
 * future consumer `next()` call rejects with an {@link AsyncQueueOverflowError}
 * naming the capacity, and all further `push()` calls are silently ignored
 * (mirrors the pre-existing `ended` no-op precedent — once terminal, always
 * terminal). The error state is checked before `ended`, so it wins even if
 * `end()` is called afterward — a caller must learn the stream broke, not
 * see a quiet, ordinary completion.
 */
export class AsyncQueueOverflowError extends Error {
  constructor(public readonly capacity: number) {
    super(
      `AsyncQueue exceeded its capacity of ${capacity} buffered item(s) — failing fast rather than growing unbounded, silently dropping events, or blocking push()`,
    );
    this.name = 'AsyncQueueOverflowError';
  }
}

/** Default `capacity` (see {@link AsyncQueue}'s own doc comment) when the constructor isn't given one — generous for every producer in this codebase (adapter event streams a consumer reads turn-by-turn), while still catching a genuinely runaway/unconsumed stream instead of growing forever. */
export const DEFAULT_ASYNC_QUEUE_CAPACITY = 10_000;

interface QueueWaiter<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (err: Error) => void;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiters: QueueWaiter<T>[] = [];
  private ended = false;
  private failure: Error | undefined;

  constructor(private readonly capacity: number = DEFAULT_ASYNC_QUEUE_CAPACITY) {}

  push(item: T): void {
    if (this.ended || this.failure) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      // Handed directly to an already-waiting consumer — never touches
      // `buffered`, so this path can never itself cause an overflow.
      waiter.resolve({ value: item, done: false });
      return;
    }
    if (this.buffered.length >= this.capacity) {
      this.fail(new AsyncQueueOverflowError(this.capacity));
      return;
    }
    this.buffered.push(item);
  }

  end(): void {
    if (this.ended || this.failure) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ value: undefined as never, done: true });
    }
  }

  /** Transitions the queue into its permanent overflow state: rejects every currently-pending waiter and, from then on, every `next()` call (checked ahead of `ended` — see the class doc comment on why the error must win). */
  private fail(error: Error): void {
    if (this.ended || this.failure) return;
    this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.failure) {
          return Promise.reject(this.failure);
        }
        if (this.buffered.length > 0) {
          return Promise.resolve({ value: this.buffered.shift() as T, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined as never, done: true });
        }
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}
