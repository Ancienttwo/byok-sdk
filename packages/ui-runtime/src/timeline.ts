import {
  TimelineEventSchema,
  type ActivityTail,
  type TimelineEvent,
} from '@byok-sdk/cloud';
import { isKnownAgentEvent, type AgentEvent } from '@byok-sdk/protocol';
import {
  TimelineFoldError,
  type TaskTimelineSnapshot,
  type TimelineEventKey,
  type TimelineGap,
  type TimelineItem,
  type TimelineMetadata,
  type TimelineOrderKey,
  type TimelineState,
  type ToolTimelineItem,
} from './types';

type ToolUseEvent = Extract<AgentEvent, { type: 'tool_use' }>;
type ToolResultEvent = Extract<AgentEvent, { type: 'tool_result' }>;

interface ToolObservation {
  readonly timelineEvent: TimelineEvent;
  readonly event: ToolUseEvent | ToolResultEvent;
}

interface ToolAccumulator {
  readonly itemIndex: number;
  readonly tool: string;
  use?: ToolObservation;
  result?: ToolObservation;
}

const DEFAULT_METADATA: TimelineMetadata = Object.freeze({ dropped: 0 });

function compareEvents(left: TimelineEvent, right: TimelineEvent): number {
  return left.batchSeq - right.batchSeq || left.eventIndex - right.eventIndex;
}

function fail(code: ConstructorParameters<typeof TimelineFoldError>[0], message: string, cause?: unknown): never {
  throw new TimelineFoldError(code, message, cause === undefined ? undefined : { cause });
}

function validTaskId(taskId: unknown): taskId is string {
  return typeof taskId === 'string' && taskId.length > 0 && taskId.length <= 200;
}

function validateMetadata(metadata: TimelineMetadata): TimelineMetadata {
  if (!Number.isSafeInteger(metadata.dropped) || metadata.dropped < 0) {
    fail('timeline_input_invalid', 'Timeline metadata dropped must be a non-negative integer.');
  }
  if (metadata.capacity !== undefined && (!Number.isSafeInteger(metadata.capacity) || metadata.capacity <= 0)) {
    fail('timeline_input_invalid', 'Timeline metadata capacity must be a positive integer when present.');
  }
  if (metadata.expiresAt !== undefined && (
    typeof metadata.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(metadata.expiresAt))
    || new Date(metadata.expiresAt).toISOString() !== metadata.expiresAt
  )) {
    fail('timeline_input_invalid', 'Timeline metadata expiresAt must be a canonical ISO timestamp when present.');
  }
  if (metadata.cursor !== undefined && (
    !Number.isSafeInteger(metadata.cursor.batchSeq) || metadata.cursor.batchSeq < 0
    || !Number.isSafeInteger(metadata.cursor.eventIndex) || metadata.cursor.eventIndex < 0
  )) {
    fail('timeline_input_invalid', 'Timeline metadata cursor must contain non-negative integer coordinates.');
  }
  return Object.freeze({ ...metadata, cursor: metadata.cursor && Object.freeze({ ...metadata.cursor }) });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

function parseEvent(value: TimelineEvent): TimelineEvent {
  try {
    const parsed = TimelineEventSchema.parse(value);
    return deepFreeze(structuredClone(parsed)) as TimelineEvent;
  } catch (error) {
    fail('timeline_input_invalid', 'Timeline events must satisfy the typed cloud activity authority.', error);
  }
}

function structurallyEqual(left: unknown, right: unknown, seen = new WeakMap<object, object>()): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const prior = seen.get(left);
  if (prior !== undefined) return prior === right;
  seen.set(left, right);
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => structurallyEqual(entry, right[index], seen));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && structurallyEqual(leftRecord[key], rightRecord[key], seen));
}

function eventKey(event: TimelineEvent): TimelineEventKey {
  return Object.freeze({ sourceEnvelopeId: event.sourceEnvelopeId, eventIndex: event.eventIndex });
}

function orderKey(event: TimelineEvent): TimelineOrderKey {
  return Object.freeze({ taskId: event.taskId, batchSeq: event.batchSeq, eventIndex: event.eventIndex });
}

function sameIdentity(left: TimelineEvent, right: TimelineEvent): boolean {
  return left.sourceEnvelopeId === right.sourceEnvelopeId && left.eventIndex === right.eventIndex;
}

function sameOrder(left: TimelineEvent, right: TimelineEvent): boolean {
  return left.batchSeq === right.batchSeq && left.eventIndex === right.eventIndex;
}

function contiguous(left: TimelineEvent, right: TimelineEvent): boolean {
  return (left.batchSeq === right.batchSeq && right.eventIndex === left.eventIndex + 1)
    || (right.batchSeq === left.batchSeq + 1 && right.eventIndex === 0);
}

