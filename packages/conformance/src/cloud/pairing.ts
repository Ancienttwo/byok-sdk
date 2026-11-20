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
 * `redeemAndRegister` answers `code_invalid` for unknown, expired, and
 * already-used alike. The distinction is exactly what an attacker enumerating
 * codes would pay for, so no composition may make it observable.
 *
 * Registration fencing (#2045, docs/protocol.md §6.1): with a `machineId`, a
 * registration supersedes the machine's current device only when its
 * `expectedDeviceDigest` names that device. One case per interleaving the
 * fence must close; a `conflict` writes nothing and consumes no code.
 */
import { describe, expect, it } from 'vitest';
import type { TenantId } from '@byok-sdk/core';
import { deviceDigest, registration, TENANT_A, TENANT_B } from './fixtures';
import { withCloudComposition, type CloudCompositionFactory } from './harness';

const CODE_TTL_MS = 10 * 60 * 1000;

const MACHINE = 'c'.repeat(64);

function enrollment(
  pairingCode: string,
  deviceId: string,
  overrides: { readonly machineId?: string; readonly expectedDeviceDigest?: string | null; readonly deviceName?: string; readonly devicePublicKey?: string } = {},
) {
  return {
    pairingCode,
    deviceId,
    deviceName: `name-${deviceId}`,
    devicePublicKey: `pk-${deviceId}`,
    proofKeyId: 'identity',
    proofKeyEpoch: 0,
    expectedDeviceDigest: null,
    ...overrides,
  };
}

const CODE_INVALID = { outcome: 'code_invalid' } as const;

async function conflictWith(tenant: TenantId, deviceId: string | null, productId = 'product-1') {
  return { outcome: 'conflict', currentDeviceDigest: deviceId === null ? null : await deviceDigest(tenant, deviceId, productId) } as const;
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
          clientVersion: 'test-client', protocolVersions: [2], harnesses: [{ id: 'pi', authPresent: true, capabilities: { selectionModes: ['byok-profile'], effort: false } }],
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
            clientVersion: 'test-client', protocolVersions: [2], harnesses: [{ id: 'pi', authPresent: true, capabilities: { selectionModes: ['byok-profile'], effort: false } }],
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
          outcome: 'registered',
          device: { tenantId: TENANT_A, productId: 'product-1', deviceId: 'device-1' },
        });

        // The second enrollment is the one that must not reach registration.
        expect(await stores.pairing.redeemAndRegister(enrollment('code-1', 'device-2'))).toEqual(CODE_INVALID);
        expect(await stores.devices.list(TENANT_A)).toHaveLength(1);
      });
    });

    it('answers code_invalid for a code that was never minted', async () => {
      await withCloudComposition(factory, async ({ stores }) => {
        expect(await stores.pairing.redeemAndRegister(enrollment('never-minted', 'device-1'))).toEqual(CODE_INVALID);
      });
    });

    it('answers code_invalid once the code has expired', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        await stores.pairingCodes.issue(TENANT_A, {
          code: 'code-2',
          productId: 'product-1',
          expiresAt: new Date(Date.parse(handle.now()) + CODE_TTL_MS).toISOString(),
        });

        await handle.advanceTime(CODE_TTL_MS + 1);

        expect(await stores.pairing.redeemAndRegister(enrollment('code-2', 'device-1'))).toEqual(CODE_INVALID);
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
        expect(await stores.pairing.redeemAndRegister(enrollment('code-3', 'device-1'))).toEqual(CODE_INVALID);

        // Re-issuing the same code with a fresh deadline must work: the row was
        // never spent, and a mint is the host's control plane speaking.
        await stores.pairingCodes.issue(TENANT_A, {
          code: 'code-3',
          productId: 'product-2',
          expiresAt: new Date(Date.parse(handle.now()) + CODE_TTL_MS).toISOString(),
        });
        expect(await stores.pairing.redeemAndRegister(enrollment('code-3', 'device-2'))).toMatchObject({
          outcome: 'registered',
          device: { tenantId: TENANT_A, productId: 'product-2' },
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
        const enrolled = results.filter((result) => result.outcome === 'registered');
        expect(enrolled).toHaveLength(1);
        expect(await stores.devices.list(TENANT_A)).toHaveLength(1);
      });
    });
  });

  describe('registration fencing (#2045)', () => {
    type Handle = Parameters<Parameters<typeof withCloudComposition>[1]>[0];
    const issue = async (handle: Handle, code: string, tenant: TenantId = TENANT_A, productId = 'product-1') => {
      await handle.stores.pairingCodes.issue(tenant, {
        code,
        productId,
        expiresAt: new Date(Date.parse(handle.now()) + CODE_TTL_MS).toISOString(),
      });
    };
    const ids = async (handle: Handle, tenant: TenantId = TENANT_A) =>
      (await handle.stores.devices.list(tenant)).map((device) => device.deviceId).sort();

    it('supersedes the current device when the fence names it, and consumes the code', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        await issue(handle, 'fence-1');
        await issue(handle, 'fence-2');
        expect(await stores.pairing.redeemAndRegister(enrollment('fence-1', 'device-1', { machineId: MACHINE })))
          .toMatchObject({ outcome: 'registered', device: { deviceId: 'device-1' } });

        const expectedDeviceDigest = await deviceDigest(TENANT_A, 'device-1');
        expect(await stores.pairing.redeemAndRegister(enrollment('fence-2', 'device-2', { machineId: MACHINE, expectedDeviceDigest })))
          .toMatchObject({ outcome: 'registered', device: { deviceId: 'device-2' } });
        expect(await ids(handle)).toEqual(['device-2']);
        expect(await stores.pairing.redeemAndRegister(enrollment('fence-2', 'device-3', { machineId: MACHINE, expectedDeviceDigest })))
          .toEqual(CODE_INVALID);
      });
    });

    it('answers a stale fence with conflict, writes nothing, and leaves the code redeemable', async () => {
      // The original F1 race and its timeout variant: a delayed request still
      // names the device its successor already superseded.
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        for (const code of ['stale-1', 'stale-2', 'stale-3']) await issue(handle, code);
        await stores.pairing.redeemAndRegister(enrollment('stale-1', 'device-1', { machineId: MACHINE }));
        const stale = await deviceDigest(TENANT_A, 'device-1');
        await stores.pairing.redeemAndRegister(enrollment('stale-2', 'device-2', { machineId: MACHINE, expectedDeviceDigest: stale }));

        expect(await stores.pairing.redeemAndRegister(enrollment('stale-3', 'device-3', { machineId: MACHINE, expectedDeviceDigest: stale })))
          .toEqual(await conflictWith(TENANT_A, 'device-2'));
        expect(await ids(handle)).toEqual(['device-2']);

        // The same code with the current digest proves the conflict consumed nothing.
        const current = await deviceDigest(TENANT_A, 'device-2');
        expect(await stores.pairing.redeemAndRegister(enrollment('stale-3', 'device-3', { machineId: MACHINE, expectedDeviceDigest: current })))
          .toMatchObject({ outcome: 'registered', device: { deviceId: 'device-3' } });
        expect(await ids(handle)).toEqual(['device-3']);
      });
    });

    it('lets the owner adopt an orphan whose registration response was lost', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        await issue(handle, 'orphan-a');
        await issue(handle, 'orphan-b');
        await stores.pairing.redeemAndRegister(enrollment('orphan-a', 'device-a', { machineId: MACHINE }));

        // The successor still believes the machine has no device.
        const conflict = await stores.pairing.redeemAndRegister(enrollment('orphan-b', 'device-b', { machineId: MACHINE }));
        expect(conflict).toEqual(await conflictWith(TENANT_A, 'device-a'));
        if (conflict.outcome !== 'conflict') throw new Error('expected a conflict');

        expect(await stores.pairing.redeemAndRegister(enrollment('orphan-b', 'device-b', {
          machineId: MACHINE,
          expectedDeviceDigest: conflict.currentDeviceDigest,
        }))).toMatchObject({ outcome: 'registered', device: { deviceId: 'device-b' } });
        expect(await ids(handle)).toEqual(['device-b']);
      });
    });

    it('replays a consumed code before reading the fence, and keeps the fence out of the binding', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        await issue(handle, 'replay-1');
        const first = await stores.pairing.redeemAndRegister(enrollment('replay-1', 'device-1', { machineId: MACHINE }));
        expect(first).toMatchObject({ outcome: 'registered', device: { deviceId: 'device-1' } });

        // A retry mints a fresh device id at the route, as the real entry
        // does, so the id is not part of the binding. The machine's current
        // device is now device-1, so a fence read would answer conflict to
        // the null retry; the replay answers first.
        const binding = { machineId: MACHINE, deviceName: 'name-device-1', devicePublicKey: 'pk-device-1' };
        for (const [retryId, expectedDeviceDigest] of [['device-1-retry-a', null], ['device-1-retry-b', await deviceDigest(TENANT_A, 'device-1')]] as const) {
          expect(await stores.pairing.redeemAndRegister(enrollment('replay-1', retryId, { ...binding, expectedDeviceDigest })))
            .toEqual(first);
        }
        expect(await ids(handle)).toEqual(['device-1']);
      });
    });

    it('never retires another device for a registration without machineId, whatever its fence says', async () => {
      // The premise of the fence: only machine supersession retires a device,
      // so a registration without machineId needs no fence.
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        await stores.devices.register(TENANT_A, registration('machine-device', { machineId: MACHINE }));
        await stores.devices.register(TENANT_A, registration('plain-device'));
        const unrelated = await deviceDigest(TENANT_A, 'never-registered');

        expect(await stores.devices.register(TENANT_A, registration('plain-direct', { expectedDeviceDigest: unrelated })))
          .toMatchObject({ outcome: 'registered', device: { deviceId: 'plain-direct' } });
        await issue(handle, 'plain-code');
        expect(await stores.pairing.redeemAndRegister(enrollment('plain-code', 'plain-paired', { expectedDeviceDigest: unrelated })))
          .toMatchObject({ outcome: 'registered', device: { deviceId: 'plain-paired' } });
        expect(await ids(handle)).toEqual(['machine-device', 'plain-device', 'plain-direct', 'plain-paired']);
      });
    });

    for (const current of [null, 'race-current'] as const) {
      it(`lets exactly one of two concurrent pairings of one machine pass the same fence (current device: ${current ?? 'none'})`, async () => {
        // Both cases: a fence read outside the atomic section lets both
        // pairings match a current device, while one with none can still
        // serialize on the insert.
        await withCloudComposition(factory, async (handle) => {
          const { stores } = handle;
          if (current !== null) await stores.devices.register(TENANT_A, registration(current, { machineId: MACHINE }));
          await issue(handle, 'race-a');
          await issue(handle, 'race-b');
          const expectedDeviceDigest = current === null ? null : await deviceDigest(TENANT_A, current);

          const results = await Promise.all([
            stores.pairing.redeemAndRegister(enrollment('race-a', 'device-a', { machineId: MACHINE, expectedDeviceDigest })),
            stores.pairing.redeemAndRegister(enrollment('race-b', 'device-b', { machineId: MACHINE, expectedDeviceDigest })),
          ]);
          const winners = results.flatMap((result) => (result.outcome === 'registered' ? [result.device.deviceId] : []));
          expect(winners).toHaveLength(1);
          const loser = results.find((result) => result.outcome !== 'registered');
          expect(loser).toEqual(await conflictWith(TENANT_A, winners[0]!));
          expect(await ids(handle)).toEqual(winners);
        });
      });
    }

    it('scopes the fence to tenant and product', async () => {
      // The same machine pairs into another tenant or product without seeing,
      // or retiring, this one's device.
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        await issue(handle, 'scope-a1');
        await issue(handle, 'scope-a2', TENANT_A, 'product-2');
        await issue(handle, 'scope-b1', TENANT_B);
        await stores.pairing.redeemAndRegister(enrollment('scope-a1', 'device-a1', { machineId: MACHINE }));

        expect(await stores.pairing.redeemAndRegister(enrollment('scope-a2', 'device-a2', { machineId: MACHINE })))
          .toMatchObject({ outcome: 'registered', device: { productId: 'product-2' } });
        expect(await stores.pairing.redeemAndRegister(enrollment('scope-b1', 'device-b1', { machineId: MACHINE })))
          .toMatchObject({ outcome: 'registered', device: { tenantId: TENANT_B } });
        expect(await ids(handle)).toEqual(['device-a1', 'device-a2']);
        expect(await ids(handle, TENANT_B)).toEqual(['device-b1']);
      });
    });

    it('answers conflict with no current device after the named device was revoked', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        await stores.devices.register(TENANT_A, registration('revoked-current', { machineId: MACHINE }));
        await stores.devices.revoke(TENANT_A, 'revoked-current');
        await issue(handle, 'after-revoke');
        const stale = await deviceDigest(TENANT_A, 'revoked-current');

        expect(await stores.pairing.redeemAndRegister(enrollment('after-revoke', 'device-new', { machineId: MACHINE, expectedDeviceDigest: stale })))
          .toEqual(await conflictWith(TENANT_A, null));
        expect(await stores.pairing.redeemAndRegister(enrollment('after-revoke', 'device-new', { machineId: MACHINE })))
          .toMatchObject({ outcome: 'registered', device: { deviceId: 'device-new' } });
      });
    });

    it('fences DeviceDirectory.register itself, not only pairing', async () => {
      await withCloudComposition(factory, async (handle) => {
        const { stores } = handle;
        await stores.devices.register(TENANT_A, registration('direct-1', { machineId: MACHINE }));

        expect(await stores.devices.register(TENANT_A, registration('direct-2', { machineId: MACHINE })))
          .toEqual(await conflictWith(TENANT_A, 'direct-1'));
        expect(await ids(handle)).toEqual(['direct-1']);
        expect(await stores.devices.register(TENANT_A, registration('direct-2', {
          machineId: MACHINE,
          expectedDeviceDigest: await deviceDigest(TENANT_A, 'direct-1'),
        }))).toMatchObject({ outcome: 'registered', device: { deviceId: 'direct-2' } });
        expect(await ids(handle)).toEqual(['direct-2']);
      });
    });
  });
}
