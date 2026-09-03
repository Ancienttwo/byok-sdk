import type { ApprovalObservation } from '@byok-sdk/cloud';

export const APPROVAL_LIFECYCLE_STATES = [
  'approval-requested',
  'approval-responded',
] as const;

export type ApprovalLifecycleState = (typeof APPROVAL_LIFECYCLE_STATES)[number];

export const APPROVAL_DECISION_STATES = ['pending', 'approved', 'rejected'] as const;

export type ApprovalDecisionState = (typeof APPROVAL_DECISION_STATES)[number];

export const APPROVAL_CORRELATION_STATES = [
  'paired',
  'unpaired-request',
  'unpaired-resolution',
] as const;

export type ApprovalCorrelationState = (typeof APPROVAL_CORRELATION_STATES)[number];

export interface ApprovalProjectionMetadata {
  readonly dropped: number;
  readonly capacity?: number;
  readonly expiresAt?: string;
  readonly cursor?: number;
}

export interface ApprovalProjectionState {
  readonly taskId: string;
  readonly observations: readonly ApprovalObservation[];
  readonly metadata: ApprovalProjectionMetadata;
}

export interface ApprovalProjectionItem {
  readonly kind: 'approval';
  readonly approvalId?: string;
  readonly lifecycle: ApprovalLifecycleState;
  readonly status: ApprovalDecisionState;
  readonly correlation: ApprovalCorrelationState;
  readonly firstRevision: number;
  readonly sourceRevisions: readonly number[];
  readonly sourceEnvelopeIds: readonly string[];
  readonly summary?: string;
  readonly decision?: 'approve' | 'reject';
  /** The authority that resolved the request on the cloud approval timeline. */
  readonly resolvedBy?: 'local' | 'host';
  readonly resolvedAt?: string;
}

export interface TaskApprovalSnapshot {
  readonly taskId: string;
  readonly items: readonly ApprovalProjectionItem[];
  readonly dropped: number;
  readonly capacity?: number;
  readonly expiresAt?: string;
  readonly cursor?: number;
}

export const APPROVAL_PROJECTION_ERROR_CODES = [
  'approval_input_invalid',
  'approval_task_mismatch',
  'approval_identity_collision',
  'approval_revision_collision',
  'approval_authority_collision',
] as const;

export type ApprovalProjectionErrorCode = (typeof APPROVAL_PROJECTION_ERROR_CODES)[number];

export class ApprovalProjectionError extends Error {
  readonly code: ApprovalProjectionErrorCode;

  constructor(code: ApprovalProjectionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ApprovalProjectionError';
    this.code = code;
  }
}
