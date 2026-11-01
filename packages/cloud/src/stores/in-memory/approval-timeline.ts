import { assertCollectExpiredInput, type CollectExpiredInput, type CollectExpiredResult } from '@byok-sdk/core';
import type { Clock, TenantId } from '@byok-sdk/core';
import { ByokCloudError } from '../../errors';
import {
  ApprovalObservationSchema,
  DEFAULT_APPROVAL_TIMELINE_CAPACITY,
  DEFAULT_APPROVAL_TIMELINE_TTL_MS,
  approvalTimelineKey,
  pendingApprovalObservation,
  retainApprovalObservations,
  sameApprovalTimelineEvent,
  validateApprovalTimelineAppend,
  validateApprovalTimelineResolve,
  type ApprovalTimelineAppendInput,
  type ApprovalTimelineResolvePendingInput,
  type ApprovalTimelineResolvePendingResult,
  type ApprovalTimelineStore,
  type ApprovalTimelineTail,
} from '../../approval-timeline';
import { TaskChangeMap, type TaskChanged } from './task-change-map';

const TAILS = new WeakMap<InMemoryApprovalTimelineStore, Map<string, ApprovalTimelineTail>>();

function expired(tail: ApprovalTimelineTail, now: string): boolean {
  return tail.expiresAt !== undefined && tail.expiresAt <= now;
}

/**
 * Removes the task's observations for the Host task archive (#1120) and keeps
 * the closed tail as a fence, so no later observation recreates it. Returns
 * the rows that held observations.
 */
export function deleteApprovalTimelineTail(store: InMemoryApprovalTimelineStore, tenant: TenantId, taskId: string): number {
  const tails = TAILS.get(store)!;
  const key = approvalTimelineKey(tenant, taskId);
  const tail = tails.get(key);
  if (tail === undefined) return 0;
  tails.set(key, { ...tail, entries: [] });
  return tail.entries.length > 0 ? 1 : 0;
}

/**
 * Close the timeline in the caller's synchronous step, at the instant the
 * task's output closed. The first close wins (#1113 A3).
 */
export function closeApprovalTimeline(store: InMemoryApprovalTimelineStore, tenant: TenantId, taskId: string, terminalAt: string): void {
  const tails = TAILS.get(store)!;
  const key = approvalTimelineKey(tenant, taskId);
  const tail = tails.get(key) ?? { tenantId: tenant, taskId, entries: [], dropped: 0, capacity: DEFAULT_APPROVAL_TIMELINE_CAPACITY };
  if (tail.terminalAt !== undefined) return;
  tails.set(key, { ...tail, terminalAt, expiresAt: new Date(Date.parse(terminalAt) + DEFAULT_APPROVAL_TIMELINE_TTL_MS).toISOString() });
}

export class InMemoryApprovalTimelineStore implements ApprovalTimelineStore {
  readonly #tails: Map<string, ApprovalTimelineTail>;

  constructor(private readonly clock: Clock, changed?: TaskChanged) {
    this.#tails = new TaskChangeMap<ApprovalTimelineTail>((tail) => ({ tenantId: tail.tenantId, taskId: tail.taskId }), changed);
    TAILS.set(this, this.#tails);
  }

  async append(
    tenant: TenantId,
    input: ApprovalTimelineAppendInput,
  ): Promise<ApprovalTimelineTail> {
    const { capacity, event } = validateApprovalTimelineAppend(input);
    const receivedAt = this.clock.now().toISOString();
    const key = approvalTimelineKey(tenant, input.taskId);
    const existing = this.#tails.get(key);
    const duplicate = existing === undefined || expired(existing, receivedAt)
      ? undefined
      : existing.entries.find((entry) => entry.sourceEnvelopeId === input.sourceEnvelopeId);
    if (duplicate !== undefined) {
      if (!sameApprovalTimelineEvent(duplicate.event, event)) {
        throw new ByokCloudError(
          'coordination_input_invalid',
          'Approval source envelope identity already belongs to another lifecycle event.',
        );
      }
      return existing!;
    }
    if (existing?.terminalAt !== undefined) {
      throw new ByokCloudError('approval_timeline_settled', 'The task output closed; its approval timeline admits no observation.');
    }

    const observation = ApprovalObservationSchema.parse({
      taskId: input.taskId,
      sourceEnvelopeId: input.sourceEnvelopeId,
      revision: (existing?.cursor ?? 0) + 1,
      receivedAt,
      event,
    });
    const retained = retainApprovalObservations(existing?.entries ?? [], observation, capacity);
    const tail: ApprovalTimelineTail = {
      tenantId: tenant,
      taskId: input.taskId,
      entries: retained.entries,
      cursor: observation.revision,
      dropped: (existing?.dropped ?? 0) + retained.evicted,
      capacity,
    };
    this.#tails.set(key, tail);
    return tail;
  }

  async resolvePending(
    tenant: TenantId,
    input: ApprovalTimelineResolvePendingInput,
  ): Promise<ApprovalTimelineResolvePendingResult> {
    const { capacity, event } = validateApprovalTimelineResolve(input);
    const receivedAt = this.clock.now().toISOString();
    const key = approvalTimelineKey(tenant, input.taskId);
    const live = this.#tails.get(key);
    if (live === undefined || expired(live, receivedAt)) return { status: 'absent' };

    const duplicate = live.entries.find((entry) => entry.sourceEnvelopeId === input.sourceEnvelopeId);
    if (duplicate !== undefined) {
      if (!sameApprovalTimelineEvent(duplicate.event, event)) return { status: 'conflict', tail: live };
      return { status: 'replayed', tail: live };
    }

    // A closed timeline has no request left to decide.
    const pending = live.terminalAt === undefined ? pendingApprovalObservation(live.entries) : undefined;
    if (pending === undefined) return { status: 'absent', tail: live };
    if (
      pending.sourceEnvelopeId !== input.expectedSourceEnvelopeId ||
      pending.revision !== input.expectedRevision
    ) {
      return { status: 'superseded', tail: live };
    }

    const observation = ApprovalObservationSchema.parse({
      taskId: input.taskId,
      sourceEnvelopeId: input.sourceEnvelopeId,
      revision: (live.cursor ?? 0) + 1,
      receivedAt,
      event,
    });
    const retained = retainApprovalObservations(live.entries, observation, capacity);
    const tail: ApprovalTimelineTail = {
      tenantId: tenant,
      taskId: input.taskId,
      entries: retained.entries,
      cursor: observation.revision,
      dropped: live.dropped + retained.evicted,
      capacity,
    };
    this.#tails.set(key, tail);
    return { status: 'applied', tail };
  }

  async read(tenant: TenantId, taskId: string): Promise<ApprovalTimelineTail | undefined> {
    const tail = this.#tails.get(approvalTimelineKey(tenant, taskId));
    return tail === undefined || expired(tail, this.clock.now().toISOString()) ? undefined : tail;
  }

  /** Clears expired observations and keeps each closed tail as its fence. */
  async collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    let removed = 0, more = false;
    for (const [key, tail] of this.#tails) {
      if (tail.tenantId !== tenant || tail.entries.length === 0 || !expired(tail, input.now)) continue;
      if (removed === input.limit) { more = true; break; }
      this.#tails.set(key, { ...tail, entries: [] }); removed++;
    }
    return { removed, expired: 0, releasedBytes: 0n, more };
  }
}
