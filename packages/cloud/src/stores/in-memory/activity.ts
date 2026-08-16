import type { Clock, TenantId } from '@byok-sdk/core';
import { ByokCloudError } from '../../errors';
import {
  activityCursor,
  activityTailKey,
  compareTimelineEvents,
  projectTimelineEvents,
  validateActivityAppend,
  type ActivityAppendInput,
  type ActivityStore,
  type ActivityTail,
} from '../../activity';

export class InMemoryActivityStore implements ActivityStore {
  readonly #tails = new Map<string, ActivityTail>();

  constructor(private readonly clock: Clock) {}

  async append(tenant: TenantId, input: ActivityAppendInput): Promise<ActivityTail> {
    const capacity = validateActivityAppend(input);
    const now = this.clock.now();
    const receivedAt = now.toISOString();
    const key = activityTailKey(tenant, input.taskId);
    const existing = this.#tails.get(key);
    const live = existing !== undefined && receivedAt < existing.expiresAt ? existing : undefined;
    const incoming = projectTimelineEvents(input, receivedAt);
    for (const next of incoming) {
      const collision = live?.entries.find(
        (entry) =>
          entry.batchSeq === next.batchSeq &&
          entry.eventIndex === next.eventIndex &&
          entry.sourceEnvelopeId !== next.sourceEnvelopeId,
      );
      if (collision !== undefined) {
        throw new ByokCloudError(
          'coordination_input_invalid',
          `Activity order key (${next.batchSeq}, ${next.eventIndex}) already belongs to another source envelope.`,
        );
      }
    }
    const allEntries = [...(live?.entries ?? []), ...incoming].sort(compareTimelineEvents);
    const evicted = Math.max(allEntries.length - capacity, 0);
    const entries = allEntries.slice(evicted);
    const cursor = activityCursor(entries);
    const tail: ActivityTail = {
      tenantId: tenant,
      taskId: input.taskId,
      entries,
      ...(cursor === undefined ? {} : { cursor }),
      dropped: (live?.dropped ?? 0) + input.dropped + evicted,
      capacity,
      expiresAt: new Date(now.getTime() + input.ttlMs).toISOString(),
    };
    this.#tails.set(key, tail);
    return tail;
  }

  async read(tenant: TenantId, taskId: string): Promise<ActivityTail | undefined> {
    const key = activityTailKey(tenant, taskId);
    const tail = this.#tails.get(key);
    if (tail === undefined) return undefined;
    if (this.clock.now().toISOString() >= tail.expiresAt) {
      this.#tails.delete(key);
      return undefined;
    }
    return tail;
  }
}
