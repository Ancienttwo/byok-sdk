/**
 * Postgres {@link TaskSteerRefusalStore} (wire v7, #2009) over
 * `task_steer_refusal` (0040).
 *
 * A record runs in one transaction under a per-task advisory lock: the
 * first-write check, the next revision and the insert see the same committed
 * rows, so a task's revisions are gapless and a committed revision never
 * overtakes an uncommitted lower one. The table has no foreign key to `task`:
 * a refusal is an observation keyed by ids, like a receipt. Archive, redaction,
 * retention and device retirement keep its rows, as they keep the terminal
 * receipt; only tenant erasure deletes them.
 */
import type { SteerRefusalRecord, TaskSteerRefusalStore } from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool, PoolClient } from 'pg';
import type { ByokPool } from '../pool.js';

const COLUMNS = 'task_id, steer_message_id, reason, device_id, recorded_at, revision';

interface SteerRefusalRow {
  readonly task_id: string;
  readonly steer_message_id: string;
  readonly reason: string;
  readonly device_id: string;
  readonly recorded_at: Date;
  readonly revision: number;
}

function toRecord(row: SteerRefusalRow): SteerRefusalRecord {
  return {
    taskId: row.task_id,
    steerMessageId: row.steer_message_id,
    reason: row.reason,
    deviceId: row.device_id,
    recordedAt: row.recorded_at.toISOString(),
    revision: row.revision,
  };
}

export class PostgresTaskSteerRefusalStore implements TaskSteerRefusalStore {
  readonly #pool: Pool;
  readonly #clock: Clock;

  constructor(pool: ByokPool, clock: Clock) {
    this.#pool = pool;
    this.#clock = clock;
  }

  async record(
    tenant: TenantId,
    input: { readonly taskId: string; readonly steerMessageId: string; readonly reason: string; readonly deviceId: string },
  ): Promise<{ readonly refusal: SteerRefusalRecord; readonly created: boolean }> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [JSON.stringify(['steer-refusal', tenant, input.taskId])]);
      const existing = await selectOne(client, tenant, input.taskId, input.steerMessageId);
      const result = existing !== undefined
        ? { refusal: existing, created: false }
        : { refusal: await insert(client, tenant, input, this.#clock.now().toISOString()), created: true };
      await client.query('COMMIT');
      return result;
    } catch (caught) {
      await client.query('ROLLBACK');
      throw caught;
    } finally {
      client.release();
    }
  }

  async get(tenant: TenantId, taskId: string, steerMessageId: string): Promise<SteerRefusalRecord | undefined> {
    return selectOne(this.#pool, tenant, taskId, steerMessageId);
  }

  async list(
    tenant: TenantId,
    query: { readonly taskId: string; readonly afterRevision: number; readonly limit: number },
  ): Promise<readonly SteerRefusalRecord[]> {
    const result = await this.#pool.query<SteerRefusalRow>(
      `SELECT ${COLUMNS} FROM task_steer_refusal
        WHERE tenant_id = $1 AND task_id = $2 AND revision > $3
        ORDER BY revision
        LIMIT $4`,
      [tenant, query.taskId, query.afterRevision, query.limit],
    );
    return result.rows.map(toRecord);
  }
}

async function selectOne(
  db: Pool | PoolClient,
  tenant: TenantId,
  taskId: string,
  steerMessageId: string,
): Promise<SteerRefusalRecord | undefined> {
  const result = await db.query<SteerRefusalRow>(
    `SELECT ${COLUMNS} FROM task_steer_refusal WHERE tenant_id = $1 AND task_id = $2 AND steer_message_id = $3`,
    [tenant, taskId, steerMessageId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toRecord(row);
}

async function insert(
  client: PoolClient,
  tenant: TenantId,
  input: { readonly taskId: string; readonly steerMessageId: string; readonly reason: string; readonly deviceId: string },
  recordedAt: string,
): Promise<SteerRefusalRecord> {
  const result = await client.query<SteerRefusalRow>(
    `INSERT INTO task_steer_refusal (tenant_id, task_id, steer_message_id, reason, device_id, recorded_at, revision)
     SELECT $1, $2, $3, $4, $5, $6,
            COALESCE((SELECT MAX(revision) FROM task_steer_refusal WHERE tenant_id = $1 AND task_id = $2), 0) + 1
     RETURNING ${COLUMNS}`,
    [tenant, input.taskId, input.steerMessageId, input.reason, input.deviceId, recordedAt],
  );
  return toRecord(result.rows[0]!);
}
