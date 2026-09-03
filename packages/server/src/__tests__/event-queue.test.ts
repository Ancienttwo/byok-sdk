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
