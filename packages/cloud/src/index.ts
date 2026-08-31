/**
 * `@byok-sdk/cloud` — the hosted device surface.
 *
 * Cloud sits BESIDE `@byok-sdk/server`, not above it (§12.1): `cloud → core +
 * protocol`, and never `cloud → server`. The self-hosted embedded coordinator
 * stays the self-hosted option; this package serves the same frozen v1 device
 * wire contract statelessly, over `@byok-sdk/core` ports plus the cloud-local auth
 * and task ports in `stores/ports.ts`.
 *
 * `src/__tests__/constraints.test.ts` asserts the properties this export list
 * implies: no `@byok-sdk/server` import, no `node:` import, no module-level
 * mutable state, no session/Running map, and no route mounted outside the I1
 * registry.
 */

// Tenant identity. RE-exported from `@byok-sdk/core`, never redefined: core owns
// the single mint point, and every control-plane function on this package's
// own API takes a `TenantId` first, so a host composing cloud has to be able
// to mint one without reasoning about which package's brand it got.
export { isTenantId, tenantId } from '@byok-sdk/core';
export type { TenantId } from '@byok-sdk/core';

// The composition entry points
export { createByokCloud } from './cloud';
export type {
  ByokCloud,
  ByokCloudOptions,
  AgentDispatchInput,
  AgentEgressDispatchInput,
  AgentEgressFreshSessionDispatchInput,
  AgentContentReadInput,
  AgentHomeProjectionInput,
  AgentHomeProjectionStatusInput,
  EnqueueOfferInput,
  EnqueueToolsetOfferInput,
  EnqueuedAgentControl,
  EnqueuedAgentHomeProjection,
  EnqueuedOffer,
} from './cloud';
export {
  agentHomeProjectionCompletionKey,
  agentHomeProjectionRequestKey,
  readAgentHomeProjectionStatus,
  recordAgentHomeProjectionCompletion,
} from './agent-home-projections';
export type { AgentHomeProjectionReceiptInput } from './agent-home-projections';
export {
  AGENT_HOME_CONTRACT_CAPABILITY,
  DEFAULT_EVENTS_PAGE_LIMIT,
  DEFAULT_LONG_POLL_HOLD_MS,
  DEFAULT_LONG_POLL_INTERVAL_MS,
  DEFAULT_MAX_BLOB_SIZE_BYTES,
} from './cloud';
export {
  DEFAULT_BOARD_PAGE_LIMIT,
  DEFAULT_BOARD_STREAM_HEARTBEAT_INTERVAL_MS,
  DEFAULT_BOARD_STREAM_QUERY_INTERVAL_MS,
  DEFAULT_BOARD_STREAM_RECONCILIATION_INTERVAL_MS,
} from './handlers/board';
export { DEFAULT_SKILL_PACK_PAGE_LIMIT } from './handlers/skill-packs';
export { createInMemoryByokCloud } from './composition/in-memory';
export type { InMemoryByokCloud, InMemoryByokCloudOptions } from './composition/in-memory';

// Errors
export { ByokCloudError, CLOUD_ERROR_CODES, isCloudError } from './errors';
export type { CloudErrorCode } from './errors';

export {
  InMemoryAgentMemoryProjectionAuthorizer,
  InMemoryAgentMemoryProjectionStore,
} from './stores/in-memory/agent-memory-projection';
export type {
  AgentMemoryProjectionAuthorization,
  AgentMemoryProjectionEraseResult,
  AgentMemoryProjectionAuthorizer,
  AgentMemoryProjectionAuthorizerInput,
  AgentMemoryProjectionCommitInput,
  AgentMemoryProjectionMeteringReceipt,
  AgentMemoryProjectionMutation,
  AgentMemoryProjectionReceipt,
  AgentMemoryProjectionStore,
} from './agent-memory-projection';

// Capability declaration (ADR-010)
export {
  CLOUD_CAPABILITIES,
  CapabilitiesResponseSchema,
  declares,
  fullCapabilityDeclaration,
} from './capabilities';
export type {
  CapabilitiesResponse,
  CloudCapability,
  FullCapabilityDeclarationOptions,
} from './capabilities';

