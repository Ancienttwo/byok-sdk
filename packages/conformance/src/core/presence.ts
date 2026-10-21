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

    it('renews a zero-interval lease after the clock moves backwards', async () => {
      await withComposition(factory, async (handle) => {
        const lease = { deviceId: 'device-rollback', level: 'online', ttlMs: 60_000, minimumIntervalMs: 0 } as const;
        await handle.stores.presence.publish(TENANT_A, lease);
        await handle.advanceTime(-1_000);
        const now = handle.now();

        const renewed = await handle.stores.presence.publish(TENANT_A, { ...lease, level: 'working' });

        expect(renewed.observedAt).toBe(now);
        expect(renewed.expiresAt).toBe(new Date(Date.parse(now) + 60_000).toISOString());
        expect(await handle.stores.presence.read(TENANT_A, 'device-rollback')).toMatchObject({
          level: 'working',
          expiresAt: renewed.expiresAt,
        });
      });
    });
  });
}
