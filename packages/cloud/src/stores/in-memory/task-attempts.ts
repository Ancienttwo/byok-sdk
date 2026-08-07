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
import { tenantKey, type Clock, type TenantId } from '@byok/core';
import type { TaskAttempt, TaskAttemptStatus, TaskAttemptStore } from '../ports';

export class InMemoryTaskAttemptStore implements TaskAttemptStore {
  readonly #attempts = new Map<string, TaskAttempt>();
  readonly #clock: Clock;

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  async open(tenant: TenantId, input: { taskId: string; deviceId: string }): Promise<TaskAttempt> {
    const key = tenantKey(tenant, input.taskId);
    const existing = this.#attempts.get(key);
    if (existing !== undefined) return existing;
    const attempt: TaskAttempt = {
      tenantId: tenant,
      taskId: input.taskId,
      deviceId: input.deviceId,
      status: 'offered',
      updatedAt: this.#now(),
    };
    this.#attempts.set(key, attempt);
    return attempt;
  }

  async get(tenant: TenantId, taskId: string): Promise<TaskAttempt | undefined> {
    return this.#attempts.get(tenantKey(tenant, taskId));
  }

  async claim(tenant: TenantId, input: { taskId: string; deviceId: string }): Promise<TaskAttempt | undefined> {
    const key = tenantKey(tenant, input.taskId);
    const existing = this.#attempts.get(key);
    if (existing === undefined) return undefined;
    if (existing.ownerDeviceId !== undefined) return existing;
    const claimed: TaskAttempt = {
      ...existing,
      ownerDeviceId: input.deviceId,
      status: 'claimed',
      updatedAt: this.#now(),
    };
    this.#attempts.set(key, claimed);
    return claimed;
  }

  async recordStatus(
    tenant: TenantId,
    input: { taskId: string; status: TaskAttemptStatus },
  ): Promise<TaskAttempt | undefined> {
    const key = tenantKey(tenant, input.taskId);
    const existing = this.#attempts.get(key);
    if (existing === undefined) return undefined;
    const updated: TaskAttempt = { ...existing, status: input.status, updatedAt: this.#now() };
    this.#attempts.set(key, updated);
    return updated;
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}
