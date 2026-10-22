/**
 * Presence conformance (§12.3).
 *
 * An expired hint must be *absent* rather than stale. The behavior is asserted
 * through the injected clock, so a composition cannot pass by being slow
 * enough that nothing expires during the test.
 */
import { describe, expect, it } from 'vitest';
import { isCoreError } from '@byok-sdk/core';
import { TENANT_A } from './fixtures';
import { withComposition, type CoreCompositionFactory } from './harness';

export function runPresenceConformance(factory: CoreCompositionFactory): void {
  describe('presence', () => {
    it('round-trips every presence level', async () => {
      await withComposition(factory, async ({ stores }) => {
        for (const level of ['online', 'thinking', 'working', 'error', 'offline'] as const) {
          const published = await stores.presence.publish(TENANT_A, {
            deviceId: 'device-1',
            level,
            ttlMs: 60_000,
            minimumIntervalMs: 0,
          });
          expect(published.level).toBe(level);
          expect((await stores.presence.read(TENANT_A, 'device-1'))?.level).toBe(level);
        }
      });
    });

    it('round-trips a logical toolset inventory without retaining caller mutation', async () => {
      await withComposition(factory, async ({ stores }) => {
        const configuredToolsets = ['crm.readonly', 'salesko.connectors'];
        const published = await stores.presence.publish(TENANT_A, {
          deviceId: 'device-toolsets',
          level: 'online',
          configuredToolsets,
          ttlMs: 60_000,
          minimumIntervalMs: 0,
        });
        configuredToolsets.push('mutated.after.publish');

        expect(published.configuredToolsets).toEqual(['crm.readonly', 'salesko.connectors']);
        expect((await stores.presence.read(TENANT_A, 'device-toolsets'))?.configuredToolsets).toEqual([
          'crm.readonly',
          'salesko.connectors',
        ]);
      });
    });

    it('treats an expired hint as absent', async () => {
      await withComposition(factory, async (handle) => {
        const { stores } = handle;
        await stores.presence.publish(TENANT_A, {
          deviceId: 'device-1',
          level: 'working',
          ttlMs: 60_000,
          minimumIntervalMs: 0,
        });
        expect(await stores.presence.read(TENANT_A, 'device-1')).toBeDefined();
        expect(await stores.presence.list(TENANT_A)).toHaveLength(1);

        await handle.advanceTime(60_000);

        expect(await stores.presence.read(TENANT_A, 'device-1')).toBeUndefined();
        expect(await stores.presence.list(TENANT_A)).toHaveLength(0);
      });
    });

    it('disables publication throttling at zero interval after clock rollback', async () => {
      await withComposition(factory, async handle => {
        const input = { deviceId: 'rollback-zero', level: 'online' as const, ttlMs: 60_000, minimumIntervalMs: 0 };
        await handle.stores.presence.publish(TENANT_A, input);
        await handle.advanceTime(-5_000);
        const observedAt = handle.now();
        const published = await handle.stores.presence.publish(TENANT_A, { ...input, level: 'working' });
        expect(published).toMatchObject({ level: 'working', observedAt,
          expiresAt: new Date(Date.parse(observedAt) + input.ttlMs).toISOString() });
        expect(await handle.stores.presence.read(TENANT_A, input.deviceId)).toEqual(published);
      });
    });

    it('preserves positive publication throttling after clock rollback', async () => {
      await withComposition(factory, async handle => {
        const input = { deviceId: 'rollback-positive', level: 'online' as const, ttlMs: 60_000, minimumIntervalMs: 10_000 };
        const initial = await handle.stores.presence.publish(TENANT_A, input);
        await handle.advanceTime(-5_000);
        await expect(handle.stores.presence.publish(TENANT_A, { ...input, level: 'working' }))
          .rejects.toMatchObject({ code: 'hint_rate_limited' });
        expect(await handle.stores.presence.read(TENANT_A, input.deviceId)).toEqual(initial);
        await handle.advanceTime(15_000);
        expect((await handle.stores.presence.publish(TENANT_A, { ...input, level: 'working' })).level).toBe('working');
      });
    });

    it('enforces the configured publication interval at the store authority', async () => {
      await withComposition(factory, async (handle) => {
        await handle.stores.presence.publish(TENANT_A, {
          deviceId: 'device-throttled',
          level: 'online',
          ttlMs: 60_000,
          minimumIntervalMs: 10_000,
        });
        const tooSoon = await handle.stores.presence
          .publish(TENANT_A, {
            deviceId: 'device-throttled',
            level: 'working',
            ttlMs: 60_000,
            minimumIntervalMs: 10_000,
          })
          .catch((caught: unknown) => caught);
        expect(isCoreError(tooSoon, 'hint_rate_limited')).toBe(true);

        await handle.advanceTime(10_000);
        expect(
          (
            await handle.stores.presence.publish(TENANT_A, {
              deviceId: 'device-throttled',
              level: 'working',
              ttlMs: 60_000,
              minimumIntervalMs: 10_000,
            })
          ).level,
        ).toBe('working');
      });
    });
  });
}
