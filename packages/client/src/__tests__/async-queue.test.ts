import { describe, expect, it } from 'vitest';
import { AsyncQueue, AsyncQueueOverflowError, DEFAULT_ASYNC_QUEUE_CAPACITY } from '../util/async-queue';

async function drain<T>(queue: AsyncQueue<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of queue) {
    items.push(item);
  }
  return items;
}

describe('AsyncQueue', () => {
  it('yields pushed items in order to a consumer, then completes once end() is called', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.end();
    queue.push(3); // ignored — already ended

    expect(await drain(queue)).toEqual([1, 2]);
  });

  it('delivers a push directly to an already-waiting consumer (never touches the buffer)', async () => {
    const queue = new AsyncQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();

    queue.push('hello');

    expect(await pending).toEqual({ value: 'hello', done: false });
  });

  it('DEFAULT_ASYNC_QUEUE_CAPACITY is generous (10_000) and used when the constructor is given no capacity — filling exactly to it never overflows', async () => {
    expect(DEFAULT_ASYNC_QUEUE_CAPACITY).toBe(10_000);
    const queue = new AsyncQueue<number>();
    for (let i = 0; i < DEFAULT_ASYNC_QUEUE_CAPACITY; i++) queue.push(i);
    queue.end();

    const items = await drain(queue);
    expect(items).toHaveLength(DEFAULT_ASYNC_QUEUE_CAPACITY);
    expect(items[0]).toBe(0);
    expect(items[items.length - 1]).toBe(DEFAULT_ASYNC_QUEUE_CAPACITY - 1);
  });

  it('M4 Fix 4: a queue filled to capacity-1 still works completely normally (no overflow, ordinary delivery)', async () => {
    const queue = new AsyncQueue<number>(3);
    queue.push(1);
    queue.push(2); // capacity - 1 = 2 items buffered; nowhere near the cap
    queue.end();

    expect(await drain(queue)).toEqual([1, 2]);
  });

  it('M4 Fix 4: pushing beyond capacity fails the queue closed — an ALREADY-pending consumer next() rejects with AsyncQueueOverflowError naming the capacity', async () => {
    const queue = new AsyncQueue<number>(2);
    queue.push(1);
    queue.push(2); // buffer now at capacity (2) — nothing overflowed yet

    const iterator = queue[Symbol.asyncIterator]();
    // Drain the 2 already-buffered items first so the NEXT next() call is
    // genuinely pending (registered as a waiter) before the overflow push.
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: 2, done: false });
    const pending = iterator.next(); // now genuinely pending — buffer is empty, queue not ended

    queue.push(3); // buffer would need to hold 1 item — still under capacity(2), delivered directly to the pending waiter instead
    queue.push(4); // no waiter left; buffer would grow to 1 — still fine
    queue.push(5); // buffer would grow to 2 — still at capacity, fine
    queue.push(6); // buffer would grow to 3 — EXCEEDS capacity(2): overflow

    await expect(pending).resolves.toEqual({ value: 3, done: false });
    await expect(iterator.next()).rejects.toThrow(AsyncQueueOverflowError);
    await expect(iterator.next()).rejects.toThrow(/capacity of 2/);
  });

  it('M4 Fix 4: pushing beyond capacity fails the queue closed — a FUTURE consumer (never previously iterating) also rejects on its very first next()', async () => {
    const queue = new AsyncQueue<number>(2);
    queue.push(1);
    queue.push(2); // at capacity
    queue.push(3); // exceeds capacity — overflow, no consumer was ever attached

    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(AsyncQueueOverflowError);

    // A for-await loop (the real consumption pattern used throughout the
    // adapters) also throws rather than hanging or silently completing.
    await expect(drain(queue)).rejects.toThrow(AsyncQueueOverflowError);
  });

  it('M4 Fix 4: further push() calls after an overflow are silently ignored — never re-triggers, never throws from push() itself', () => {
    const queue = new AsyncQueue<number>(1);
    queue.push(1); // at capacity
    expect(() => queue.push(2)).not.toThrow(); // triggers the overflow
    expect(() => queue.push(3)).not.toThrow(); // already failed — silently dropped, exactly like a push after end()
  });

  it('M4 Fix 4: an ended queue (well under capacity) is completely unaffected by the bounding change — ordinary end() behavior is unchanged', async () => {
    const queue = new AsyncQueue<number>(1000);
    queue.push(1);
    queue.end();

    expect(await drain(queue)).toEqual([1]);
    // end() itself stays idempotent/harmless afterward, exactly as before.
    expect(() => queue.end()).not.toThrow();
  });

  it('M4 Fix 4: the error state wins over end() — calling end() after an overflow does not clear it, and next() keeps rejecting rather than reporting an ordinary completion', async () => {
    const queue = new AsyncQueue<number>(1);
    queue.push(1); // at capacity
    queue.push(2); // overflow — queue now permanently failed

    queue.end(); // must NOT override the failure with an ordinary done:true completion

    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow(AsyncQueueOverflowError);
  });
});
