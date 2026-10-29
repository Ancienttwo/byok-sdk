/**
 * In-memory {@link TaskAttemptStore} — the ownership authority the inbound
 * gate reads (N2).
 *
 * Two deliberate no-ops:
 *
 * - `claim` on a task this tenant never offered writes nothing. A device that
 *   guesses a taskId must not be able to conjure a row (and, cross-tenant,
 *   must not leave a trace in the tenant it guessed into).
 * - `recordStatus` on an unknown task writes nothing, mirroring the reference
 *   server's per-type handlers, whose behavior on a missing record is a no-op
 *   rather than a rejection.
 *
 * Ownership is first-claim-wins and never transfers: reassigning an owner is
 * the one operation that would make the gate's cross-device assertion
 * unfalsifiable.
 */
import { tenantKey, type Clock, type TenantId } from '@byok-sdk/core';
import type { RuntimeCapabilities, RuntimeId } from '@byok-sdk/protocol';
import { assertTaskAttemptListLimit } from '../../coordination';
import {
  TASK_ATTEMPT_ACTIVE_STATUSES,
  TASK_ATTEMPT_STATUSES,
  type AgentMessageAdmission,
  type AgentRef,
  type TaskAttempt,
  type TaskAttemptCounts,
  type TaskAttemptListQuery,
  type TaskAttemptPage,
  type TaskAttemptStatus,
  type TaskAttemptStore,
} from '../ports';

function sameAgentRef(left: AgentRef | undefined, right: AgentRef | undefined): boolean {
  return left?.agentId === right?.agentId && left?.profileRevision === right?.profileRevision;
}

interface StoredAgentMessageAdmission extends AgentMessageAdmission {
  readonly deviceId: string;
}

export class InMemoryTaskAttemptStore implements TaskAttemptStore {
  readonly #state: InMemoryTaskAttemptState;

  constructor(clock: Clock, state = new InMemoryTaskAttemptState(clock)) {
    this.#state = state;
  }

