import type { Clock, TenantId } from '@byok-sdk/core';
import { ByokCloudError } from '../../errors';
import {
  ApprovalObservationSchema,
  approvalTimelineCursor,
  approvalTimelineKey,
  validateApprovalTimelineAppend,
  validateApprovalTimelineResolve,
  type ApprovalTimelineAppendInput,
  type ApprovalTimelineResolvePendingInput,
  type ApprovalTimelineResolvePendingResult,
  type ApprovalObservation,
  type ApprovalTimelineStore,
  type ApprovalTimelineTail,
} from '../../approval-timeline';

export class InMemoryApprovalTimelineStore implements ApprovalTimelineStore {
  readonly #tails = new Map<string, ApprovalTimelineTail>();

  constructor(private readonly clock: Clock) {}

  async append(
    tenant: TenantId,
    input: ApprovalTimelineAppendInput,
  ): Promise<ApprovalTimelineTail> {
    const { capacity, ttlMs, event } = validateApprovalTimelineAppend(input);
    const now = this.clock.now();
    const receivedAt = now.toISOString();
    const key = approvalTimelineKey(tenant, input.taskId);
    const existing = this.#tails.get(key);
    const live = existing !== undefined && receivedAt < existing.expiresAt ? existing : undefined;
    if (live !== undefined) {
      const duplicate = live.entries.find(
        (entry) => entry.sourceEnvelopeId === input.sourceEnvelopeId,
      );
      if (duplicate !== undefined) {
        if (JSON.stringify(duplicate.event) !== JSON.stringify(event)) {
          throw new ByokCloudError(
            'coordination_input_invalid',
            'Approval source envelope identity already belongs to another lifecycle event.',
          );
        }
        return live;
      }
    }

    const revision = (live?.cursor ?? 0) + 1;
    const observation = ApprovalObservationSchema.parse({
      taskId: input.taskId,
      sourceEnvelopeId: input.sourceEnvelopeId,
      revision,
      receivedAt,
      event,
    });
    const allEntries = [...(live?.entries ?? []), observation];
    const evicted = Math.max(allEntries.length - capacity, 0);
    const entries = allEntries.slice(evicted);
    const tail: ApprovalTimelineTail = {
      tenantId: tenant,
      taskId: input.taskId,
      entries,
      cursor: approvalTimelineCursor(entries),
      dropped: (live?.dropped ?? 0) + evicted,
      capacity,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    this.#tails.set(key, tail);
    return tail;
  }

  async resolvePending(
    tenant: TenantId,
    input: ApprovalTimelineResolvePendingInput,
  ): Promise<ApprovalTimelineResolvePendingResult> {
    const { capacity, ttlMs, event } = validateApprovalTimelineResolve(input);
    const now = this.clock.now();
    const receivedAt = now.toISOString();
    const key = approvalTimelineKey(tenant, input.taskId);
    const existing = this.#tails.get(key);
    const live = existing !== undefined && receivedAt < existing.expiresAt ? existing : undefined;
    if (live === undefined) return { status: 'absent' };

    const duplicate = live.entries.find((entry) => entry.sourceEnvelopeId === input.sourceEnvelopeId);
    if (duplicate !== undefined) {
      if (JSON.stringify(duplicate.event) !== JSON.stringify(event)) return { status: 'conflict', tail: live };
      return { status: 'replayed', tail: live };
    }

    const pending = pendingObservation(live.entries);
    if (pending === undefined) return { status: 'absent', tail: live };
    if (
      pending.sourceEnvelopeId !== input.expectedSourceEnvelopeId ||
      pending.revision !== input.expectedRevision
    ) {
      return { status: 'superseded', tail: live };
    }

    const revision = (live.cursor ?? 0) + 1;
    const observation = ApprovalObservationSchema.parse({
      taskId: input.taskId,
      sourceEnvelopeId: input.sourceEnvelopeId,
      revision,
      receivedAt,
      event,
    });
    const allEntries = [...live.entries, observation];
    const evicted = Math.max(allEntries.length - capacity, 0);
    const tail: ApprovalTimelineTail = {
      tenantId: tenant,
      taskId: input.taskId,
      entries: allEntries.slice(evicted),
      cursor: revision,
      dropped: live.dropped + evicted,
      capacity,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    this.#tails.set(key, tail);
    return { status: 'applied', tail };
  }

  async read(tenant: TenantId, taskId: string): Promise<ApprovalTimelineTail | undefined> {
    const key = approvalTimelineKey(tenant, taskId);
    const tail = this.#tails.get(key);
    if (tail === undefined) return undefined;
    if (this.clock.now().toISOString() >= tail.expiresAt) {
      this.#tails.delete(key);
      return undefined;
    }
    return tail;
  }
}

function pendingObservation(entries: readonly ApprovalObservation[]): ApprovalObservation | undefined {
  let pending: ApprovalObservation | undefined;
  for (const entry of entries) {
    if (entry.event.type === 'approval_requested') {
      pending = entry;
      continue;
    }
    if (
      pending !== undefined &&
      (pending.event.approvalId === undefined || pending.event.approvalId === entry.event.approvalId)
    ) {
      pending = undefined;
    }
  }
  return pending;
}
