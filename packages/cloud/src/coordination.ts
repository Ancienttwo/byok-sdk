import type { ActivityTail } from '@byok/core';
import type { AgentEventOrUnknown } from '@byok/protocol';
import { ByokCloudError } from './errors';
import type { TenantBoundActivity } from './tenant-stores';

export const DEFAULT_BOARD_CHANNEL_MAX_BYTES = 128;
export const DEFAULT_BOARD_TITLE_MAX_BYTES = 512;
export const DEFAULT_ACTIVITY_MAX_EVENTS = 50;
export const DEFAULT_ACTIVITY_MAX_BYTES = 64 * 1024;
export const DEFAULT_ACTIVITY_CAPACITY = 50;
export const DEFAULT_ACTIVITY_TTL_MS = 10 * 60_000;
export const DEFAULT_PRESENCE_TTL_MS = 90_000;
export const DEFAULT_PRESENCE_MINIMUM_INTERVAL_MS = 5_000;
export const DEFAULT_PRESENCE_DETAIL_MAX_BYTES = 512;

const encoder = new TextEncoder();

export interface ActivityBounds {
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly capacity: number;
  readonly ttlMs: number;
}

export const DEFAULT_ACTIVITY_BOUNDS: ActivityBounds = {
  maxEvents: DEFAULT_ACTIVITY_MAX_EVENTS,
  maxBytes: DEFAULT_ACTIVITY_MAX_BYTES,
  capacity: DEFAULT_ACTIVITY_CAPACITY,
  ttlMs: DEFAULT_ACTIVITY_TTL_MS,
};

export function assertBoardLabels(
  channel: string,
  title: string,
  limits: { readonly channelMaxBytes: number; readonly titleMaxBytes: number },
): void {
  if (channel.length === 0 || encoder.encode(channel).length > limits.channelMaxBytes) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      `Board channel must contain 1..${limits.channelMaxBytes} UTF-8 bytes.`,
    );
  }
  if (title.length === 0 || encoder.encode(title).length > limits.titleMaxBytes) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      `Board title must contain 1..${limits.titleMaxBytes} UTF-8 bytes.`,
    );
  }
}

export function activityDetails(
  events: readonly AgentEventOrUnknown[],
  dropped: number,
  bounds: ActivityBounds,
): readonly string[] {
  if (!Number.isSafeInteger(dropped) || dropped < 0) {
    throw new ByokCloudError(
      'coordination_input_invalid',
      'Activity dropped must be a non-negative integer.',
    );
  }
  if (events.length === 0 || events.length > bounds.maxEvents) {
    throw new ByokCloudError(
      'activity_batch_too_large',
      `Activity batch must contain 1..${bounds.maxEvents} events.`,
    );
  }
  const encoded = JSON.stringify(events);
  if (encoder.encode(encoded).length > bounds.maxBytes) {
    throw new ByokCloudError(
      'activity_batch_too_large',
      `Activity batch exceeds ${bounds.maxBytes} UTF-8 bytes.`,
    );
  }
  return events.map((event) => JSON.stringify(event));
}

export async function appendActivityEvents(
  activity: TenantBoundActivity,
  input: {
    readonly taskId: string;
    readonly events: readonly AgentEventOrUnknown[];
    readonly dropped: number;
  },
  bounds: ActivityBounds,
): Promise<ActivityTail> {
  return activity.append({
    taskId: input.taskId,
    details: activityDetails(input.events, input.dropped, bounds),
    dropped: input.dropped,
    ttlMs: bounds.ttlMs,
    capacity: bounds.capacity,
  });
}