  async open(
    tenant: TenantId,
    input: { readonly taskId: string; readonly deviceId: string; readonly agentRef?: AgentRef },
  ): Promise<TaskAttempt> {
    const key = tenantKey(tenant, input.taskId);
    return this.#state.mutate(key, () => {
      const existing = this.#state.attempts.get(key);
      if (existing !== undefined) return existing;
      const now = this.#now();
      const attempt: TaskAttempt = {
        tenantId: tenant,
        taskId: input.taskId,
        deviceId: input.deviceId,
        ...(input.agentRef === undefined ? {} : { agentRef: { ...input.agentRef } }),
        status: 'offered',
        offeredAt: now,
        updatedAt: now,
      };
      this.#state.attempts.set(key, attempt);
      return attempt;
    });
  }

  async reserveAgentOffer(
    tenant: TenantId,
    input: { readonly taskId: string; readonly deviceId: string; readonly agentRef: AgentRef },
  ): Promise<{ readonly attempt: TaskAttempt; readonly created: boolean }> {
    const key = tenantKey(tenant, input.taskId);
    return this.#state.mutate(key, () => {
      const existing = this.#state.attempts.get(key);
      if (existing !== undefined) return { attempt: existing, created: false };
      const now = this.#now();
      const attempt: TaskAttempt = {
        tenantId: tenant,
        taskId: input.taskId,
        deviceId: input.deviceId,
        agentRef: { ...input.agentRef },
        status: 'offered',
        offeredAt: now,
        updatedAt: now,
      };
      this.#state.attempts.set(key, attempt);
      return { attempt, created: true };
    });
  }

  async reserveAgentMessage(
    tenant: TenantId,
    input: { readonly taskId: string; readonly deviceId: string; readonly messageId: string; readonly payloadBody: string },
  ): Promise<'reserved' | 'pending' | 'rejected'> {
    const key = tenantKey(tenant, input.taskId);
    return this.#state.mutate(key, () => {
      const existing = this.#state.messageAdmissions.get(key);
      if (existing !== undefined) {
        return existing.deviceId === input.deviceId &&
          existing.messageId === input.messageId &&
          existing.payloadBody === input.payloadBody
          ? 'pending'
          : 'rejected';
      }
      const attempt = this.#state.attempts.get(key);
      if (
        attempt === undefined ||
        attempt.deviceId !== input.deviceId ||
        attempt.cancellation !== undefined ||
        !['offered', 'claimed', 'running'].includes(attempt.status)
      ) return 'rejected';
      this.#state.messageAdmissions.set(key, {
        deviceId: input.deviceId,
        messageId: input.messageId,
        payloadBody: input.payloadBody,
      });
      if (attempt.ownerDeviceId !== undefined && attempt.firstOutputAt === undefined) {
        this.#state.attempts.set(key, { ...attempt, firstOutputAt: this.#now() });
      }
      return 'reserved';
    });
  }

  async recordFirstOutput(
    tenant: TenantId, input: { readonly taskId: string; readonly deviceId: string },
  ): Promise<TaskAttempt | undefined> {
    const key = tenantKey(tenant, input.taskId);
    return this.#state.mutate(key, () => {
      const attempt = this.#state.attempts.get(key);
      if (
        attempt === undefined ||
        attempt.deviceId !== input.deviceId ||
        attempt.ownerDeviceId === undefined ||
        attempt.firstOutputAt !== undefined ||
        ['complete', 'failed', 'cancelled'].includes(attempt.status)
      ) return attempt;
      const stamped: TaskAttempt = { ...attempt, firstOutputAt: this.#now() };
      this.#state.attempts.set(key, stamped);
      return stamped;
    });
  }

  async readTaskAgentMessage(
    tenant: TenantId, input: { readonly taskId: string; readonly deviceId: string },
  ): Promise<AgentMessageAdmission | undefined> {
    const admission = this.#state.messageAdmissions.get(tenantKey(tenant, input.taskId));
    return admission?.deviceId === input.deviceId ? admission : undefined;
  }

  async readAgentMessage(
    tenant: TenantId,
    input: { readonly taskId: string; readonly deviceId: string; readonly messageId: string; readonly payloadBody: string },
  ): Promise<AgentMessageAdmission | undefined> {
    const admission = this.#state.messageAdmissions.get(tenantKey(tenant, input.taskId));
    return admission !== undefined && admission.deviceId === input.deviceId && admission.messageId === input.messageId && admission.payloadBody === input.payloadBody
      ? admission
      : undefined;
  }

  async finalizeAgentMessage(
    tenant: TenantId,
    input: {
      readonly taskId: string;
      readonly deviceId: string;
      readonly messageId: string;
      readonly payloadBody: string;
      readonly terminalBody: string;
    },
  ): Promise<AgentMessageAdmission | undefined> {
    const key = tenantKey(tenant, input.taskId);
    return this.#state.mutate(key, () => this.#terminalize(key, input));
  }

  #terminalize(
    key: string,
    input: { readonly deviceId: string; readonly messageId: string; readonly payloadBody: string; readonly terminalBody: string },
  ): AgentMessageAdmission | undefined {
    const admission = this.#state.messageAdmissions.get(key);
    if (admission === undefined || admission.deviceId !== input.deviceId || admission.messageId !== input.messageId || admission.payloadBody !== input.payloadBody) {
      return undefined;
    }
    if (admission.terminalBody !== undefined) return admission;
    const terminal = { ...admission, terminalBody: input.terminalBody };
    this.#state.messageAdmissions.set(key, terminal);
    return terminal;
  }

  async get(tenant: TenantId, taskId: string): Promise<TaskAttempt | undefined> {
    return this.#state.attempts.get(tenantKey(tenant, taskId));
  }

  async getMany(tenant: TenantId, taskIds: readonly string[]): Promise<readonly TaskAttempt[]> {
    return taskIds.flatMap((taskId) => {
      const attempt = this.#state.attempts.get(tenantKey(tenant, taskId));
      return attempt === undefined ? [] : [attempt];
    });
  }

  async list(tenant: TenantId, query: TaskAttemptListQuery): Promise<TaskAttemptPage> {
    assertTaskAttemptListLimit(query.limit, query.active);
    const cursor = query.cursor;
    // Filtered on the row's OWN tenant rather than on a key prefix: the
    // attempt carries its tenant, so this cannot be widened by a tenant id that
    // happens to prefix another.
    const matches = [...this.#state.attempts.values()]
      .filter((attempt) => attempt.tenantId === tenant)
      .filter((attempt) => query.active === undefined ||
        (attempt.cancellation === undefined && TASK_ATTEMPT_ACTIVE_STATUSES.some((status) => status === attempt.status)))
      .filter((attempt) => cursor === undefined || attempt.taskId > cursor)
      .sort((left, right) => (left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0));
    // One over the limit is what tells "this page is full" apart from "there is
    // more" without a second count query.
    const attempts = matches.slice(0, query.limit);
    const hasMore = matches.length > attempts.length;
    const last = attempts.at(-1);
    return {
      attempts,
      ...(hasMore && last !== undefined ? { nextCursor: last.taskId } : {}),
    };
  }

  async countByStatus(tenant: TenantId): Promise<TaskAttemptCounts> {
    const byStatus = Object.fromEntries(TASK_ATTEMPT_STATUSES.map((status) => [status, 0])) as Record<TaskAttemptStatus, number>;
    let cancellationRequested = 0;
    for (const attempt of this.#state.attempts.values()) {
      if (attempt.tenantId !== tenant) continue;
      if (!TASK_ATTEMPT_STATUSES.includes(attempt.status)) throw new Error('Unknown stored task attempt status');
      if (attempt.cancellation !== undefined) cancellationRequested += 1;
      else byStatus[attempt.status] += 1;
    }
    return { byStatus, cancellationRequested };
  }

  async claim(
    tenant: TenantId,
    input: {
      taskId: string;
      deviceId: string;
      runtime?: RuntimeId;
      harnessId?: string;
      capabilities?: RuntimeCapabilities;
    },
  ): Promise<TaskAttempt | undefined> {
    const key = tenantKey(tenant, input.taskId);
    return this.#state.mutate(key, () => {
      const existing = this.#state.attempts.get(key);
      if (existing === undefined) return undefined;
      if (
        existing.deviceId !== input.deviceId ||
        existing.ownerDeviceId !== undefined ||
        existing.cancellation !== undefined ||
        existing.status !== 'offered'
      ) return existing;
      // The claim snapshot is written here and nowhere else: this branch is
      // reached only by the claim that actually takes the ownership, so a
      // re-claim (which returned above) can never restamp it.
      const now = this.#now();
      const claimed: TaskAttempt = {
        ...existing,
        ownerDeviceId: input.deviceId,
        ...(input.runtime === undefined ? {} : { claimedRuntime: input.runtime }),
        ...(input.harnessId === undefined ? {} : { claimedHarnessId: input.harnessId }),
        ...(input.capabilities === undefined
          ? {}
          : { claimedRuntimeCapabilities: { ...input.capabilities } }),
        status: 'claimed',
        claimedAt: now,
        updatedAt: now,
      };
      this.#state.attempts.set(key, claimed);
      return claimed;
    });
  }

  async recordStatus(
    tenant: TenantId,
    input: {
      readonly taskId: string;
      readonly status: TaskAttemptStatus;
      readonly agentRef?: AgentRef;
      readonly terminalCause?: string;
    },
  ): Promise<TaskAttempt | undefined> {
    const key = tenantKey(tenant, input.taskId);
    return this.#state.mutate(key, () => {
      const existing = this.#state.attempts.get(key);
      if (existing === undefined) return undefined;
      if (
        (existing.agentRef === undefined) !== (input.agentRef === undefined) ||
        (existing.agentRef !== undefined && !sameAgentRef(existing.agentRef, input.agentRef))
      ) return existing;
      if (existing.cancellation !== undefined) {
        if (input.status !== 'cancelled' || existing.status === 'cancelled') return existing;
      } else if (
        existing.status === 'complete' ||
        existing.status === 'failed' ||
        existing.status === 'cancelled'
      ) {
        return existing;
      }
      const updatedAt = this.#now();
      const updated: TaskAttempt = {
        ...existing,
        status: input.status,
        ...(input.terminalCause === undefined ? {} : { terminalCause: input.terminalCause }),
        ...(existing.terminalAt === undefined && ['complete', 'failed', 'cancelled'].includes(input.status) ? { terminalAt: updatedAt } : {}),
        updatedAt,
      };
      this.#state.attempts.set(key, updated);
      return updated;
    });
  }

  #now(): string {
    return this.#state.now();
  }
}

