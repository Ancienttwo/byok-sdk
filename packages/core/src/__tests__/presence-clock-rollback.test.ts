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
