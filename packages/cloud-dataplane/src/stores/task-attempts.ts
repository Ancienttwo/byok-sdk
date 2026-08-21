/**
 * Postgres {@link TaskAttemptStore} — the ownership authority the inbound gate
 * reads (N2).
 *
 * `claim` is a single guarded statement: `UPDATE ... WHERE owner_device_id IS
 * NULL RETURNING ...`. Two devices racing the same offer therefore produce one
 * owner, not a last writer. When the guard rejects, the row is re-read and
 * returned as-is, which makes a losing claim (and the winner's own re-claim)
 * idempotent rather than an error — the caller learns who owns the task either
 * way. Ownership never transfers: reassigning an owner is the one operation
 * that would make the gate's cross-device assertion unfalsifiable.
 *
 * Two deliberate no-ops, both about not letting a guessed id leave a trace:
 * `claim` and `recordStatus` on a task this tenant never offered write nothing
 * and return `undefined`.
 */
import type { TaskAttempt, TaskAttemptStatus, TaskAttemptStore } from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';

export interface TaskRow {
  readonly tenant_id: string;
  readonly task_id: string;
  readonly device_id: string;
  readonly owner_device_id: string | null;
  readonly status: string;
  readonly cancel_requested_at: Date | null;
  readonly cancel_reason: string | null;
  readonly cancel_message_id: string | null;
  readonly updated_at: Date;
}

export const TASK_SELECT_COLUMNS =
  'tenant_id, task_id, device_id, owner_device_id, status, cancel_requested_at, cancel_reason, cancel_message_id, updated_at';

export function taskRowToAttempt(row: TaskRow): TaskAttempt {
  return {
    tenantId: row.tenant_id as TenantId,
    taskId: row.task_id,
    deviceId: row.device_id,
    // `exactOptionalPropertyTypes` is off here, but an explicit absent key is
    // still what the in-memory reference produces for an unclaimed attempt, and
    // `toEqual` in the suite treats `undefined` and absent alike only for the
    // former.
    ...(row.owner_device_id === null ? {} : { ownerDeviceId: row.owner_device_id }),
    status: row.status as TaskAttemptStatus,
    ...(row.cancel_requested_at === null
      ? {}
      : {
          cancellation: {
            requestedAt: row.cancel_requested_at.toISOString(),
            ...(row.cancel_reason === null ? {} : { reason: row.cancel_reason }),
          },
        }),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresTaskAttemptStore implements TaskAttemptStore {
  readonly #pool: Pool;
  readonly #clock: Clock;

  constructor(pool: Pool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async open(
    tenant: TenantId,
    input: { readonly taskId: string; readonly deviceId: string },
  ): Promise<TaskAttempt> {
    // First offer wins: a re-open returns the existing attempt untouched, so a
    // second offer cannot retarget a task at a different device.
    const inserted = await this.#pool.query<TaskRow>(
      `INSERT INTO task (tenant_id, task_id, device_id, owner_device_id, status, updated_at)
       VALUES ($1, $2, $3, NULL, 'offered', $4)
       ON CONFLICT (tenant_id, task_id) DO NOTHING
       RETURNING ${TASK_SELECT_COLUMNS}`,
      [tenant, input.taskId, input.deviceId, this.#now()],
    );
    const created = inserted.rows[0];
    if (created !== undefined) return taskRowToAttempt(created);

    const existing = await this.get(tenant, input.taskId);
    // Unreachable in practice: the insert only declines when the row exists.
    if (existing === undefined) throw new Error(`task ${input.taskId} vanished during open`);
    return existing;
  }

  async get(tenant: TenantId, taskId: string): Promise<TaskAttempt | undefined> {
    const result = await this.#pool.query<TaskRow>(
      `SELECT ${TASK_SELECT_COLUMNS} FROM task WHERE tenant_id = $1 AND task_id = $2`,
      [tenant, taskId],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : taskRowToAttempt(row);
  }

  async getMany(tenant: TenantId, taskIds: readonly string[]): Promise<readonly TaskAttempt[]> {
    if (taskIds.length === 0) return [];
    const result = await this.#pool.query<TaskRow>(
      `SELECT ${TASK_SELECT_COLUMNS} FROM task WHERE tenant_id = $1 AND task_id = ANY($2::text[])`,
      [tenant, [...new Set(taskIds)]],
    );
    return result.rows.map(taskRowToAttempt);
  }

  async claim(
    tenant: TenantId,
    input: { readonly taskId: string; readonly deviceId: string },
  ): Promise<TaskAttempt | undefined> {
    const claimed = await this.#pool.query<TaskRow>(
      `UPDATE task
          SET owner_device_id = $3, status = 'claimed', updated_at = $4
        WHERE tenant_id = $1 AND task_id = $2 AND owner_device_id IS NULL
          AND cancel_requested_at IS NULL AND status = 'offered'
      RETURNING ${TASK_SELECT_COLUMNS}`,
      [tenant, input.taskId, input.deviceId, this.#now()],
    );
    const won = claimed.rows[0];
    if (won !== undefined) return taskRowToAttempt(won);

    // Either the task is already owned, or this tenant never offered it. The
    // re-read tells those apart without a second guard, and returns
    // `undefined` for the guess.
    return this.get(tenant, input.taskId);
  }

  async recordStatus(
    tenant: TenantId,
    input: { readonly taskId: string; readonly status: TaskAttemptStatus },
  ): Promise<TaskAttempt | undefined> {
    const result = await this.#pool.query<TaskRow>(
      `UPDATE task
          SET status = $3, updated_at = $4
        WHERE tenant_id = $1 AND task_id = $2
          AND (
            (cancel_requested_at IS NULL AND status NOT IN ('complete', 'failed', 'cancelled'))
            OR (cancel_requested_at IS NOT NULL AND $3 = 'cancelled' AND status <> 'cancelled')
          )
      RETURNING ${TASK_SELECT_COLUMNS}`,
      [tenant, input.taskId, input.status, this.#now()],
    );
    const row = result.rows[0];
    return row === undefined ? this.get(tenant, input.taskId) : taskRowToAttempt(row);
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}
