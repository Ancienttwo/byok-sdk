/**
 * Presence and activity conformance (§12.3).
 *
 * Two properties, both about honesty: an expired hint must be *absent* rather
 * than stale, and a truncated activity tail must say how much it lost. Both are
 * asserted through the injected clock, so a composition cannot pass by being
 * slow enough that nothing expires during the test.
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
  });

  describe('activity', () => {
    it('bounds the tail and counts what it dropped', async () => {
      await withComposition(factory, async ({ stores }) => {
        let tail = await stores.activity.append(TENANT_A, {
          taskId: 'task-1',
          details: ['entry-0'],
          dropped: 0,
          ttlMs: 300_000,
          capacity: 3,
        });
        for (let index = 1; index < 6; index += 1) {
          tail = await stores.activity.append(TENANT_A, {
            taskId: 'task-1',
            details: [`entry-${index}`],
            dropped: 0,
            ttlMs: 300_000,
            capacity: 3,
          });
        }

        expect(tail.entries).toHaveLength(3);
        expect(tail.entries.map((entry) => entry.detail)).toEqual([
          'entry-3',
          'entry-4',
          'entry-5',
        ]);
        // Lossiness is in the data, not implied by a gap the reader must notice.
        expect(tail.dropped).toBe(3);
      });
    });

    it('treats an expired tail as absent', async () => {
      await withComposition(factory, async (handle) => {
        const { stores } = handle;
        await stores.activity.append(TENANT_A, {
          taskId: 'task-1',
          details: ['entry-0'],
          dropped: 0,
          ttlMs: 300_000,
        });
        expect(await stores.activity.read(TENANT_A, 'task-1')).toBeDefined();

        await handle.advanceTime(300_000);
        expect(await stores.activity.read(TENANT_A, 'task-1')).toBeUndefined();
      });
    });

    it('adds producer drops to capacity eviction', async () => {
      await withComposition(factory, async ({ stores }) => {
        const tail = await stores.activity.append(TENANT_A, {
          taskId: 'task-dropped',
          details: ['one', 'two', 'three'],
          dropped: 4,
          ttlMs: 300_000,
          capacity: 2,
        });
        expect(tail.entries.map((entry) => entry.detail)).toEqual(['two', 'three']);
        expect(tail.dropped).toBe(5);
      });
    });
  });
}
