/**
 * Entry point of the cloud-local conformance suite.
 *
 * Same posture as `../core/index.ts`: a private workspace package, never
 * published. The port method table it asserts against lives in `@byok-sdk/cloud`'s
 * shipped source (`CLOUD_PORT_METHODS`).
 */
export {
  ackAndCollectMailbox,
  conformanceMailbox,
  mailboxAppendHold,
  mailboxExpiryFaults,
  CLOUD_CONFORMANCE_PORTS,
  runCloudConformance,
  withCloudComposition,
} from './harness';
export type {
  CloudCompositionFactory,
  CloudCompositionHandle,
  CloudConformanceMailbox,
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

export { runCloudRetentionConformance } from './retention';
export { runTaskArchiveConformance } from './task-archive';
export { runTaskOutputClosureConformance } from './task-output-closure';

export { runAgentMessageDraftConformance } from './agent-message-draft';
export type { AgentMessageDraftCompositionHandle, AgentMessageDraftCompositionFactory } from './agent-message-draft';
