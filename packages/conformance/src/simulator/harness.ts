/**
 * The pairing-simulator conformance suite: `@byok-sdk/testkit` driven against a
 * real deployment, over the real device wire.
 *
 * Why this suite is separate from `runCloudConformance` rather than another
 * file inside it: that suite certifies a composition's cloud-local STORE PORTS,
 * and a composition supplies stores. This one certifies a MOUNTED DEVICE
 * SURFACE — three auth routes, a presence route, and the host control plane
 * behind them — and a composition supplies a base URL, a fetch, a way to mint a
 * pairing code, and a `SimulatorHost`. Folding the two together would force
 * every store-port composition to stand up an HTTP surface it has no opinion
 * about.
 *
 * What passing this suite means, concretely: a downstream host can delete the
 * hand-written protocol section of its own smoke test — the Ed25519/JWK
 * export, the `byok-nonce-v1` domain, the pair/challenge/token/presence/revoke
 * sequence, and the four negative assertions — and call the simulator instead,
 * because those exact assertions are proven here against a running surface.
 *
 * The negative assertions get two blocks, not one. A negative assertion that
 * cannot go red is decoration: `expect(response.status).toBe(401)` passes just
 * as well against a route that 401s everything, including the happy path. So
 * each of the four is first pointed at an input that must NOT trip it and
 * asserted to report failure, and only then run in its real form.
 */
import { describe, expect, it } from 'vitest';
import {
  assertPairingCodeSingleUse,
  assertRevokedDeviceChallengeRejected,
  assertUnauthenticatedRejected,
  assertUndomainedSignatureRejected,
  createDeviceSimulator,
  failedAssertions,
  runNegativeAssertions,
  type DeviceSimulator,
  type SimulatorHost,
} from '@byok-sdk/testkit';

/** One live deployment under test. */
export interface PairingSimulatorComposition {
  /** Origin the device routes are mounted at. */
  readonly baseUrl: string;
  /** How a request reaches them — a socket, or the composition's own fetch handler. */
  readonly fetch: typeof globalThis.fetch;
  /** Host control plane: mint one fresh single-use pairing code. */
  createPairingCode(): Promise<string>;
  /** Host control plane: presence read-back and revocation, the two halves the SDK mounts no route for. */
  readonly host: SimulatorHost;
  /** Optional teardown for compositions holding connections. */
  dispose?(): void | Promise<void>;
}

export interface PairingSimulatorCompositionFactory {
  create(): PairingSimulatorComposition | Promise<PairingSimulatorComposition>;
}

/** Runs a test body against a fresh deployment and disposes it afterwards. */
export async function withPairingSimulatorComposition(
  factory: PairingSimulatorCompositionFactory,
  body: (composition: PairingSimulatorComposition) => Promise<void>,
): Promise<void> {
  const composition = await factory.create();
  try {
    await body(composition);
  } finally {
    await composition.dispose?.();
  }
}

/** A simulator that has completed `pair()`, plus the code it burned doing so. */
async function pairedSimulator(
  composition: PairingSimulatorComposition,
  deviceName = 'conformance-device',
): Promise<{ simulator: DeviceSimulator; pairingCode: string }> {
  const simulator = await createDeviceSimulator({
    baseUrl: composition.baseUrl,
    fetch: composition.fetch,
    host: composition.host,
  });
  const pairingCode = await composition.createPairingCode();
  await simulator.pair(pairingCode, deviceName);
  return { simulator, pairingCode };
}

