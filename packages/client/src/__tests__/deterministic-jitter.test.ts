import { describe, expect, it, vi } from 'vitest';
import { createFleetJitter, deterministicJitterMs } from '../daemon/deterministic-jitter';
import { WsTransport } from '../daemon/ws-transport';

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

  it('does not delay an explicit one-shot operator probe', async () => {
    const reconnectDelayMs = vi.fn(() => 1000);
    const transport = new WsTransport({
      serverUrl: 'http://127.0.0.1:1',
      getToken: async () => { throw new Error('offline'); },
      deviceId: 'device',
      productId: 'product',
      capabilities: [],
      onEnvelope: () => {},
      reconnectDelayMs,
    });
    transport.connect({ auto: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reconnectDelayMs).not.toHaveBeenCalled();
    transport.close();
  });

  it('routes an automatic WS retry through the deterministic delay authority', async () => {
    const reconnectDelayMs = vi.fn(() => 60_000);
    const transport = new WsTransport({
      serverUrl: 'http://127.0.0.1:1',
      getToken: async () => { throw new Error('offline'); },
      deviceId: 'device',
      productId: 'product',
      capabilities: [],
      onEnvelope: () => {},
      backoff: { baseMs: 123, maxMs: 1000, factor: 2 },
      reconnectDelayMs,
    });
    transport.connect({ auto: true });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reconnectDelayMs).toHaveBeenCalledOnce();
    expect(reconnectDelayMs).toHaveBeenCalledWith(0, 123);
    transport.close();
  });
});
