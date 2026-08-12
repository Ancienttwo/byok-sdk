/**
 * The four negative assertions a host's pairing smoke test hand-writes.
 *
 * These are plain async functions on purpose. A negative assertion belongs to
 * the protocol, not to a test runner: the same four have to be runnable from
 * vitest, from a CI script, from a deployment gate, and from a Worker. So each
 * returns a structured {@link NegativeAssertionResult} instead of throwing —
 * the caller decides what a failure means, and a vitest consumer writes
 * `expect(result.ok).toBe(true)` and gets the observed status in the diff.
 *
 * Each one names a defense that must hold, and each is written so that pointing
 * it at the wrong input makes it FAIL. An assertion that cannot go red proves
 * nothing, and the ones here are checked that way in
 * `@byok-sdk/conformance`'s `pairing-simulator` suite before they are trusted
 * green: unauthenticated against a public route, single-use against an unused
 * code, undomained against a properly domained signature, revoked against a
 * device that was never revoked.
 */
import type { DeviceSimulator, SimulatorRequest, SimulatorResponse } from './simulator';
import { DEVICE_ROUTES } from './simulator';

export interface NegativeAssertionResult {
  /** Stable identifier — safe to use as a test name or a CI check id. */
  readonly name: string;
  readonly ok: boolean;
  /** What the protocol requires. */
  readonly expected: string;
  /** What the deployment actually did. */
  readonly actual: string;
  /** The response that decided it, when one status decided it. */
  readonly response?: SimulatorResponse;
}

function result(
  name: string,
  expected: string,
  response: SimulatorResponse,
  expectedStatus: number,
): NegativeAssertionResult {
  return {
    name,
    ok: response.status === expectedStatus,
    expected,
    actual: `HTTP ${response.status}`,
    response,
  };
}

/**
 * A credentialed route answers 401 when the credential is absent.
 *
 * Defaults to `PUT /byok/presence` — the SDK's own credentialed HTTP surface is
 * device-class, because the host control plane (pairing-code mint, presence
 * read, revoke) is in-process and mounts no route. A deployment that publishes
 * its own admin routes passes one here and gets the same assertion against it.
 */
export async function assertUnauthenticatedRejected(
  simulator: DeviceSimulator,
  target: Omit<SimulatorRequest, 'credential'> = {
    method: 'PUT',
    path: DEVICE_ROUTES.presence,
    body: { level: 'online' },
  },
): Promise<NegativeAssertionResult> {
  const response = await simulator.request({ ...target, credential: 'none' });
  return result(
    'unauthenticated-request-rejected',
    `${target.method} ${target.path} without a credential is 401`,
    response,
    401,
  );
}

/**
 * A pairing code is single-use (§6.1): redeeming an already-redeemed code is a
 * 401, indistinguishable from an unknown or expired one.
 *
 * Pass the code THIS simulator (or another one) already paired with. Pointing
 * it at a fresh code pairs a second device and returns `ok: false` — that is
 * the red form.
 */
export async function assertPairingCodeSingleUse(
  simulator: DeviceSimulator,
  redeemedPairingCode: string,
  deviceName = 'byok-testkit-replay',
): Promise<NegativeAssertionResult> {
  const response = await simulator.request({
    method: 'POST',
    path: DEVICE_ROUTES.pair,
    credential: 'none',
    body: {
      pairingCode: redeemedPairingCode,
      deviceName,
      devicePublicKey: simulator.identity.publicKeyBase64Url,
    },
  });
  return result(
    'pairing-code-single-use',
    'a second redemption of the same pairing code is 401',
    response,
    401,
  );
}

/**
 * A signature over the BARE nonce does not renew a token (§6.2, GAP-004).
 *
 * This is the one place in the package that signs something other than
 * `nonceSigningBytes` — and it signs *less*, never a second domain of its own.
 * The whole point is that the undomained encoding has no accepted form
 * anywhere, so there is no dual mode to accidentally validate.
 *
 * Set `domainSeparated: true` to get the red form: the correctly domained
 * signature renews the token, 200, and the assertion reports failure.
 */
export async function assertUndomainedSignatureRejected(
  simulator: DeviceSimulator,
  options: { readonly domainSeparated?: boolean } = {},
): Promise<NegativeAssertionResult> {
  const session = simulator.session;
  if (session === undefined) {
    throw new Error('assertUndomainedSignatureRejected needs a paired device.');
  }

  const nonce = await simulator.challenge(session.deviceId);
  const signature =
    options.domainSeparated === true
      ? await simulator.identity.signNonce(nonce)
      : await simulator.identity.sign(new TextEncoder().encode(nonce));

  const response = await simulator.request({
    method: 'POST',
    path: DEVICE_ROUTES.token,
    credential: 'none',
    body: { deviceId: session.deviceId, nonce, signature },
  });
  return result(
    'undomained-signature-rejected',
    'a signature over the bare nonce, without the signing domain, is 401',
    response,
    401,
  );
}

/**
 * A revoked device cannot start a renewal (§6.3): its next `/byok/challenge` is
 * a 401, indistinguishable from an unknown device.
 *
 * Does NOT revoke anything itself — revocation is the host's act, so the caller
 * revokes and then asserts. Calling it before revoking is the red form.
 */
export async function assertRevokedDeviceChallengeRejected(
  simulator: DeviceSimulator,
): Promise<NegativeAssertionResult> {
  const session = simulator.session;
  if (session === undefined) {
    throw new Error('assertRevokedDeviceChallengeRejected needs a paired device.');
  }

  const response = await simulator.request({
    method: 'POST',
    path: DEVICE_ROUTES.challenge,
    credential: 'none',
    body: { deviceId: session.deviceId },
  });
  return result(
    'revoked-device-challenge-rejected',
    'a revoked device asking for a challenge is 401',
    response,
    401,
  );
}

export interface NegativeSuiteInput {
  /** A pairing code this simulator has already redeemed. */
  readonly redeemedPairingCode: string;
  /** Optional non-default target for the unauthenticated check (e.g. a host admin route). */
  readonly unauthenticatedTarget?: Omit<SimulatorRequest, 'credential'>;
}

/**
 * All four, in the only order they can run in: revocation is terminal for this
 * device, so the checks that need a live session go first.
 */
export async function runNegativeAssertions(
  simulator: DeviceSimulator,
  input: NegativeSuiteInput,
): Promise<readonly NegativeAssertionResult[]> {
  const results: NegativeAssertionResult[] = [
    input.unauthenticatedTarget === undefined
      ? await assertUnauthenticatedRejected(simulator)
      : await assertUnauthenticatedRejected(simulator, input.unauthenticatedTarget),
    await assertPairingCodeSingleUse(simulator, input.redeemedPairingCode),
    await assertUndomainedSignatureRejected(simulator),
  ];
  await simulator.revoke();
  results.push(await assertRevokedDeviceChallengeRejected(simulator));
  return results;
}

/** Every failed assertion in `results`, for a caller that wants one error instead of four booleans. */
export function failedAssertions(
  results: readonly NegativeAssertionResult[],
): readonly NegativeAssertionResult[] {
  return results.filter((entry) => !entry.ok);
}
