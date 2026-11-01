import type { TenantId } from '@byok-sdk/core';

/** Called after a write to a task's in-memory state, in the writer's synchronous step. */
export type TaskChanged = (tenant: TenantId, taskId: string) => void;

/**
 * A per-task state map that reports each write, so a task events wake hears
 * every writer of the map, module helpers included (#1113 A4).
 */
export class TaskChangeMap<V> extends Map<string, V> {
  readonly #identify: (value: V) => { readonly tenantId: TenantId; readonly taskId: string };
  readonly #changed: TaskChanged | undefined;

  constructor(identify: (value: V) => { readonly tenantId: TenantId; readonly taskId: string }, changed: TaskChanged | undefined) {
    super();
    this.#identify = identify;
    this.#changed = changed;
  }

  override set(key: string, value: V): this {
    super.set(key, value);
    const { tenantId, taskId } = this.#identify(value);
    this.#changed?.(tenantId, taskId);
    return this;
  }
}
