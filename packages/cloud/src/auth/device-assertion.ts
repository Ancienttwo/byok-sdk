import {
  authenticateDeviceAssertion,
  type AuthenticatedDeviceAssertion,
  type Clock,
  type DeviceAssertionExpectedBinding,
  type DeviceAssertionReplayAuthority,
} from '@byok-sdk/core';
import type { CloudCrypto } from '../crypto/port';
import type { DeviceDirectory } from '../stores/ports';

export interface HostedDeviceAssertionAuthDeps {
  readonly devices: DeviceDirectory;
  readonly crypto: CloudCrypto;
  readonly replay: DeviceAssertionReplayAuthority;
  readonly clock: Clock;
  readonly expected: DeviceAssertionExpectedBinding;
  readonly maxLifetimeMs?: number;
}

/**
 * Hosted composition for an assertion exchange endpoint. The returned
 * principal is current device-directory authority; the assertion is consumed
 * before success is returned. Connector sessions minted afterward remain
 * host-owned and are never represented by this short-lived credential.
 */
export function authenticateHostedDeviceAssertion(
  input: unknown,
  deps: HostedDeviceAssertionAuthDeps,
): Promise<AuthenticatedDeviceAssertion | undefined> {
  return authenticateDeviceAssertion(input, {
    verifier: {
      verify: ({ publicKey, signingInput, signature }) =>
        deps.crypto.verifyEd25519(publicKey, signingInput, signature),
    },
    lookupDevice: async (deviceId) => {
      const row = await deps.devices.resolveByDeviceId(deviceId);
      if (row === undefined) return undefined;
      return {
        tenantId: row.tenantId,
        productId: row.productId,
        deviceId: row.deviceId,
        publicKeyJwkX: row.devicePublicKey,
        revoked: row.revoked,
      };
    },
    replay: deps.replay,
    expected: deps.expected,
    now: deps.clock.now(),
    ...(deps.maxLifetimeMs === undefined ? {} : { maxLifetimeMs: deps.maxLifetimeMs }),
  });
}