/** Shared mutable state for the task and cancellation reference ports. */
export class InMemoryTaskAttemptState {
  readonly attempts = new Map<string, TaskAttempt>();
  readonly messageAdmissions = new Map<string, StoredAgentMessageAdmission>();
  /** `archive_settled_at` of archived tasks (#1120), by tenant/task key. */
  readonly archiveSettled = new Map<string, string>();
  readonly #clock: Clock;
  readonly #mutationTails = new Map<string, Promise<void>>();
  /** Settles when the exclusive section in progress (or queued last) ends. */
  #exclusiveTail: Promise<void> = Promise.resolve();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  now(): string {
    return this.#clock.now().toISOString();
  }

  /**
   * Serialize every state-changing operation for one tenant/task key. It also
   * waits for an exclusive section queued before it (see {@link exclusive}).
   */
  async mutate<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#mutationTails.get(key) ?? Promise.resolve();
    const exclusive = this.#exclusiveTail;
    const result = Promise.all([previous, exclusive]).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#mutationTails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.#mutationTails.get(key) === tail) this.#mutationTails.delete(key);
    }
  }

  /**
   * Runs `operation` with no task mutation in flight: it starts once every
   * mutation queued before it has settled, and every mutation queued after it
   * waits for it to end. Device retirement runs here, so its attempt and
   * mailbox halves are one step no cancellation or abandonment can split, the
   * in-memory stand-in for the SQL stores' transaction (#1119). `operation`
   * writes `attempts` directly; calling {@link mutate} from it deadlocks.
   */
  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const queued = [this.#exclusiveTail, ...this.#mutationTails.values()];
    const result = Promise.all(queued).then(operation);
    this.#exclusiveTail = result.then(() => undefined, () => undefined);
    return result;
  }
}
