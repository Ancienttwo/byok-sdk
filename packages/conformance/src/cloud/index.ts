/**
 * Entry point of the cloud-local conformance suite.
 *
 * Same posture as `../core/index.ts`: a private workspace package, never
 * published. The port method table it asserts against lives in `@byok-sdk/cloud`'s
 * shipped source (`CLOUD_PORT_METHODS`).
 */
export { CLOUD_CONFORMANCE_PORTS, runCloudConformance, withCloudComposition } from './harness';
export type {
  CloudCompositionFactory,
  CloudCompositionHandle,
  CloudConformancePortName,
  CloudConformanceStores,
} from './harness';
export { runActivityConformance } from './activity';
export type { ActivityCompositionFactory, ActivityCompositionHandle } from './activity';
export { runApprovalTimelineConformance } from './approval-timeline';
export type {
  ApprovalTimelineCompositionFactory,
  ApprovalTimelineCompositionHandle,
} from './approval-timeline';
