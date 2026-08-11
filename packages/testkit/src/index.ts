/**
 * `@byok-sdk/testkit` — the device end of docs/protocol.md §6, headless.
 *
 * A host integrating the SDK needs a smoke test that proves a real device can
 * pair, renew a token, publish presence, and be revoked. Written by hand, that
 * test carries upstream knowledge downstream — the JWK export shape, the nonce
 * signing domain, the three auth route DTOs — and goes quietly green against
 * nothing when upstream changes any of them. This package is that knowledge,
 * shipped from the same repo it belongs to.
 *
 * Runtime dependencies are `@byok-sdk/core` (the signing bytes) and
 * `@byok-sdk/protocol` (the wire DTOs), and nothing else. In particular there
 * is no test framework here: the negative assertions are async functions
 * returning structured results, so the same four checks run under vitest, under
 * a plain CI script, and inside a Worker.
 */
export { DEVICE_PUBLIC_KEY_LENGTH, createDeviceIdentity } from './identity';
export type { DeviceIdentity } from './identity';

export { DEFAULT_DEVICE_NAME, DEVICE_ROUTES, DeviceSimulatorError, createDeviceSimulator } from './simulator';
export type {
  Credential,
  DeviceSession,
  DeviceSimulator,
  DeviceSimulatorOptions,
  SimulatorHost,
  SimulatorRequest,
  SimulatorResponse,
} from './simulator';

export {
  assertPairingCodeSingleUse,
  assertRevokedDeviceChallengeRejected,
  assertUnauthenticatedRejected,
  assertUndomainedSignatureRejected,
  failedAssertions,
  runNegativeAssertions,
} from './negatives';
export type { NegativeAssertionResult, NegativeSuiteInput } from './negatives';