// Route inventory (I1)
export { CloudRouteRegistry, ROUTE_CLASSES, ROUTE_METHODS, routeKey } from './router/registry';
export type { CloudRouteHandler, RouteClass, RouteDescriptor, RouteMethod } from './router/registry';

// Auth plane
export { ACCESS_TOKEN_TTL_SECONDS, createHmacTokenSigner } from './auth/tokens';
export type { AccessTokenClaims, TokenSigner } from './auth/tokens';
export { NONCE_SIGNING_DOMAIN, verifyNonceSignature } from './auth/verify';
export { authenticateBearer, extractBearerToken } from './auth/bearer';
export type { BearerAuthDeps } from './auth/bearer';
export {
  DEFAULT_DEVICE_PROOF_CLOCK_SKEW_MS,
  DEFAULT_DEVICE_PROOF_MAX_LIFETIME_MS,
  MAX_DEVICE_PROOF_CLOCK_SKEW_MS,
  MAX_DEVICE_PROOF_MAX_LIFETIME_MS,
  authenticateDeviceProof,
} from './auth/device-proof';
export type {
  AuthenticatedDeviceProof,
  DeviceProofAuthDeps,
  DeviceProofRequestBinding,
} from './auth/device-proof';
export { authenticateHostedDeviceAssertion } from './auth/device-assertion';
export type { HostedDeviceAssertionAuthDeps } from './auth/device-assertion';
export {
  DEVICE_IDENTITY_PROOF_KEY_EPOCH,
  DEVICE_IDENTITY_PROOF_KEY_ID,
  PAIRING_CODE_TTL_MS,
  createAuthPlane,
} from './auth/plane';
export type { AuthPlane, AuthPlaneDeps, MintedAccessToken, PairInput } from './auth/plane';

// The crypto seam
export { createWebCrypto } from './crypto/web-crypto';
export type { CloudCrypto } from './crypto/port';

// Inbound gate
export { handleInboundEnvelope, terminalReceiptKey } from './inbound';
export type { InboundOutcome } from './inbound';

// Typed terminal read model (the receipt `readTerminalReceipt` hands back raw)
export { projectTerminalResult } from './terminal-result';
export type { TerminalResult } from './terminal-result';

// Tenant facade (layer 2 of §12.6.2)
export { tenantStoresFor } from './tenant-stores';
export type {
  TenantBoundActivity,
  TenantBoundApprovalTimeline,
  TenantBoundBoard,
  CloudRootStores,
  TenantBoundBlobs,
  TenantBoundDedup,
  TenantBoundDevices,
  TenantBoundMailbox,
  TenantBoundPresence,
  TenantBoundQuota,
  TenantBoundRateLimiter,
  TenantBoundReceipts,
  TenantBoundTaskAttempts,
  TenantStores,
} from './tenant-stores';

export {
  ApprovalObservationSchema,
  ApprovalTimelineEventSchema,
  APPROVAL_SUMMARY_MAX_BYTES,
  DEFAULT_APPROVAL_TIMELINE_CAPACITY,
  DEFAULT_APPROVAL_TIMELINE_TTL_MS,
  approvalTimelineCursor,
  parseApprovalObservations,
  validateApprovalTimelineAppend,
} from './approval-timeline';
export type {
  ApprovalObservation,
  ApprovalTimelineAppendInput,
  ApprovalTimelineEvent,
  ApprovalTimelineStore,
  ApprovalTimelineTail,
} from './approval-timeline';

export {
  DEFAULT_ACTIVITY_BOUNDS,
  DEFAULT_ACTIVITY_CAPACITY,
  DEFAULT_ACTIVITY_MAX_BYTES,
  DEFAULT_ACTIVITY_MAX_EVENTS,
  DEFAULT_ACTIVITY_TTL_MS,
  DEFAULT_BOARD_CHANNEL_MAX_BYTES,
  DEFAULT_BOARD_TITLE_MAX_BYTES,
  DEFAULT_PRESENCE_DETAIL_MAX_BYTES,
  DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS,
  DEFAULT_PRESENCE_TTL_MS,
} from './coordination';
export type { ActivityBounds } from './coordination';
export {
  TimelineEventSchema,
  ActivityAppendRequestSchema,
  activityCursor,
  parseTimelineEvents,
  projectTimelineEvents,
  validateActivityAppend,
} from './activity';
export type {
  ActivityAppendInput,
  ActivityCursor,
  ActivityStore,
  ActivityTail,
  TimelineEvent,
} from './activity';
export { BoardFeedClient, BoardFeedRetryableError, BoardFeedStoppedError } from './coordination-client';
export type {
  BoardFeedClientOptions,
  BoardFeedItem,
  BoardFeedMode,
  BoardFeedPage,
  BoardFeedRead,
} from './coordination-client';

