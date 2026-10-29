import { describe, expect, it } from 'vitest';
import { MAX_BACKOFF_DOUBLINGS, backoffCeilingMs, createFleetJitter, deterministicJitterMs } from '../daemon/deterministic-jitter';

describe('deterministic fleet jitter', () => {
  it('is stable, bounded, and domain-separated', () => {
    const input = { seed: 'product\0device', domain: 'reconnect' as const, sequence: 7, baseMs: 1000 };
    const values = Array.from({ length: 100 }, () => deterministicJitterMs(input));
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBeGreaterThanOrEqual(800);
    expect(values[0]).toBeLessThanOrEqual(1200);
    expect(deterministicJitterMs({ ...input, domain: 'upload' })).not.toBe(values[0]);
    expect(deterministicJitterMs({ ...input, domain: 'maintenance' })).not.toBe(values[0]);
  });

  it('keeps a 10,000-device cohort out of a synchronized retry peak', () => {
    const buckets = new Map<number, number>();
    for (let index = 0; index < 10_000; index += 1) {
      const delay = createFleetJitter('product', `device-${index}`).delay('reconnect', 0, 1000);
      const bucket = Math.floor(delay / 20);
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
    }
    const peak = Math.max(...buckets.values());
    expect(buckets.size).toBeGreaterThanOrEqual(20);
    expect(peak).toBeLessThan(600);
  });

  it('rejects missing identity and unsafe sequences instead of inventing a fallback', () => {
    expect(() => createFleetJitter('', 'device')).toThrow(/required/);
    expect(() => deterministicJitterMs({ seed: 'x', domain: 'reconnect', sequence: -1, baseMs: 1000 })).toThrow(/sequence/);
    expect(() => deterministicJitterMs({ seed: 'x', domain: 'reconnect', sequence: Number.MAX_SAFE_INTEGER + 1, baseMs: 1000 })).toThrow(/sequence/);
  });

  it('projects a stable retry schedule for a fleet identity', () => {
    const jitter = createFleetJitter('product', 'device');
    expect(jitter.delay('reconnect', 0, 123)).toBe(deterministicJitterMs({
      seed: 'product\0device',
      domain: 'reconnect',
      sequence: 0,
      baseMs: 123,
    }));
    expect(jitter.delay('reconnect', 1, 123)).not.toBe(jitter.delay('reconnect', 0, 123));
  });

  it('grows each retry exponentially from the base up to a ceiling', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 40].map(attempt => backoffCeilingMs(attempt, 2000)))
      .toEqual([2000, 4000, 8000, 16_000, 32_000, 64_000, 64_000, 64_000]);
    expect(() => backoffCeilingMs(-1, 2000)).toThrow(/attempt/);
    expect(() => backoffCeilingMs(1, Number.NaN)).toThrow(/baseMs/);
  });

  it('keeps the fleet delay inside ±20% of the capped schedule', () => {
    const jitter = createFleetJitter('product', 'device');
    for (let attempt = 0; attempt <= MAX_BACKOFF_DOUBLINGS + 3; attempt += 1) {
      const ceiling = backoffCeilingMs(attempt, 1000);
      const delay = jitter.delay('reconnect', attempt, 1000);
      expect(delay).toBeGreaterThanOrEqual(ceiling * 0.8);
      expect(delay).toBeLessThanOrEqual(ceiling * 1.2);
    }
    expect(jitter.delay('reconnect', 4, 1000)).toBeGreaterThan(jitter.delay('reconnect', 0, 1000) * 8);
  });

  it('still spreads a fleet parked at the ceiling', () => {
    const delays = new Set<number>();
    for (let index = 0; index < 1000; index += 1) {
      delays.add(createFleetJitter('product', `device-${index}`).delay('reconnect', 50, 1000));
    }
    expect(delays.size).toBeGreaterThan(500);
  });
});