function gapsFor(events: readonly TimelineEvent[]): readonly TimelineGap[] {
  const gaps: TimelineGap[] = [];
  for (let index = 1; index < events.length; index += 1) {
    const previous = events[index - 1]!;
    const current = events[index]!;
    if (current.batchSeq === previous.batchSeq && current.eventIndex > previous.eventIndex + 1) {
      gaps.push(Object.freeze({
        kind: 'event',
        after: orderKey(previous),
        before: orderKey(current),
        missing: current.eventIndex - previous.eventIndex - 1,
      }));
      continue;
    }
    if (current.batchSeq > previous.batchSeq) {
      if (current.batchSeq > previous.batchSeq + 1) {
        gaps.push(Object.freeze({
          kind: 'batch',
          after: orderKey(previous),
          before: orderKey(current),
          missing: current.batchSeq - previous.batchSeq - 1,
        }));
      }
      if (current.eventIndex > 0) {
        gaps.push(Object.freeze({
          kind: 'event',
          after: orderKey(previous),
          before: orderKey(current),
          missing: current.eventIndex,
        }));
      }
    }
  }
  return Object.freeze(gaps);
}

function toolItem(accumulator: ToolAccumulator, toolCallId: string): ToolTimelineItem {
  const observations = [accumulator.use?.timelineEvent, accumulator.result?.timelineEvent]
    .filter((event): event is TimelineEvent => event !== undefined)
    .sort(compareEvents);
  const use = accumulator.use?.event as ToolUseEvent | undefined;
  const result = accumulator.result?.event as ToolResultEvent | undefined;
  const state = use === undefined
    ? 'unpaired-result'
    : result === undefined
      ? 'input-available'
      : result.isError === true
        ? 'output-error'
        : result.isError === false
          ? 'output-available'
          : 'output-unknown';
  return Object.freeze({
    kind: 'tool',
    eventKeys: Object.freeze(observations.map(eventKey)),
    orderKey: orderKey(observations[0]!),
    tool: accumulator.tool,
    toolCallId,
    state,
    ...(use && Object.hasOwn(use, 'input') ? { input: use.input } : {}),
    ...(result && Object.hasOwn(result, 'output') ? { output: result.output } : {}),
  });
}

function unpairedTool(event: TimelineEvent, observation: ToolUseEvent | ToolResultEvent): ToolTimelineItem {
  return Object.freeze({
    kind: 'tool',
    eventKeys: Object.freeze([eventKey(event)]),
    orderKey: orderKey(event),
    tool: observation.tool,
    state: observation.type === 'tool_use' ? 'unpaired-use' : 'unpaired-result',
    ...(observation.type === 'tool_use' && Object.hasOwn(observation, 'input') ? { input: observation.input } : {}),
    ...(observation.type === 'tool_result' && Object.hasOwn(observation, 'output') ? { output: observation.output } : {}),
  });
}

function projectItems(events: readonly TimelineEvent[]): readonly TimelineItem[] {
  const items: TimelineItem[] = [];
  const tools = new Map<string, ToolAccumulator>();
  let previous: TimelineEvent | undefined;

  for (const timelineEvent of events) {
    const key = eventKey(timelineEvent);
    const order = orderKey(timelineEvent);
    const event = timelineEvent.event;
    if (!isKnownAgentEvent(event)) {
      items.push(Object.freeze({
        kind: 'unknown', eventKeys: Object.freeze([key]), orderKey: order,
        eventType: event.type, classification: 'unknown-event',
      }));
      previous = timelineEvent;
      continue;
    }

    switch (event.type) {
      case 'progress': {
        const last = items.at(-1);
        if (last?.kind === 'text-activity' && previous !== undefined && contiguous(previous, timelineEvent)) {
          items[items.length - 1] = Object.freeze({
            ...last,
            eventKeys: Object.freeze([...last.eventKeys, key]),
            fragments: Object.freeze([...last.fragments, Object.freeze({ eventKey: key, text: event.text })]),
          });
        } else {
          items.push(Object.freeze({
            kind: 'text-activity', eventKeys: Object.freeze([key]), orderKey: order,
            fragments: Object.freeze([Object.freeze({ eventKey: key, text: event.text })]),
          }));
        }
        break;
      }
      case 'tool_use':
      case 'tool_result': {
        const callId = event.toolCallId;
        if (callId === undefined) {
          items.push(unpairedTool(timelineEvent, event));
          break;
        }
        let accumulator = tools.get(callId);
        if (accumulator === undefined) {
          accumulator = { itemIndex: items.length, tool: event.tool };
          tools.set(callId, accumulator);
          items.push(unpairedTool(timelineEvent, event));
        } else if (accumulator.tool !== event.tool) {
          fail('tool_collision', `Tool call ${callId} changed tool name from ${accumulator.tool} to ${event.tool}.`);
        }
        if (event.type === 'tool_use') {
          if (accumulator.use !== undefined) fail('tool_collision', `Tool call ${callId} has multiple tool_use observations.`);
          accumulator.use = { timelineEvent, event };
        } else {
          if (accumulator.result !== undefined) fail('tool_collision', `Tool call ${callId} has multiple tool_result observations.`);
          accumulator.result = { timelineEvent, event };
        }
        items[accumulator.itemIndex] = toolItem(accumulator, callId);
        break;
      }
      case 'artifact':
        items.push(Object.freeze({
          kind: 'artifact', eventKeys: Object.freeze([key]), orderKey: order,
          name: event.name, contentType: event.contentType,
        }));
        break;
      case 'usage':
        items.push(Object.freeze({
          kind: 'usage', eventKeys: Object.freeze([key]), orderKey: order,
          ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
          ...(event.cachedInputTokens !== undefined ? { cachedInputTokens: event.cachedInputTokens } : {}),
          ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
          ...(event.reasoningTokens !== undefined ? { reasoningTokens: event.reasoningTokens } : {}),
          ...(event.totalTokens !== undefined ? { totalTokens: event.totalTokens } : {}),
        }));
        break;
      case 'error':
        items.push(Object.freeze({
          kind: 'error', eventKeys: Object.freeze([key]), orderKey: order, message: event.message,
        }));
        break;
      case 'turn_end':
        items.push(Object.freeze({ kind: 'boundary', eventKeys: Object.freeze([key]), orderKey: order }));
        break;
      case 'needs_approval':
        items.push(Object.freeze({
          kind: 'unknown', eventKeys: Object.freeze([key]), orderKey: order,
          eventType: event.type, classification: 'unsupported-known-event',
        }));
        break;
      default: {
        // A newer protocol package can classify a variant as known even when
        // this older UI runtime has no semantic projection for it. Preserve
        // its position without interpreting or exposing its opaque payload.
        const unsupported = event as { readonly type: string };
        items.push(Object.freeze({
          kind: 'unknown', eventKeys: Object.freeze([key]), orderKey: order,
          eventType: unsupported.type, classification: 'unsupported-known-event',
        }));
      }
    }
    previous = timelineEvent;
  }
  return Object.freeze(items);
}