export {
  TRUTH_BATCH_MAX_RECORDS,
  TRUTH_INLINE_CONTENT_TYPE,
  TRUTH_LABEL_MAX_LENGTH,
  TRUTH_MANIFEST_MAX_LIMIT,
  TRUTH_RECORD_CAPABILITY,
  TRUTH_RECORD_KEY_MAX_LENGTH,
  TRUTH_REQUEST_ID_MAX_LENGTH,
  TruthBodyInputSchema,
  TruthCommitResponseSchema,
  TruthRecordKeySchema,
  TruthRecordMetadataSchema,
  TruthWriteRequestSchema,
  truthManifestMetadata,
  truthRecordMetadata,
} from './truth/contract';
export {
  DEFAULT_MAX_TRUTH_REQUEST_BYTES,
  DEVICE_PROOF_HEADER,
  MAX_DEVICE_PROOF_HEADER_BYTES,
} from './handlers/truth';
export type {
  PreparedTruthWrite,
  TruthBodyInput,
  TruthCommitInput,
  TruthCommitResponse,
  TruthCommitResult,
  TruthCommitter,
  TruthObjectDownloads,
  TruthRecordMetadata,
  TruthWriteRequest,
} from './truth/contract';
export { TruthCommitError, isTruthCommitError } from './truth/errors';
export type { TruthCommitErrorCode } from './truth/errors';

// Cloud-local ports
export { BLOB_READ_ERROR_CODES, CLOUD_STORE_NAMES, TASK_ATTEMPT_STATUSES } from './stores/ports';
// The port method inventory. Contract data, shipped so `@byok-sdk/conformance` and
// durable adapters read the same table; `ports.ts` itself is untouched.
export { CLOUD_PORT_INTERFACES, CLOUD_PORT_METHODS } from './stores/ports-contract';
export type {
  BlobContent,
  BlobContentProxy,
  BlobDeclaration,
  BlobObservation,
  BlobReadErrorCode,
  BlobReadResult,
  BlobWriteResult,
  CloudBlobStore,
  CloudStoreName,
  CloudStores,
  DeviceDirectory,
  DeviceRecord,
  DeviceRegistration,
  InboundDedupStore,
  InboundRateLimiter,
  NonceStore,
  PairingCodeClaims,
  PairingCodeInfo,
  PairingCodeIssueInput,
  PairingCodeStore,
  PairingEnrollment,
  PairingEnrollmentInput,
  ProofRequestReceipt,
  ProofRequestReceiptInput,
  ProofRequestReceiptStore,
  RequestReceipt,
  RequestReceiptStore,
  TaskAttempt,
  TaskAttemptStatus,
  TaskAttemptStore,
  AgentRef,
  AgentEgressRecord,
  AgentEgressStore,
  TaskCancellationMutation,
  TaskCancellationRequest,
  TaskCancellationStore,
} from './stores/ports';

// In-memory reference implementations
export {
  AllowAllRateLimiter,
  BLOB_URL_TTL_MS,
  DEDUP_RING_CAPACITY,
  InMemoryBlobContentProxy,
  InMemoryCloudBlobStore,
  InMemoryActivityStore,
  InMemoryDeviceDirectory,
  InMemoryInboundDedupStore,
  InMemoryNonceStore,
  InMemoryPairingCodeStore,
  InMemoryRequestReceiptStore,
  InMemoryAgentEgressStore,
  InMemoryProofRequestReceiptStore,
  InMemoryTaskAttemptStore,
  InMemoryTaskCancellationStore,
  NONCE_TTL_MS,
  createInMemoryBlobs,
  createInMemoryCloudStores,
} from './stores/in-memory/index';
export type {
  InMemoryBlobStoreOptions,
  InMemoryBlobs,
  InMemoryCloudComposition,
} from './stores/in-memory/index';
