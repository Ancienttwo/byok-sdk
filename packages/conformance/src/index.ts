/**
 * `@byok-sdk/conformance` — one assertion source, every composition.
 *
 * A private workspace package that is never published and has no build step:
 * consumers resolve its TypeScript directly, which is fine because every
 * consumer is a test in this repo.
 *
 * The dependency direction is strictly one way — `conformance → core + cloud`,
 * and nothing here depends on a durable adapter. A composition that wants to be
 * certified takes THIS package as a devDependency and calls
 * `runCoreConformance` / `runCloudConformance` with a factory, which is why
 * `@byok-sdk/cloud-dataplane` owns its own composition entry rather than this
 * package owning a file that imports it: an adapter⇄suite cycle is exactly the
 * edge that moving `CORE_PORT_*` into core's shipped source was meant to break.
 */
export { runCoreConformance, withComposition } from './core/index';
export type { CoreCompositionFactory, CoreCompositionHandle } from './core/index';

export { CLOUD_CONFORMANCE_PORTS, runCloudConformance, withCloudComposition } from './cloud/index';
export type {
  CloudCompositionFactory,
  CloudCompositionHandle,
  CloudConformancePortName,
  CloudConformanceStores,
} from './cloud/index';
export { runActivityConformance } from './cloud/activity';
export type { ActivityCompositionFactory, ActivityCompositionHandle } from './cloud/activity';
export { runApprovalTimelineConformance } from './cloud/approval-timeline';
export type {
  ApprovalTimelineCompositionFactory,
  ApprovalTimelineCompositionHandle,
} from './cloud/approval-timeline';
export { runDeviceAssertionReplayConformance } from './device-assertion-replay';
export type {
  DeviceAssertionReplayCompositionFactory,
  DeviceAssertionReplayCompositionHandle,
} from './device-assertion-replay';

export {
  runPairingSimulatorConformance,
  withPairingSimulatorComposition,
} from './simulator/index';
export type {
  PairingSimulatorComposition,
  PairingSimulatorCompositionFactory,
} from './simulator/index';
