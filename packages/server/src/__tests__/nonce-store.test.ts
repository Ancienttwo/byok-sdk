import { afterEach, describe, expect, it, vi } from 'vitest';
import { NonceStore } from '../auth';

describe('NonceStore pruning (§6.2)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sweeps an expired nonce on a subsequent issue()', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const store = new NonceStore();
    store.issue('device-1'); // will expire
    expect(store.size).toBe(1);

    vi.setSystemTime(new Date('2026-01-01T00:06:00.000Z')); // +6min, past the ~5min TTL
    store.issue('device-2'); // triggers the sweep

    expect(store.size).toBe(1); // only device-2's fresh nonce remains
  });

  it('sweeps a used nonce on a subsequent issue(), even before it expires', () => {
    const store = new NonceStore();
    const nonce = store.issue('device-1');
    store.markUsed(nonce);
    expect(store.size).toBe(1);

    store.issue('device-2'); // triggers the sweep

    expect(store.size).toBe(1); // used nonce dropped; only device-2's remains
  });

  it('keeps unexpired, unused nonces across an issue() sweep', () => {
    const store = new NonceStore();
    store.issue('device-1');
    store.issue('device-2');

    expect(store.size).toBe(2);
  });
});
