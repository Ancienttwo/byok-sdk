import { tenantKey, type Clock, type TenantId } from '@byok-sdk/core';
import type { SteerRefusalRecord, TaskSteerRefusalStore } from '../ports.js';

/**
 * In-memory {@link TaskSteerRefusalStore}. Each record is one synchronous
 * step, so the first-write check and the next revision of the task cannot
 * interleave with another record of the same task.
 */
export class InMemoryTaskSteerRefusalStore implements TaskSteerRefusalStore {
  /** Per tenant task, in revision order. */
  readonly #tasks = new Map<string, SteerRefusalRecord[]>();
  readonly #clock: Clock;
  readonly #changed: (tenant: TenantId, taskId: string) => void;

  /** @param changed Called after a new refusal commits; a replay does not call it. */
  constructor(clock: Clock, changed: (tenant: TenantId, taskId: string) => void) {
    this.#clock = clock;
    this.#changed = changed;
  }

  async record(
    tenant: TenantId,
    input: { readonly taskId: string; readonly steerMessageId: string; readonly reason: string; readonly deviceId: string },
  ): Promise<{ readonly refusal: SteerRefusalRecord; readonly created: boolean }> {
    const key = tenantKey(tenant, input.taskId);
    const rows = this.#tasks.get(key) ?? [];
    const existing = rows.find((row) => row.steerMessageId === input.steerMessageId);
    if (existing !== undefined) return { refusal: existing, created: false };
    const refusal: SteerRefusalRecord = {
      taskId: input.taskId,
      steerMessageId: input.steerMessageId,
      reason: input.reason,
      deviceId: input.deviceId,
      recordedAt: this.#clock.now().toISOString(),
      revision: rows.length + 1,
    };
    this.#tasks.set(key, [...rows, refusal]);
    this.#changed(tenant, input.taskId);
    return { refusal, created: true };
  }

  async get(tenant: TenantId, taskId: string, steerMessageId: string): Promise<SteerRefusalRecord | undefined> {
    return this.#tasks.get(tenantKey(tenant, taskId))?.find((row) => row.steerMessageId === steerMessageId);
  }

  async list(
    tenant: TenantId,
    query: { readonly taskId: string; readonly afterRevision: number; readonly limit: number },
  ): Promise<readonly SteerRefusalRecord[]> {
    return (this.#tasks.get(tenantKey(tenant, query.taskId)) ?? [])
      .filter((row) => row.revision > query.afterRevision)
      .slice(0, query.limit);
  }
}
