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
  type AgentMessageAdmission,
  type AgentRef,
  type TaskAttempt,
  type TaskAttemptListQuery,
  type TaskAttemptPage,
  type TaskAttemptStatus,
  type TaskAttemptStore,
} from '../ports';

function sameAgentRef(left: AgentRef | undefined, right: AgentRef | undefined): boolean {
  return left?.agentId === right?.agentId && left?.profileRevision === right?.profileRevision;
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
      const attempt: TaskAttempt = {
        tenantId: tenant,
        taskId: input.taskId,
        deviceId: input.deviceId,
        ...(input.agentRef === undefined ? {} : { agentRef: { ...input.agentRef } }),
        status: 'offered',
        updatedAt: this.#now(),
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
      const attempt: TaskAttempt = {
        tenantId: tenant,
        taskId: input.taskId,
        deviceId: input.deviceId,
        agentRef: { ...input.agentRef },
        status: 'offered',
        updatedAt: this.#now(),
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
      const attempt = this.#state.attempts.get(key);
      if (
        attempt === undefined ||
        attempt.deviceId !== input.deviceId ||
        attempt.cancellation !== undefined ||
        !['offered', 'claimed', 'running'].includes(attempt.status)
      ) return 'rejected';
      const existing = this.#state.messageAdmissions.get(key);
      if (existing === undefined) {
        this.#state.messageAdmissions.set(key, {
          messageId: input.messageId,
          payloadBody: input.payloadBody,
        });
        return 'reserved';
      }
      return existing.messageId === input.messageId && existing.payloadBody === input.payloadBody
        ? 'pending'
        : 'rejected';
    });
  }

  async readAgentMessage(
    tenant: TenantId,
    input: { readonly taskId: string; readonly deviceId: string; readonly messageId: string; readonly payloadBody: string },
  ): Promise<AgentMessageAdmission | undefined> {
    const admission = this.#state.messageAdmissions.get(tenantKey(tenant, input.taskId));
    return admission !== undefined && admission.messageId === input.messageId && admission.payloadBody === input.payloadBody
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
    input: { readonly messageId: string; readonly payloadBody: string; readonly terminalBody: string },
  ): AgentMessageAdmission | undefined {
    const admission = this.#state.messageAdmissions.get(key);
    if (admission === undefined || admission.messageId !== input.messageId || admission.payloadBody !== input.payloadBody) {
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
    assertTaskAttemptListLimit(query.limit);
    const cursor = query.cursor;
    // Filtered on the row's OWN tenant rather than on a key prefix: the
    // attempt carries its tenant, so this cannot be widened by a tenant id that
    // happens to prefix another.
    const matches = [...this.#state.attempts.values()]
      .filter((attempt) => attempt.tenantId === tenant)
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

  async claim(
    tenant: TenantId,
    input: {
      taskId: string;
      deviceId: string;
      runtime?: RuntimeId;
      capabilities?: RuntimeCapabilities;
    },
  ): Promise<TaskAttempt | undefined> {
    const key = tenantKey(tenant, input.taskId);
    return this.#state.mutate(key, () => {
      const existing = this.#state.attempts.get(key);
      if (existing === undefined) return undefined;
      if (
        existing.ownerDeviceId !== undefined ||
        existing.cancellation !== undefined ||
        existing.status !== 'offered'
      ) return existing;
      // The claim snapshot is written here and nowhere else: this branch is
      // reached only by the claim that actually takes the ownership, so a
      // re-claim (which returned above) can never restamp it.
      const claimed: TaskAttempt = {
        ...existing,
        ownerDeviceId: input.deviceId,
        ...(input.runtime === undefined ? {} : { claimedRuntime: input.runtime }),
        ...(input.capabilities === undefined
          ? {}
          : { claimedRuntimeCapabilities: { ...input.capabilities } }),
        status: 'claimed',
        updatedAt: this.#now(),
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
      const updated: TaskAttempt = {
        ...existing,
        status: input.status,
        ...(input.terminalCause === undefined ? {} : { terminalCause: input.terminalCause }),
        updatedAt: this.#now(),
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
  readonly messageAdmissions = new Map<string, AgentMessageAdmission>();
  readonly #clock: Clock;
  readonly #mutationTails = new Map<string, Promise<void>>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  now(): string {
    return this.#clock.now().toISOString();
  }

  /** Serialize every state-changing operation for one tenant/task key. */
  async mutate<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#mutationTails.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
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
}
