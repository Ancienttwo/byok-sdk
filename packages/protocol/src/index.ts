export { PROTOCOL_VERSION, CAPABILITY_FLAGS } from './version';
export type { CapabilityFlag } from './version';

export { BlobRefSchema, CONTENT_HASH_RE } from './blob';
export type { BlobRef } from './blob';

export { PermissionPolicySchema, PERMISSION_MODES } from './permission';
export type { PermissionPolicy, PermissionMode } from './permission';

export {
  AgentEventSchema,
  UnknownAgentEventSchema,
  AgentEventOrUnknownSchema,
  KNOWN_AGENT_EVENT_TYPES,
  isKnownAgentEvent,
  partitionAgentEvents,
} from './agent-event';
export type { AgentEvent, UnknownAgentEvent, AgentEventOrUnknown } from './agent-event';

export { TASK_STATES, TASK_TRANSITIONS, canTransition } from './task-state';
export type { TaskState } from './task-state';

export {
  MESSAGE_TYPES,
  MESSAGE_PAYLOAD_SCHEMAS,
  SERVER_TO_DAEMON_TYPES,
  DAEMON_TO_SERVER_TYPES,
  RuntimeIdSchema,
  RuntimeInfoSchema,
  RuntimeCapabilitiesSchema,
  ConnHelloPayloadSchema,
  ConnAckPayloadSchema,
  TaskOfferPayloadSchema,
  TaskApprovePayloadSchema,
  TaskRejectPayloadSchema,
  TaskCancelPayloadSchema,
  TaskSteerPayloadSchema,
  TaskClaimPayloadSchema,
  TaskStartedPayloadSchema,
  TaskDeclinePayloadSchema,
  TaskProgressPayloadSchema,
  TaskArtifactPayloadSchema,
  TaskAwaitApprovalPayloadSchema,
  TaskCompletePayloadSchema,
  TaskFailPayloadSchema,
  TaskCancelledPayloadSchema,
} from './messages';
export type {
  MessageType,
  RuntimeId,
  RuntimeInfo,
  RuntimeCapabilities,
  ConnHelloPayload,
  ConnAckPayload,
  TaskOfferPayload,
  TaskApprovePayload,
  TaskRejectPayload,
  TaskCancelPayload,
  TaskSteerPayload,
  TaskClaimPayload,
  TaskStartedPayload,
  TaskDeclinePayload,
  TaskProgressPayload,
  TaskArtifactPayload,
  TaskAwaitApprovalPayload,
  TaskCompletePayload,
  TaskFailPayload,
  TaskCancelledPayload,
} from './messages';

export { EnvelopeSchema, isServerToDaemonType } from './envelope';
export type { Envelope } from './envelope';

export {
  ProtocolError,
  EnvelopeParseError,
  UnknownMessageTypeError,
  EnvelopeValidationError,
} from './errors';

export { encodeEnvelope, decodeEnvelope, createEnvelope, parseMessage } from './codec';
export type { CreateEnvelopeOptions } from './codec';

export {
  PairRequestSchema,
  PairResponseSchema,
  ChallengeRequestSchema,
  ChallengeResponseSchema,
  TokenRequestSchema,
  TokenResponseSchema,
  CreateBlobRequestSchema,
  CreateBlobResponseSchema,
  BlobDownloadUrlResponseSchema,
  EventsPollQuerySchema,
  EventsPollResponseSchema,
  MessagesSendRequestSchema,
  MessagesSendResponseSchema,
  MAX_MESSAGES_PER_BATCH,
} from './http-api';
export type {
  PairRequest,
  PairResponse,
  ChallengeRequest,
  ChallengeResponse,
  TokenRequest,
  TokenResponse,
  CreateBlobRequest,
  CreateBlobResponse,
  BlobDownloadUrlResponse,
  EventsPollQuery,
  EventsPollResponse,
  MessagesSendRequest,
  MessagesSendResponse,
} from './http-api';
