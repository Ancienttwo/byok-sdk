import { assertCollectExpiredInput, type CollectExpiredInput, type CollectExpiredResult } from '@byok-sdk/core';
import type { Clock, TenantId } from '@byok-sdk/core';
import { ByokCloudError } from '../../errors';
import {
  activityCursor,
  activitySourceBatchState,
  activityTailKey,
  compareTimelineEvents,
  projectTimelineEvents,
  validateActivityAppend,
  type ActivityAppendInput,
  type ActivityStore,
  type ActivityTail,
} from '../../activity';

const TAILS = new WeakMap<InMemoryActivityStore, Map<string, ActivityTail>>();

/** Deletes the task's tail for the Host task archive (#1120); returns the rows removed. */
export function deleteActivityTail(store: InMemoryActivityStore, tenant: TenantId, taskId: string): number {
  return TAILS.get(store)!.delete(activityTailKey(tenant, taskId)) ? 1 : 0;
}

export class InMemoryActivityStore implements ActivityStore {
  readonly #tails = new Map<string, ActivityTail>();

  constructor(private readonly clock: Clock) {
    TAILS.set(this, this.#tails);
  }

  async append(tenant: TenantId, input: ActivityAppendInput): Promise<ActivityTail> {
    const capacity = validateActivityAppend(input);
    const now = this.clock.now();
    const receivedAt = now.toISOString();
    const key = activityTailKey(tenant, input.taskId);
    const existing = this.#tails.get(key);
    const live = existing !== undefined && receivedAt < existing.expiresAt ? existing : undefined;
    const sourceState = activitySourceBatchState(live?.entries ?? [], input);
    if (sourceState === 'same') return live!;
    if (sourceState === 'conflict') {
      throw new ByokCloudError(
        'coordination_input_invalid',
        `Activity source envelope ${input.sourceEnvelopeId} already belongs to another canonical batch.`,
      );
    }
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
  async collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    let removed = 0, more = false;
    for (const [key, tail] of this.#tails) {
      if (tail.tenantId !== tenant || tail.expiresAt > input.now) continue;
      if (removed === input.limit) { more = true; break; }
      this.#tails.delete(key); removed++;
    }
    return { removed, expired: 0, releasedBytes: 0n, more };
  }

}
