export { PROTOCOL_VERSION, CAPABILITY_FLAGS } from './version';
export type { CapabilityFlag } from './version';

export { BlobRefSchema } from './blob';
export type { BlobRef } from './blob';

export { PermissionPolicySchema, PERMISSION_MODES } from './permission';
export type { PermissionPolicy, PermissionMode } from './permission';

export { AgentEventSchema } from './agent-event';
export type { AgentEvent } from './agent-event';

export { TASK_STATES, TASK_TRANSITIONS, canTransition } from './task-state';
export type { TaskState } from './task-state';

export {
  MESSAGE_TYPES,
  MESSAGE_PAYLOAD_SCHEMAS,
  RuntimeIdSchema,
  ConnHelloPayloadSchema,
  ConnAckPayloadSchema,
  TaskOfferPayloadSchema,
  TaskApprovePayloadSchema,
  TaskRejectPayloadSchema,
  TaskCancelPayloadSchema,
  TaskSteerPayloadSchema,
  TaskClaimPayloadSchema,
  TaskProgressPayloadSchema,
  TaskArtifactPayloadSchema,
  TaskAwaitApprovalPayloadSchema,
  TaskCompletePayloadSchema,
  TaskFailPayloadSchema,
} from './messages';
export type {
  MessageType,
  RuntimeId,
  ConnHelloPayload,
  ConnAckPayload,
  TaskOfferPayload,
  TaskApprovePayload,
  TaskRejectPayload,
  TaskCancelPayload,
  TaskSteerPayload,
  TaskClaimPayload,
  TaskProgressPayload,
  TaskArtifactPayload,
  TaskAwaitApprovalPayload,
  TaskCompletePayload,
  TaskFailPayload,
} from './messages';

export { EnvelopeSchema } from './envelope';
export type { Envelope } from './envelope';

export {
  ProtocolError,
  EnvelopeParseError,
  UnknownMessageTypeError,
  EnvelopeValidationError,
} from './errors';

export { encodeEnvelope, decodeEnvelope, createEnvelope, parseMessage } from './codec';
export type { CreateEnvelopeOptions } from './codec';
