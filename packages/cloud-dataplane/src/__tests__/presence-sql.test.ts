import { describe, expect, it, vi } from 'vitest';
import type { ByokPool } from '../pool';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { PostgresPresenceStore } from '../stores/core/presence';

describe('presence upsert SQL binding contract', () => {
  it.each([0, 10_000])('binds a zero-only bypass while retaining clock-derived TTL and threshold: %s', async minimumIntervalMs => {
    const clock = createMutableClock();
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const store = new PostgresPresenceStore({ query } as unknown as ByokPool, clock);
    clock.advance(-5_000);
    await expect(store.publish(tenantId('sql-presence'), {
      deviceId: 'device', level: 'working', ttlMs: 60_000, minimumIntervalMs,
    })).rejects.toMatchObject({ code: 'hint_rate_limited' }); // Empty RETURNING still has the same typed refusal.
    const [sql, values] = query.mock.calls[0]!;
    expect(sql).toMatch(/WHERE device_presence\.expires_at <= EXCLUDED\.observed_at\s+OR device_presence\.observed_at <= \$11\s+OR \$12::boolean/);
    expect(values[8]).toBe(clock.now().toISOString());
    expect(values[9]).toBe(new Date(clock.now().getTime() + 60_000).toISOString());
    expect(values[10]).toBe(new Date(clock.now().getTime() - minimumIntervalMs).toISOString());
    expect(values[11]).toBe(minimumIntervalMs === 0);
  });
});