export function runPairingSimulatorConformance(
  name: string,
  factory: PairingSimulatorCompositionFactory,
): void {
  describe(`pairing simulator (${name})`, () => {
    describe('five primitives', () => {
      it('pairs a freshly generated device identity', async () => {
        await withPairingSimulatorComposition(factory, async (composition) => {
          const { simulator } = await pairedSimulator(composition);
          const session = simulator.session;
          expect(session).toBeDefined();
          expect(session?.deviceId.length ?? 0).toBeGreaterThan(0);
          // A JWT, not an opaque handle — three base64url segments.
          expect(session?.accessToken.split('.')).toHaveLength(3);
          // The wire encoding a host copies into `devicePublicKey`.
          expect(simulator.identity.publicKeyBase64Url).toMatch(/^[A-Za-z0-9_-]{43}$/);
        });
      });

      it('renews a token through challenge and a domain-separated signature', async () => {
        await withPairingSimulatorComposition(factory, async (composition) => {
          const { simulator } = await pairedSimulator(composition);
          const deviceId = simulator.session!.deviceId;

          const nonce = await simulator.challenge(deviceId);
          expect(nonce.length).toBeGreaterThan(0);

          // The wire-faithful form: the signature is supplied, never assumed by
          // the primitive, which is what lets the negative assertion below send
          // a different one through the identical call.
          const accessToken = await simulator.token({
            deviceId,
            nonce,
            signature: await simulator.identity.signNonce(nonce),
          });
          expect(accessToken.split('.')).toHaveLength(3);

          // A nonce is single-use: replaying the same one is refused.
          await expect(
            simulator.token({
              deviceId,
              nonce,
              signature: await simulator.identity.signNonce(nonce),
            }),
          ).rejects.toMatchObject({ status: 401 });
        });
      });

      it('publishes presence under the device bearer and the host reads it back', async () => {
        await withPairingSimulatorComposition(factory, async (composition) => {
          const { simulator } = await pairedSimulator(composition);
          const deviceId = simulator.session!.deviceId;

          // Renewal first, so the token presence is published with is the one
          // the challenge/token pair produced, not only the pairing token.
          await simulator.renewAccessToken();
          await simulator.publishPresence('working', 'conformance detail');

          const hints = await simulator.readHostPresence();
          const mine = hints.find((hint) => hint.deviceId === deviceId);
          expect(mine).toBeDefined();
          expect(mine?.level).toBe('working');
          expect(mine?.detail).toBe('conformance detail');
        });
      });

      it('revokes the device through the host control plane', async () => {
        await withPairingSimulatorComposition(factory, async (composition) => {
          const { simulator } = await pairedSimulator(composition);
          const deviceId = simulator.session!.deviceId;

          // Live before, dead after — asserted through the device's own surface
          // rather than through the store, because the 401 is the contract.
          expect((await simulator.challenge(deviceId)).length).toBeGreaterThan(0);
          await simulator.revoke();
          await expect(simulator.challenge(deviceId)).rejects.toMatchObject({ status: 401 });
        });
      });
    });

    describe('negative assertions can fail', () => {
      it('unauthenticated: a public route reports failure', async () => {
        await withPairingSimulatorComposition(factory, async (composition) => {
          const { simulator } = await pairedSimulator(composition);
          // `GET /byok/capabilities` is mounted unconditionally and public
          // (ADR-010), so an assertion that "no credential means 401" must go
          // red against it.
          const red = await assertUnauthenticatedRejected(simulator, {
            method: 'GET',
            path: '/byok/capabilities',
          });
          expect(red.ok).toBe(false);
          expect(red.actual).toBe('HTTP 200');
        });
      });

      it('pairing single-use: an unused code reports failure', async () => {
        await withPairingSimulatorComposition(factory, async (composition) => {
          const { simulator } = await pairedSimulator(composition);
          const fresh = await composition.createPairingCode();
          const red = await assertPairingCodeSingleUse(simulator, fresh);
          expect(red.ok).toBe(false);
          expect(red.actual).toBe('HTTP 200');
        });
      });

      it('undomained signature: the domain-separated signature reports failure', async () => {
        await withPairingSimulatorComposition(factory, async (composition) => {
          const { simulator } = await pairedSimulator(composition);
          const red = await assertUndomainedSignatureRejected(simulator, {
            domainSeparated: true,
          });
          expect(red.ok).toBe(false);
          expect(red.actual).toBe('HTTP 200');
        });
      });

      it('post-revocation challenge: a live device reports failure', async () => {
        await withPairingSimulatorComposition(factory, async (composition) => {
          const { simulator } = await pairedSimulator(composition);
          const red = await assertRevokedDeviceChallengeRejected(simulator);
          expect(red.ok).toBe(false);
          expect(red.actual).toBe('HTTP 200');
        });
      });
    });

    describe('negative assertions hold', () => {
      it('rejects an uncredentialed request to a credentialed route', async () => {
        await withPairingSimulatorComposition(factory, async (composition) => {
          const { simulator } = await pairedSimulator(composition);
          expect(await assertUnauthenticatedRejected(simulator)).toMatchObject({
            name: 'unauthenticated-request-rejected',
            ok: true,
            actual: 'HTTP 401',
          });
        });
      });

      it('rejects a second redemption of the same pairing code', async () => {
        await withPairingSimulatorComposition(factory, async (composition) => {
          const { simulator, pairingCode } = await pairedSimulator(composition);
          expect(await assertPairingCodeSingleUse(simulator, pairingCode)).toMatchObject({
            name: 'pairing-code-single-use',
            ok: true,
            actual: 'HTTP 401',
          });
        });
      });

      it('rejects a signature over the bare nonce', async () => {
        await withPairingSimulatorComposition(factory, async (composition) => {
          const { simulator } = await pairedSimulator(composition);
          expect(await assertUndomainedSignatureRejected(simulator)).toMatchObject({
            name: 'undomained-signature-rejected',
            ok: true,
            actual: 'HTTP 401',
          });
        });
      });

      it('rejects a challenge from a revoked device', async () => {
        await withPairingSimulatorComposition(factory, async (composition) => {
          const { simulator } = await pairedSimulator(composition);
          await simulator.revoke();
          expect(await assertRevokedDeviceChallengeRejected(simulator)).toMatchObject({
            name: 'revoked-device-challenge-rejected',
            ok: true,
            actual: 'HTTP 401',
          });
        });
      });

      it('runs all four in one pass, ending revoked', async () => {
        await withPairingSimulatorComposition(factory, async (composition) => {
          const { simulator, pairingCode } = await pairedSimulator(composition);
          const results = await runNegativeAssertions(simulator, {
            redeemedPairingCode: pairingCode,
          });
          expect(results.map((entry) => entry.name)).toEqual([
            'unauthenticated-request-rejected',
            'pairing-code-single-use',
            'undomained-signature-rejected',
            'revoked-device-challenge-rejected',
          ]);
          expect(failedAssertions(results)).toEqual([]);
        });
      });
    });
  });
}
