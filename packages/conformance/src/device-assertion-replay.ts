import { describe, expect, it } from 'vitest';
import {
  DEVICE_ASSERTION_SCHEMA_ID,
  TASK_ASSERTION_SCHEMA_ID,
  tenantId,
  type DeviceAssertionReplayAuthority,
} from '@byok-sdk/core';

export interface DeviceAssertionReplayCompositionHandle {
  readonly replay: DeviceAssertionReplayAuthority;
  dispose?(): void | Promise<void>;
}

export interface DeviceAssertionReplayCompositionFactory {
  create(): DeviceAssertionReplayCompositionHandle | Promise<DeviceAssertionReplayCompositionHandle>;
}

export function runDeviceAssertionReplayConformance(
  name: string,
  factory: DeviceAssertionReplayCompositionFactory,
  options: { readonly skip?: boolean } = {},
): void {
  describe.skipIf(options.skip === true)(`device assertion replay conformance [${name}]`, () => {
    it('admits exactly one concurrent consumer for an assertion namespace and JTI', async () => {
      const handle = await factory.create();
      try {
        const input = {
          schema: DEVICE_ASSERTION_SCHEMA_ID,
          tenantId: tenantId('replay-conformance'),
          issuer: 'https://api.example.com',
          productId: 'product-a',
          deviceId: 'device-a',
          audience: 'connector-binding',
          jti: 'AAAAAAAAAAAAAAAAAAAAAA',
          expiresAt: '2026-08-12T04:47:00.000Z',
        } as const;
        const results = await Promise.all(
          Array.from({ length: 16 }, () => handle.replay.consume(input)),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
      } finally {
        await handle.dispose?.();
      }
    });

    it('does not collide distinct tenants or JTIs', async () => {
      const handle = await factory.create();
      try {
        const base = {
          schema: DEVICE_ASSERTION_SCHEMA_ID,
          tenantId: tenantId('replay-conformance-a'),
          issuer: 'https://api.example.com',
          productId: 'product-a',
          deviceId: 'device-a',
          audience: 'connector-binding',
          jti: 'BBBBBBBBBBBBBBBBBBBBBB',
          expiresAt: '2026-08-12T04:47:00.000Z',
        } as const;
        await expect(handle.replay.consume(base)).resolves.toBe(true);
        await expect(handle.replay.consume({ ...base, tenantId: tenantId('replay-conformance-b') })).resolves.toBe(true);
        await expect(handle.replay.consume({ ...base, jti: 'CCCCCCCCCCCCCCCCCCCCCC' })).resolves.toBe(true);
      } finally {
        await handle.dispose?.();
      }
    });

    /**
     * Contract §8.2(2) / AC11: the two envelope kinds share this authority but
     * not its key slots. Asserted at the PORT level so every implementation —
     * the in-memory reference and the Postgres primary key alike — has to
     * carry the discriminator; an implementation that dropped the `schema`
     * segment would still pass the tests above and fail here.
     */
    it('consumes one JTI exactly once per schema without either lane occupying the other', async () => {
      const handle = await factory.create();
      try {
        const base = {
          tenantId: tenantId('replay-conformance-schema'),
          issuer: 'https://api.example.com',
          productId: 'product-a',
          deviceId: 'device-a',
          audience: 'connector-binding',
          jti: 'DDDDDDDDDDDDDDDDDDDDDD',
          expiresAt: '2026-08-12T04:47:00.000Z',
        } as const;
        const device = { ...base, schema: DEVICE_ASSERTION_SCHEMA_ID } as const;
        const task = { ...base, schema: TASK_ASSERTION_SCHEMA_ID } as const;

        await expect(handle.replay.consume(device)).resolves.toBe(true);
        // The task lane's slot is still free: the device consumption above did
        // not burn it.
        await expect(handle.replay.consume(task)).resolves.toBe(true);
        // And each lane is now closed for that same jti, independently.
        await expect(handle.replay.consume(device)).resolves.toBe(false);
        await expect(handle.replay.consume(task)).resolves.toBe(false);
      } finally {
        await handle.dispose?.();
      }
    });
  });
}
