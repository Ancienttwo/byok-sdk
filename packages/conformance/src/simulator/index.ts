/**
 * Entry point of the pairing-simulator conformance suite.
 *
 * Same posture as the sibling suites: a private workspace package, never
 * published. Unlike them, the assertions here are not this package's own — the
 * four negatives come from the private `@byok-sdk/testkit` (published up to
 * 0.20.0, repository-internal since 0.21.0). What this suite adds is the proof
 * that they run green against a real deployment and red against inputs that
 * should not trip them.
 */
export {
  runPairingSimulatorConformance,
  withPairingSimulatorComposition,
} from './harness';
export type {
  PairingSimulatorComposition,
  PairingSimulatorCompositionFactory,
} from './harness';
