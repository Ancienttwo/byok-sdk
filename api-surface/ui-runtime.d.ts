// ==== @byok-sdk/ui-runtime dist/approval-timeline.d.ts ====
import { type ApprovalObservation, type ApprovalTimelineTail } from '@byok-sdk/cloud';
import { type ApprovalProjectionMetadata, type ApprovalProjectionState, type TaskApprovalSnapshot } from './approval-types';
export declare function createApprovalProjectionState(taskId: string, metadata?: ApprovalProjectionMetadata): ApprovalProjectionState;
export declare function withApprovalProjectionMetadata(state: ApprovalProjectionState, metadata: ApprovalProjectionMetadata): ApprovalProjectionState;
export declare function foldApprovalObservation(state: ApprovalProjectionState, input: ApprovalObservation): ApprovalProjectionState;
export declare function foldApprovalTail(state: ApprovalProjectionState, tail: ApprovalTimelineTail): ApprovalProjectionState;
export declare function projectApprovalTimeline(state: ApprovalProjectionState): TaskApprovalSnapshot;
export declare function replayApprovalTimeline(tail: ApprovalTimelineTail): TaskApprovalSnapshot;
// ==== @byok-sdk/ui-runtime dist/approval-types.d.ts ====
import type { ApprovalObservation } from '@byok-sdk/cloud';
export declare const APPROVAL_LIFECYCLE_STATES: readonly ['approval-requested', 'approval-responded'];
export type ApprovalLifecycleState = (typeof APPROVAL_LIFECYCLE_STATES)[number];
export declare const APPROVAL_DECISION_STATES: readonly ['pending', 'approved', 'rejected'];
export type ApprovalDecisionState = (typeof APPROVAL_DECISION_STATES)[number];
export declare const APPROVAL_CORRELATION_STATES: readonly ['paired', 'unpaired-request', 'unpaired-resolution'];
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
export declare const APPROVAL_PROJECTION_ERROR_CODES: readonly ['approval_input_invalid', 'approval_task_mismatch', 'approval_identity_collision', 'approval_revision_collision', 'approval_authority_collision'];
export type ApprovalProjectionErrorCode = (typeof APPROVAL_PROJECTION_ERROR_CODES)[number];
export declare class ApprovalProjectionError extends Error {
    readonly code: ApprovalProjectionErrorCode;
    constructor(code: ApprovalProjectionErrorCode, message: string, options?: ErrorOptions);
}
// ==== @byok-sdk/ui-runtime dist/index.d.ts ====
export * from './approval-timeline';
export * from './approval-types';
export * from './timeline';
export * from './types';
// ==== @byok-sdk/ui-runtime dist/timeline.d.ts ====
import { type ActivityTail, type TimelineEvent } from '@byok-sdk/cloud';
import { type TaskTimelineSnapshot, type TimelineMetadata, type TimelineState } from './types';
export declare function createTimelineState(taskId: string, metadata?: TimelineMetadata): TimelineState;
export declare function withTimelineMetadata(state: TimelineState, metadata: TimelineMetadata): TimelineState;
export declare function foldTimelineEvent(state: TimelineState, input: TimelineEvent): TimelineState;
export declare function projectTimeline(state: TimelineState): TaskTimelineSnapshot;
export declare function replayTimeline(tail: ActivityTail): TaskTimelineSnapshot;
// ==== @byok-sdk/ui-runtime dist/types.d.ts ====
import type { ActivityCursor, TimelineEvent } from '@byok-sdk/cloud';
import type { AgentEventSpill } from '@byok-sdk/protocol';
export interface TimelineEventKey {
    readonly sourceEnvelopeId: string;
    readonly eventIndex: number;
}
export interface TimelineOrderKey {
    readonly taskId: string;
    readonly batchSeq: number;
    readonly eventIndex: number;
}
export interface TimelineMetadata {
    readonly dropped: number;
    readonly capacity?: number;
    readonly expiresAt?: string;
    readonly cursor?: ActivityCursor;
}
export interface TimelineState {
    readonly taskId: string;
    readonly events: readonly TimelineEvent[];
    readonly metadata: TimelineMetadata;
}
export interface TimelineGap {
    readonly kind: 'batch' | 'event';
    readonly after: TimelineOrderKey;
    readonly before: TimelineOrderKey;
    readonly missing: number;
}
interface TimelineItemBase {
    readonly eventKeys: readonly TimelineEventKey[];
    readonly orderKey: TimelineOrderKey;
}
export interface TimelineTextFragment {
    readonly eventKey: TimelineEventKey;
    readonly text: string;
}
export interface TextActivityTimelineItem extends TimelineItemBase {
    readonly kind: 'text-activity';
    readonly fragments: readonly TimelineTextFragment[];
}
export declare const TOOL_TIMELINE_STATES: readonly ['input-available', 'output-available', 'output-error', 'output-unknown', 'unpaired-use', 'unpaired-result'];
export type ToolTimelineState = (typeof TOOL_TIMELINE_STATES)[number];
export interface ToolTimelineItem extends TimelineItemBase {
    readonly kind: 'tool';
    readonly tool: string;
    readonly toolCallId?: string;
    readonly state: ToolTimelineState;
    readonly input?: unknown;
    readonly output?: unknown;
    /** Present exactly when the source `tool_use` event carried `spill` (see `docs/protocol.md` §11.6); render the truncation from this, never infer it from the `{ preview }` shape. */
    readonly inputSpill?: AgentEventSpill;
    /** Present exactly when the source `tool_result` event carried `spill` (see `docs/protocol.md` §11.6); render the truncation from this, never infer it from the `{ preview }` shape. */
    readonly outputSpill?: AgentEventSpill;
}
export interface ArtifactTimelineItem extends TimelineItemBase {
    readonly kind: 'artifact';
    readonly name: string;
    readonly contentType: string;
}
export interface UsageTimelineItem extends TimelineItemBase {
    readonly kind: 'usage';
    readonly inputTokens?: number;
    readonly cachedInputTokens?: number;
    readonly outputTokens?: number;
    readonly reasoningTokens?: number;
    readonly totalTokens?: number;
}
export interface ErrorTimelineItem extends TimelineItemBase {
    readonly kind: 'error';
    readonly message: string;
}
export interface BoundaryTimelineItem extends TimelineItemBase {
    readonly kind: 'boundary';
}
export interface UnknownTimelineItem extends TimelineItemBase {
    readonly kind: 'unknown';
    readonly eventType: string;
    readonly classification: 'unknown-event' | 'unsupported-known-event';
}
export type TimelineItem = TextActivityTimelineItem | ToolTimelineItem | ArtifactTimelineItem | UsageTimelineItem | ErrorTimelineItem | BoundaryTimelineItem | UnknownTimelineItem;
export interface TaskTimelineSnapshot {
    readonly taskId: string;
    readonly items: readonly TimelineItem[];
    readonly gaps: readonly TimelineGap[];
    readonly dropped: number;
    readonly capacity?: number;
    readonly expiresAt?: string;
    readonly cursor?: ActivityCursor;
}
export declare const TIMELINE_FOLD_ERROR_CODES: readonly ['timeline_input_invalid', 'task_mismatch', 'identity_collision', 'order_collision', 'tool_collision'];
export type TimelineFoldErrorCode = (typeof TIMELINE_FOLD_ERROR_CODES)[number];
export declare class TimelineFoldError extends Error {
    readonly code: TimelineFoldErrorCode;
    constructor(code: TimelineFoldErrorCode, message: string, options?: ErrorOptions);
}
export {};
