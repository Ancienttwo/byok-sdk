import {
  authenticateDeviceAssertion,
  authenticateTaskAssertion,
  type AuthenticatedDeviceAssertion,
  type AuthenticatedTaskAssertion,
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

/**
 * The task lane needs exactly the same hosted authorities as the device lane —
 * the same directory rows, the same verifier, the same replay ledger, the same
 * clock and the same expected binding. An alias rather than a second interface,
 * because two structurally identical declarations are two places for the
 * hosted composition's requirements to drift apart.
 */
export type HostedTaskAssertionAuthDeps = HostedDeviceAssertionAuthDeps;

/**
 * Hosted composition for the task-scoped tool-authority exchange
 * (`byok-task-assertion-v1`, contract §8.1 / §8.2(2)).
 *
 * Everything §8.2(2) puts on this side is here or in the core function it
 * composes: strict parse, the CURRENT device row (exists, not revoked, legal
 * key), signature, exact issuer/product/audience, valid time window, the TTL
 * ceiling, and one atomic `jti` consumption under the task lane's own `schema`
 * segment — so the same `jti` presented as a device assertion and as a task
 * assertion occupies two key slots and neither lane can burn the other's. The
 * replay segment is chosen inside core from the envelope kind; this function
 * deliberately has no say in it, because a caller able to name the segment
 * would be a caller able to spend the other lane's key.
 *
 * A DEVICE envelope presented here authenticates as `undefined`, always: §8.1
 * gives the task lane zero acceptance and zero fallback, and that is a property
 * of core's parser (`parseTaskAssertionEnvelope`), not a branch anyone here
 * could relax.
 *
 * A replay store that cannot answer REJECTS the promise rather than resolving
 * to a principal — §8.2(2)'s "an unavailable replay store fails, it does not
 * downgrade authentication". A host turns that into an availability error; it
 * must never turn it into signature-only acceptance.
 *
 * What this deliberately does NOT do is the frozen-offer check — that the
 * task, AgentRef and toolset in the claims belong to THIS Execution, and that
 * the Execution still permits a new tool call. That authority is the host's
 * (§8.2(3)), and a parameter for it here would be an invitation to synthesize
 * it. This function's answer is "these claims are authentic and spent once",
 * never "this invocation is admitted".
 */
export function authenticateHostedTaskAssertion(
  input: unknown,
  deps: HostedTaskAssertionAuthDeps,
): Promise<AuthenticatedTaskAssertion | undefined> {
  return authenticateTaskAssertion(input, {
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
