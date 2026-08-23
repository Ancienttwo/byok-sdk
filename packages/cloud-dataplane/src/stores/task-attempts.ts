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
import type { AgentRef, TaskAttempt, TaskAttemptStatus, TaskAttemptStore } from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';

export interface TaskRow {
  readonly tenant_id: string;
  readonly task_id: string;
  readonly device_id: string;
  readonly agent_id: string | null;
  readonly agent_profile_revision: string | null;
  readonly owner_device_id: string | null;
  readonly status: string;
  readonly terminal_cause: string | null;
  readonly cancel_requested_at: Date | null;
  readonly cancel_reason: string | null;
  readonly cancel_message_id: string | null;
  readonly updated_at: Date;
}

export const TASK_SELECT_COLUMNS =
  'tenant_id, task_id, device_id, agent_id, agent_profile_revision, owner_device_id, status, terminal_cause, cancel_requested_at, cancel_reason, cancel_message_id, updated_at';

export function taskRowToAttempt(row: TaskRow): TaskAttempt {
  return {
    tenantId: row.tenant_id as TenantId,
    taskId: row.task_id,
    deviceId: row.device_id,
    ...(row.agent_id == null || row.agent_profile_revision == null
      ? {}
      : {
          agentRef: {
            agentId: row.agent_id,
            profileRevision: row.agent_profile_revision,
          },
        }),
    // `exactOptionalPropertyTypes` is off here, but an explicit absent key is
    // still what the in-memory reference produces for an unclaimed attempt, and
    // `toEqual` in the suite treats `undefined` and absent alike only for the
    // former.
    ...(row.owner_device_id === null ? {} : { ownerDeviceId: row.owner_device_id }),
    status: row.status as TaskAttemptStatus,
    ...(row.terminal_cause == null ? {} : { terminalCause: row.terminal_cause }),
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
    input: { readonly taskId: string; readonly deviceId: string; readonly agentRef?: AgentRef },
  ): Promise<TaskAttempt> {
    // First offer wins: a re-open returns the existing attempt untouched, so a
    // second offer cannot retarget a task at a different device.
    const inserted = await this.#pool.query<TaskRow>(
      `INSERT INTO task (
         tenant_id, task_id, device_id, agent_id, agent_profile_revision,
         owner_device_id, status, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, NULL, 'offered', $6)
       ON CONFLICT (tenant_id, task_id) DO NOTHING
       RETURNING ${TASK_SELECT_COLUMNS}`,
      [
        tenant,
        input.taskId,
        input.deviceId,
        input.agentRef?.agentId ?? null,
        input.agentRef?.profileRevision ?? null,
        this.#now(),
      ],
    );
    const created = inserted.rows[0];
    if (created !== undefined) return taskRowToAttempt(created);

    const existing = await this.get(tenant, input.taskId);
    // Unreachable in practice: the insert only declines when the row exists.
    if (existing === undefined) throw new Error(`task ${input.taskId} vanished during open`);
    return existing;
  }

  async reserveAgentOffer(
    tenant: TenantId,
    input: { readonly taskId: string; readonly deviceId: string; readonly agentRef: AgentRef },
  ): Promise<{ readonly attempt: TaskAttempt; readonly created: boolean }> {
    const inserted = await this.#pool.query<TaskRow>(
      `INSERT INTO task (
         tenant_id, task_id, device_id, agent_id, agent_profile_revision,
         owner_device_id, status, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, NULL, 'offered', $6)
       ON CONFLICT (tenant_id, task_id) DO NOTHING
       RETURNING ${TASK_SELECT_COLUMNS}`,
      [tenant, input.taskId, input.deviceId, input.agentRef.agentId, input.agentRef.profileRevision, this.#now()],
    );
    const created = inserted.rows[0];
    if (created !== undefined) return { attempt: taskRowToAttempt(created), created: true };
    const existing = await this.get(tenant, input.taskId);
    if (existing === undefined) throw new Error(`task ${input.taskId} vanished during Agent offer reservation`);
    return { attempt: existing, created: false };
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
    input: {
      readonly taskId: string;
      readonly status: TaskAttemptStatus;
      readonly agentRef?: AgentRef;
      readonly terminalCause?: string;
    },
  ): Promise<TaskAttempt | undefined> {
    const result = await this.#pool.query<TaskRow>(
      `UPDATE task
          SET status = $3,
              terminal_cause = COALESCE($7, terminal_cause),
              updated_at = $4
        WHERE tenant_id = $1 AND task_id = $2
          AND (
            ($5::text IS NULL AND $6::text IS NULL)
            OR (agent_id = $5 AND agent_profile_revision = $6)
          )
          AND (
            (cancel_requested_at IS NULL AND status NOT IN ('complete', 'failed', 'cancelled'))
            OR (cancel_requested_at IS NOT NULL AND $3 = 'cancelled' AND status <> 'cancelled')
          )
      RETURNING ${TASK_SELECT_COLUMNS}`,
      [
        tenant,
        input.taskId,
        input.status,
        this.#now(),
        input.agentRef?.agentId ?? null,
        input.agentRef?.profileRevision ?? null,
        input.terminalCause ?? null,
      ],
    );
    const row = result.rows[0];
    return row === undefined ? this.get(tenant, input.taskId) : taskRowToAttempt(row);
  }

  #now(): string {
    return this.#clock.now().toISOString();
  }
}