export function createTimelineState(taskId: string, metadata: TimelineMetadata = DEFAULT_METADATA): TimelineState {
  if (!validTaskId(taskId)) fail('timeline_input_invalid', 'Timeline taskId must contain 1 to 200 characters.');
  return Object.freeze({ taskId, events: Object.freeze([]), metadata: validateMetadata(metadata) });
}

export function withTimelineMetadata(state: TimelineState, metadata: TimelineMetadata): TimelineState {
  if (!validTaskId(state.taskId)) fail('timeline_input_invalid', 'Timeline state taskId is invalid.');
  return Object.freeze({ taskId: state.taskId, events: state.events, metadata: validateMetadata(metadata) });
}

export function foldTimelineEvent(state: TimelineState, input: TimelineEvent): TimelineState {
  if (!validTaskId(state.taskId)) fail('timeline_input_invalid', 'Timeline state taskId is invalid.');
  const event = parseEvent(input);
  if (event.taskId !== state.taskId) {
    fail('task_mismatch', `Timeline event task ${event.taskId} does not match state task ${state.taskId}.`);
  }
  const identical = state.events.find((existing) => sameIdentity(existing, event));
  if (identical !== undefined) {
    if (structurallyEqual(identical, event)) return state;
    fail('identity_collision', 'Timeline identity was reused for different event content.');
  }
  if (state.events.some((existing) => sameOrder(existing, event))) {
    fail('order_collision', 'Timeline order coordinates were claimed by different source identities.');
  }
  const events = [...state.events, event].sort(compareEvents);
  return Object.freeze({ taskId: state.taskId, events: Object.freeze(events), metadata: state.metadata });
}

export function projectTimeline(state: TimelineState): TaskTimelineSnapshot {
  if (!validTaskId(state.taskId)) fail('timeline_input_invalid', 'Timeline state taskId is invalid.');
  return Object.freeze({
    taskId: state.taskId,
    items: projectItems(state.events),
    gaps: gapsFor(state.events),
    dropped: state.metadata.dropped,
    ...(state.metadata.capacity !== undefined ? { capacity: state.metadata.capacity } : {}),
    ...(state.metadata.expiresAt !== undefined ? { expiresAt: state.metadata.expiresAt } : {}),
    ...(state.metadata.cursor !== undefined ? { cursor: state.metadata.cursor } : {}),
  });
}

export function replayTimeline(tail: ActivityTail): TaskTimelineSnapshot {
  if (!validTaskId(tail.taskId)) fail('timeline_input_invalid', 'Activity tail taskId is invalid.');
  let state = createTimelineState(tail.taskId, {
    dropped: tail.dropped,
    capacity: tail.capacity,
    expiresAt: tail.expiresAt,
    ...(tail.cursor !== undefined ? { cursor: tail.cursor } : {}),
  });
  for (const event of tail.entries) state = foldTimelineEvent(state, event);
  return projectTimeline(state);
}
