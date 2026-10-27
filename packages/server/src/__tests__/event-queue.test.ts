import { describe, expect, it } from 'vitest';
import { AsyncEventQueue } from '../event-queue';

describe('AsyncEventQueue bounds', () => {
  it('keeps a live subscriber moving after overflow instead of stranding its positional cursor', async () => {
    const queue = new AsyncEventQueue<string>({ maxBuffered: 1, truncationMarker: 'TRUNCATED' });
    const events = queue.subscribe()[Symbol.asyncIterator]();

    queue.push('first');
    await expect(events.next()).resolves.toEqual({ value: 'first', done: false });

    queue.push('second');
    queue.push('terminal');
    queue.close();

    await expect(events.next()).resolves.toEqual({ value: 'TRUNCATED', done: false });
    await expect(events.next()).resolves.toEqual({ value: 'terminal', done: false });
    await expect(events.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('tells a late subscriber that the retained terminal-only feed was clipped', async () => {
    const queue = new AsyncEventQueue<string>({ maxBuffered: 1, truncationMarker: 'TRUNCATED' });
    queue.push('first');
    queue.push('terminal');
    queue.close();

    const observed: string[] = [];
    for await (const event of queue.subscribe()) observed.push(event);

    expect(observed).toEqual(['TRUNCATED', 'terminal']);
  });

  it('emits only one truncation marker per subscriber across repeated overflow', async () => {
    const queue = new AsyncEventQueue<string>({ maxBuffered: 2, truncationMarker: 'TRUNCATED' });
    queue.push('one');
    queue.push('two');
    queue.push('three');
    queue.push('four');
    queue.close();

    const observed: string[] = [];
    for await (const event of queue.subscribe()) observed.push(event);

    expect(observed).toEqual(['TRUNCATED', 'three', 'four']);
  });
});

it('return releases a pending subscriber without closing other subscribers', async () => {
  const queue = new AsyncEventQueue<number>();
  const first = queue.subscribe()[Symbol.asyncIterator]();
  const other = queue.subscribe()[Symbol.asyncIterator]();
  const pending = first.next();
  expect(first.return).toBeTypeOf('function');
  await first.return!();
  expect(await pending).toEqual({ value: undefined, done: true });
  queue.push(7);
  expect(await other.next()).toEqual({ value: 7, done: false });
  expect(await first.next()).toEqual({ value: undefined, done: true });
  queue.close();
});

describe('AsyncEventQueue positions', () => {
  it('resumes after a position and accepts only positions it handed out', async () => {
    const queue = new AsyncEventQueue<string>();
    queue.push('a');
    queue.push('b');
    queue.push('c');
    queue.close();
    const resumed: Array<{ sequence: number; value: string }> = [];
    for await (const entry of queue.entries(0)) resumed.push(entry);
    expect(resumed).toEqual([{ sequence: 1, value: 'b' }, { sequence: 2, value: 'c' }]);
    expect([0, 2].map((sequence) => queue.isPosition(sequence))).toEqual([true, true]);
    expect([-1, 3, 1.5, Number.NaN].map((sequence) => queue.isPosition(sequence))).toEqual([false, false, false, false]);
  });

  it('marks a gap from the resume position, placed just before the oldest retained entry', async () => {
    const queue = new AsyncEventQueue<string>({ maxBuffered: 2, truncationMarker: 'TRUNCATED' });
    for (const value of ['zero', 'one', 'two', 'three']) queue.push(value);
    queue.close();
    const behind: Array<{ sequence: number; value: string }> = [];
    for await (const entry of queue.entries(0)) behind.push(entry);
    expect(behind).toEqual([
      { sequence: 1, value: 'TRUNCATED' },
      { sequence: 2, value: 'two' },
      { sequence: 3, value: 'three' },
    ]);
    const current: string[] = [];
    for await (const entry of queue.entries(1)) current.push(entry.value);
    expect(current).toEqual(['two', 'three']);
  });

  it('marks each gap a slow live subscriber falls into', async () => {
    const queue = new AsyncEventQueue<string>({ maxBuffered: 1, truncationMarker: 'TRUNCATED' });
    const events = queue.subscribe()[Symbol.asyncIterator]();
    queue.push('first');
    queue.push('second');
    await expect(events.next()).resolves.toEqual({ value: 'TRUNCATED', done: false });
    await expect(events.next()).resolves.toEqual({ value: 'second', done: false });
    queue.push('third');
    queue.push('fourth');
    queue.close();
    await expect(events.next()).resolves.toEqual({ value: 'TRUNCATED', done: false });
    await expect(events.next()).resolves.toEqual({ value: 'fourth', done: false });
    await expect(events.next()).resolves.toEqual({ value: undefined, done: true });
  });
});
