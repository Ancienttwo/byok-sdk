import { describe, expect, it } from 'vitest';
import { tenantId, type DeviceAssertionReplayAuthority } from '@byok-sdk/core';

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
  });
}
