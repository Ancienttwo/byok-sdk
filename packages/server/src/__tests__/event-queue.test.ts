import { describe, expect, it } from 'vitest';
import { AsyncEventQueue } from '../event-queue';

describe('AsyncEventQueue', () => {
  it('drops the oldest entries silently and keeps a live subscriber moving', async () => {
    const queue = new AsyncEventQueue<string>({ maxBuffered: 1 });
    const events = queue.subscribe()[Symbol.asyncIterator]();

    queue.push('first');
    await expect(events.next()).resolves.toEqual({ value: 'first', done: false });

    queue.push('second');
    queue.push('terminal');
    queue.close();

    await expect(events.next()).resolves.toEqual({ value: 'terminal', done: false });
    await expect(events.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('replays what is retained to a late subscriber, then ends at close', async () => {
    const queue = new AsyncEventQueue<string>({ maxBuffered: 2 });
    for (const value of ['one', 'two', 'three']) queue.push(value);
    queue.close();

    const observed: string[] = [];
    for await (const event of queue.subscribe()) observed.push(event);
    expect(observed).toEqual(['two', 'three']);
  });

  it('refuses a bound that is not a positive safe integer', () => {
    for (const maxBuffered of [0, -1, 1.5, Number.POSITIVE_INFINITY]) {
      expect(() => new AsyncEventQueue({ maxBuffered })).toThrow(TypeError);
    }
  });

  it('return releases a pending subscriber without closing other subscribers', async () => {
    const queue = new AsyncEventQueue<number>({ maxBuffered: 10 });
    const first = queue.subscribe()[Symbol.asyncIterator]();
    const other = queue.subscribe()[Symbol.asyncIterator]();
    const pending = first.next();
    await first.return!();
    expect(await pending).toEqual({ value: undefined, done: true });
    queue.push(7);
    expect(await other.next()).toEqual({ value: 7, done: false });
    expect(await first.next()).toEqual({ value: undefined, done: true });
    queue.close();
  });
});
