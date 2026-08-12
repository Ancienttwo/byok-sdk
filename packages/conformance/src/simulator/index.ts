/**
 * Entry point of the pairing-simulator conformance suite.
 *
 * Same posture as the sibling suites: a private workspace package, never
 * published. Unlike them, the assertions here are not this package's own — the
 * four negatives come from `@byok-sdk/testkit`, which ships them to downstream
 * hosts. What this suite adds is the proof that they run green against a real
 * deployment and red against inputs that should not trip them.
 */
export {
  runPairingSimulatorConformance,
  withPairingSimulatorComposition,
} from './harness';
export type {
  PairingSimulatorComposition,
  PairingSimulatorCompositionFactory,
} from './harness';
