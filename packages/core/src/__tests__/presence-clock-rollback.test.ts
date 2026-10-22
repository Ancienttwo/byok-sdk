import { expect, it } from 'vitest';
import { InMemoryPresenceStore } from '../in-memory/presence';
import { createMutableClock } from '../in-memory/clock';
import { tenantId } from '../tenant';

it('keeps zero-interval presence unthrottled after a backward clock step', async () => {
  const clock = createMutableClock();
  const store = new InMemoryPresenceStore(clock);
  const tenant = tenantId('presence-rollback');
  const input = { deviceId: 'device', level: 'online' as const, ttlMs: 60_000, minimumIntervalMs: 0 };
  await store.publish(tenant, input);
  clock.advance(-1);
  const renewed = await store.publish(tenant, { ...input, level: 'working' });
  expect(renewed.observedAt).toBe(clock.now().toISOString());
  expect(renewed.expiresAt).toBe(new Date(clock.now().getTime() + input.ttlMs).toISOString());
  expect(await store.read(tenant, 'device')).toEqual(renewed);
});

it('retains positive publication throttling across rollback until its original deadline', async () => {
  const clock = createMutableClock();
  const store = new InMemoryPresenceStore(clock);
  const tenant = tenantId('presence-rollback');
  const input = { deviceId: 'device', level: 'online' as const, ttlMs: 60_000, minimumIntervalMs: 1000 };
  const original = await store.publish(tenant, input);
  clock.advance(-1);
  await expect(store.publish(tenant, input)).rejects.toMatchObject({ code: 'hint_rate_limited' });
  clock.advance(1000);
  await expect(store.publish(tenant, input)).rejects.toMatchObject({ code: 'hint_rate_limited' });
  expect(await store.read(tenant, 'device')).toEqual(original);
  clock.advance(1);
  await expect(store.publish(tenant, input)).resolves.toMatchObject({ observedAt: clock.now().toISOString() });
});

it.each([0, 1, 1000].flatMap(minimumIntervalMs =>
  [-60_001, -1, 0, 999, 1000, 60_000].map(delta => ({ minimumIntervalMs, delta })),
))('preserves the renewal boundary for interval=$minimumIntervalMs, delta=$delta', async ({ minimumIntervalMs, delta }) => {
  const clock = createMutableClock();
  const store = new InMemoryPresenceStore(clock);
  const tenant = tenantId('presence-boundary');
  const input = { deviceId: 'device', level: 'online' as const, ttlMs: 60_000, minimumIntervalMs };
  const original = await store.publish(tenant, input);
  clock.advance(delta);
  if (minimumIntervalMs === 0 || delta >= minimumIntervalMs || delta >= input.ttlMs) {
    await expect(store.publish(tenant, input)).resolves.toMatchObject({
      observedAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + input.ttlMs).toISOString(),
    });
  } else {
    await expect(store.publish(tenant, input)).rejects.toMatchObject({ code: 'hint_rate_limited' });
    expect(await store.read(tenant, input.deviceId)).toEqual(original);
  }
});
