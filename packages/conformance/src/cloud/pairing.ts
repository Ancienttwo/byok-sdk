/**
 * Pairing code conformance: single consumption, and one answer for every way a
 * redemption can fail.
 *
 * Single-use is what makes the caller's "redeem, then register the device row"
 * sequence exclusive — a second redeem can never reach the registration step.
 * That is why a durable composition has to consume with a guarded single
 * statement (`UPDATE ... WHERE redeemed_at IS NULL RETURNING ...`, zero rows =
 * rejection) rather than read-then-write: two concurrent redemptions of the
 * same code must not both observe it unused.
 *
 * `redeem` answers `undefined` for unknown, expired, and already-used alike.
 * The distinction is exactly what an attacker enumerating codes would pay for,
 * so no composition may make it observable.
 */
import { describe, expect, it } from 'vitest';
import { registration, TENANT_A, TENANT_B } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory } from './harness';

const CODE_TTL_MS = 10 * 60 * 1000;

function enrollment(pairingCode: string, deviceId: string) {
  return {
    pairingCode,
    deviceId,
    deviceName: `name-${deviceId}`,
    devicePublicKey: `pk-${deviceId}`,
    proofKeyId: 'identity',
    proofKeyEpoch: 0,
  };
}

export function runPairingConformance(factory: CloudCompositionFactory): void {
  describe('tenant readiness', () => {
    it('returns zero counts and no devices for an empty tenant', async () => {
      await withCloudComposition(factory, async ({ stores, presence }) => {
        expect(await stores.devices.readiness(TENANT_A, presence)).toEqual({
          tenantId: TENANT_A, activePairedDeviceCount: 0, revokedDeviceCount: 0,
          observedPresenceCount: 0,
          observedPresenceByLevel: { online: 0, thinking: 0, working: 0, error: 0, offline: 0 },
          devices: [],
        });
      });
    });

    it('projects live presence in device order and excludes revoked, orphan and foreign hints', async () => {
      await withCloudComposition(factory, async ({ stores, presence, advanceTime }) => {
        for (const [deviceId, level] of [
          ['c-working', 'working'], ['a-online', 'online'], ['e-offline', 'offline'],
          ['b-thinking', 'thinking'], ['d-error', 'error'],
        ] as const) {
          await stores.devices.register(TENANT_A, registration(deviceId));
          await presence.publish(TENANT_A, { deviceId, level, ttlMs: 60_000, minimumIntervalMs: 0 });
        }
        await stores.devices.register(TENANT_A, registration('f-unobserved'));
        await stores.devices.register(TENANT_A, registration('revoked'));
        await stores.devices.revoke(TENANT_A, 'revoked');
        await presence.publish(TENANT_A, { deviceId: 'orphan', level: 'thinking', ttlMs: 60_000, minimumIntervalMs: 0 });
        await stores.devices.register(TENANT_B, registration('foreign'));
        await presence.publish(TENANT_B, { deviceId: 'foreign', level: 'error', ttlMs: 60_000, minimumIntervalMs: 0 });
        const hint = await presence.publish(TENANT_A, {
          deviceId: 'c-working', level: 'working', detail: 'editing', configuredToolsets: ['git'],
          clientVersion: 'test-client', protocolVersions: [2], runtimes: [{ id: 'pi', authPresent: true }],
          ttlMs: 60_000, minimumIntervalMs: 0,
        });

        const readiness = await stores.devices.readiness(TENANT_A, presence);
        expect(readiness).toMatchObject({
          tenantId: TENANT_A, activePairedDeviceCount: 6, revokedDeviceCount: 0,
          observedPresenceCount: 5,
          observedPresenceByLevel: { online: 1, thinking: 1, working: 1, error: 1, offline: 1 },
        });
        expect(readiness.devices.map(device => device.deviceId)).toEqual([
          'a-online', 'b-thinking', 'c-working', 'd-error', 'e-offline', 'f-unobserved',
        ]);
        expect(readiness.devices[2]).toEqual({
          deviceId: 'c-working', productId: 'product-1', deviceName: 'name-c-working', revoked: false,
          presence: {
            level: 'working', detail: 'editing', configuredToolsets: ['git'],
            clientVersion: 'test-client', protocolVersions: [2], runtimes: [{ id: 'pi', authPresent: true }],
            observedAt: hint.observedAt, expiresAt: hint.expiresAt,
          },
        });
        expect(readiness.devices[5]).not.toHaveProperty('presence');

        await advanceTime(60_000);
        const expired = await stores.devices.readiness(TENANT_A, presence);
        expect(expired.observedPresenceCount).toBe(0);
        expect(expired.observedPresenceByLevel).toEqual({ online: 0, thinking: 0, working: 0, error: 0, offline: 0 });
        expect(expired.devices).toEqual(readiness.devices.map(({ presence: _presence, ...device }) => device));
      });
    });
  });

  describe('pairing enrollment', () => {
    it('registers under the code claims, exactly once', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        const expiresAt = new Date(Date.parse(handle.now()) + CODE_TTL_MS).toISOString();
        const info = await stores.pairingCodes.issue(TENANT_A, {
          code: 'code-1',
          productId: 'product-1',
          expiresAt,
        });
        expect(info.code).toBe('code-1');
        expect(info.expiresAt).toBe(expiresAt);

        const device = await stores.pairing.redeemAndRegister(enrollment('code-1', 'device-1'));
        expect(device).toMatchObject({
          tenantId: TENANT_A,
          productId: 'product-1',
          deviceId: 'device-1',
        });

        // The second enrollment is the one that must not reach registration.
        expect(await stores.pairing.redeemAndRegister(enrollment('code-1', 'device-2'))).toBeUndefined();
        expect(await stores.devices.list(TENANT_A)).toHaveLength(1);
      });
    });

    it('answers undefined for a code that was never minted', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        expect(await stores.pairing.redeemAndRegister(enrollment('never-minted', 'device-1'))).toBeUndefined();
      });
    });

    it('answers undefined once the code has expired', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        await stores.pairingCodes.issue(TENANT_A, {
          code: 'code-2',
          productId: 'product-1',
          expiresAt: new Date(Date.parse(handle.now()) + CODE_TTL_MS).toISOString(),
        });

        await handle.advanceTime(CODE_TTL_MS + 1);

        expect(await stores.pairing.redeemAndRegister(enrollment('code-2', 'device-1'))).toBeUndefined();
      });
    });

    it('does not consume a code it rejected as expired', async () => {
      // An expired code that stays un-consumed is the honest state: nothing
      // succeeded, so nothing was spent. A composition that marks it used on
      // the failed path is hiding a write behind a rejection.
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        await stores.pairingCodes.issue(TENANT_A, {
          code: 'code-3',
          productId: 'product-1',
          expiresAt: new Date(Date.parse(handle.now()) + CODE_TTL_MS).toISOString(),
        });

        await handle.advanceTime(CODE_TTL_MS + 1);
        expect(await stores.pairing.redeemAndRegister(enrollment('code-3', 'device-1'))).toBeUndefined();

        // Re-issuing the same code with a fresh deadline must work: the row was
        // never spent, and a mint is the host's control plane speaking.
        await stores.pairingCodes.issue(TENANT_A, {
          code: 'code-3',
          productId: 'product-2',
          expiresAt: new Date(Date.parse(handle.now()) + CODE_TTL_MS).toISOString(),
        });
        expect(await stores.pairing.redeemAndRegister(enrollment('code-3', 'device-2'))).toMatchObject({
          tenantId: TENANT_A,
          productId: 'product-2',
        });
      });
    });

    it('serializes concurrent enrollment of one code to one registered device', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        await stores.pairingCodes.issue(TENANT_A, {
          code: 'code-concurrent',
          productId: 'product-1',
          expiresAt: new Date(Date.parse(handle.now()) + CODE_TTL_MS).toISOString(),
        });

        const results = await Promise.all([
          stores.pairing.redeemAndRegister(enrollment('code-concurrent', 'device-a')),
          stores.pairing.redeemAndRegister(enrollment('code-concurrent', 'device-b')),
        ]);
        const enrolled = results.filter((device) => device !== undefined);
        expect(enrolled).toHaveLength(1);
        expect(await stores.devices.list(TENANT_A)).toHaveLength(1);
      });
    });
  });
}
