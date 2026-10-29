import { createMutableClock, tenantId } from '@byok-sdk/core';
import { describe, expect, it } from 'vitest';
import { TokenBucketRateLimiter } from '../stores/rate-limiter';

const TENANT = tenantId('tenant-a');

describe('Postgres composition token bucket (#1118)', () => {
  it('admits a burst, refuses with the time until the next token, then refills', async () => {
    const clock = createMutableClock();
    const limiter = new TokenBucketRateLimiter({ tokensPerSecond: 4, burst: 2 }, clock);

    expect(await limiter.consume(TENANT, 'device-1', 'envelope')).toEqual({ allowed: true });
    expect(await limiter.consume(TENANT, 'device-1', 'request')).toEqual({ allowed: true });
    expect(await limiter.consume(TENANT, 'device-1', 'request')).toEqual({ allowed: false, retryAfterMs: 250 });

    clock.advance(100);
    expect(await limiter.consume(TENANT, 'device-1', 'envelope')).toEqual({ allowed: false, retryAfterMs: 150 });
    clock.advance(150);
    expect(await limiter.consume(TENANT, 'device-1', 'envelope')).toEqual({ allowed: true });
  });

  it('keeps tenants and devices in separate buckets', async () => {
    const clock = createMutableClock();
    const limiter = new TokenBucketRateLimiter({ tokensPerSecond: 1, burst: 1 }, clock);

    expect(await limiter.consume(TENANT, 'device-1', 'request')).toEqual({ allowed: true });
    expect((await limiter.consume(TENANT, 'device-1', 'request')).allowed).toBe(false);
    expect(await limiter.consume(TENANT, 'device-2', 'request')).toEqual({ allowed: true });
    expect(await limiter.consume(tenantId('tenant-b'), 'device-1', 'request')).toEqual({ allowed: true });
  });

  it('bounds tracked devices by dropping the least recently used bucket', async () => {
    const clock = createMutableClock();
    const limiter = new TokenBucketRateLimiter({ tokensPerSecond: 1, burst: 1, maxTrackedDevices: 2 }, clock);

    await limiter.consume(TENANT, 'device-1', 'request');
    await limiter.consume(TENANT, 'device-2', 'request');
    expect((await limiter.consume(TENANT, 'device-1', 'request')).allowed).toBe(false); // device-1 is now most recent
    await limiter.consume(TENANT, 'device-3', 'request'); // evicts device-2
    expect((await limiter.consume(TENANT, 'device-1', 'request')).allowed).toBe(false);
    expect(await limiter.consume(TENANT, 'device-2', 'request')).toEqual({ allowed: true });
  });

  it('refuses a configuration that cannot limit or cannot admit', () => {
    const clock = createMutableClock();
    expect(() => new TokenBucketRateLimiter({ tokensPerSecond: 0, burst: 1 }, clock)).toThrow(/tokensPerSecond/);
    expect(() => new TokenBucketRateLimiter({ tokensPerSecond: Number.POSITIVE_INFINITY, burst: 1 }, clock)).toThrow(/tokensPerSecond/);
    expect(() => new TokenBucketRateLimiter({ tokensPerSecond: 1, burst: 0.5 }, clock)).toThrow(/burst/);
    expect(() => new TokenBucketRateLimiter({ tokensPerSecond: 1, burst: 1, maxTrackedDevices: 0 }, clock)).toThrow(/maxTrackedDevices/);
  });
});
