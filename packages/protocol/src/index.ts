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
  DispatchSelectionSchema,
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
  TaskApprovalResolvedPayloadSchema,
  RESULT_DOCUMENT_MAX_BYTES,
  checkResultDocument,
} from './messages';
export type {
  ResultDocumentCheck,
  MessageType,
  RuntimeId,
  RuntimeInfo,
  RuntimeCapabilities,
  DispatchSelection,
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
  TaskApprovalResolvedPayload,
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
  BYOK_WS_PATH,
  BYOK_PAIR_PATH,
  BYOK_CHALLENGE_PATH,
  BYOK_TOKEN_PATH,
  BYOK_CAPABILITIES_PATH,
  BYOK_EVENTS_PATH,
  BYOK_MESSAGES_PATH,
  BYOK_PRESENCE_PATH,
  BYOK_ACTIVITY_PATH,
  BYOK_BOARD_PATH,
  BYOK_BOARD_STREAM_PATH,
  BYOK_BOARD_CLAIM_ROUTE,
  BYOK_BOARD_UNCLAIM_ROUTE,
  BYOK_BOARD_STATUS_ROUTE,
  BYOK_RECORDS_PATH,
  BYOK_RECORD_ROUTE,
  byokRecordPath,
  BYOK_SKILL_PACKS_PATH,
  BYOK_SKILL_PACK_FILE_ROUTE,
  byokSkillPackFilePath,
  BYOK_BLOBS_PATH,
  BYOK_BLOB_FINALIZE_ROUTE,
  BYOK_BLOB_URL_ROUTE,
  BYOK_BLOB_CONTENT_ROUTE,
  byokBlobFinalizePath,
  byokBlobUrlPath,
  byokBlobContentPath,
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
