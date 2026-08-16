import type { ActivityCursor, TimelineEvent } from '@byok-sdk/cloud';

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

export const TOOL_TIMELINE_STATES = [
  'input-available',
  'output-available',
  'output-error',
  'output-unknown',
  'unpaired-use',
  'unpaired-result',
] as const;

export type ToolTimelineState = (typeof TOOL_TIMELINE_STATES)[number];

export interface ToolTimelineItem extends TimelineItemBase {
  readonly kind: 'tool';
  readonly tool: string;
  readonly toolCallId?: string;
  readonly state: ToolTimelineState;
  readonly input?: unknown;
  readonly output?: unknown;
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

export type TimelineItem =
  | TextActivityTimelineItem
  | ToolTimelineItem
  | ArtifactTimelineItem
  | UsageTimelineItem
  | ErrorTimelineItem
  | BoundaryTimelineItem
  | UnknownTimelineItem;

export interface TaskTimelineSnapshot {
  readonly taskId: string;
  readonly items: readonly TimelineItem[];
  readonly gaps: readonly TimelineGap[];
  readonly dropped: number;
  readonly capacity?: number;
  readonly expiresAt?: string;
  readonly cursor?: ActivityCursor;
}

export const TIMELINE_FOLD_ERROR_CODES = [
  'timeline_input_invalid',
  'task_mismatch',
  'identity_collision',
  'order_collision',
  'tool_collision',
] as const;

export type TimelineFoldErrorCode = (typeof TIMELINE_FOLD_ERROR_CODES)[number];

export class TimelineFoldError extends Error {
  readonly code: TimelineFoldErrorCode;

  constructor(code: TimelineFoldErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TimelineFoldError';
    this.code = code;
  }
}
