import {
  ByokCloudError,
  activityCursor,
  activitySourceBatchState,
  parseTimelineEvents,
  projectTimelineEvents,
  validateActivityAppend,
  type ActivityAppendInput,
  type ActivityStore,
  type ActivityTail,
} from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';

interface TailRow {
  readonly tenant_id: string;
  readonly task_id: string;
  readonly entries: unknown;
  readonly dropped: number;
  readonly capacity: number;
  readonly expires_at: string;
}

function toTail(row: TailRow): ActivityTail {
  const entries = parseTimelineEvents(row.entries);
  const cursor = activityCursor(entries);
  return {
    tenantId: row.tenant_id as TenantId,
    taskId: row.task_id,
    entries,
    ...(cursor === undefined ? {} : { cursor }),
    dropped: row.dropped,
    capacity: row.capacity,
    expiresAt: row.expires_at,
  };
}

export class PostgresActivityStore implements ActivityStore {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  async append(tenant: TenantId, input: ActivityAppendInput): Promise<ActivityTail> {
    const capacity = validateActivityAppend(input);
    const now = this.clock.now();
    const receivedAt = now.toISOString();
    const incoming = projectTimelineEvents(input, receivedAt);
    const expiresAt = new Date(now.getTime() + input.ttlMs).toISOString();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // A source-envelope replay must observe the exact row that will be
      // updated. The advisory lock also serializes first writers, when no row
      // exists for SELECT ... FOR UPDATE to lock yet.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1 || E'\\x1f' || $2, 0))`,
        [tenant, input.taskId],
      );
      const locked = await client.query<TailRow>(
        `SELECT tenant_id, task_id, entries, dropped, capacity, expires_at
           FROM activity_tail
          WHERE tenant_id = $1 AND task_id = $2
          FOR UPDATE`,
        [tenant, input.taskId],
      );
      const stored = locked.rows[0];
      const live = stored !== undefined && receivedAt < stored.expires_at ? toTail(stored) : undefined;
      const sourceState = activitySourceBatchState(live?.entries ?? [], input);
      if (sourceState === 'same') {
        await client.query('COMMIT');
        return live!;
      }
      if (sourceState === 'conflict') {
        throw new ByokCloudError(
          'coordination_input_invalid',
          `Activity source envelope ${input.sourceEnvelopeId} already belongs to another canonical batch.`,
        );
      }

      // The conflict arm reads activity_tail only after the per-tail lock. It
      // sorts the combined typed DTOs by stable order key before trimming, so
      // concurrent or delayed batches match the in-memory reference.
      const result = await client.query<TailRow>(
      `WITH incoming AS (
         SELECT entry
           FROM jsonb_array_elements($4::jsonb) AS element(entry)
       ), trimmed AS (
         SELECT COALESCE(jsonb_agg(entry ORDER BY
                    (entry->>'batchSeq')::bigint,
                    (entry->>'eventIndex')::bigint), '[]'::jsonb) AS entries,
                $5::integer + GREATEST(jsonb_array_length($4::jsonb) - $6, 0) AS dropped
           FROM (
             SELECT entry
               FROM incoming
              ORDER BY (entry->>'batchSeq')::bigint DESC,
                       (entry->>'eventIndex')::bigint DESC
              LIMIT $6
           ) retained
       )
       INSERT INTO activity_tail (tenant_id, task_id, entries, dropped, capacity, expires_at)
       SELECT $1, $2, trimmed.entries, trimmed.dropped, $6, $7 FROM trimmed
       ON CONFLICT (tenant_id, task_id) DO UPDATE
          SET entries = (
                SELECT COALESCE(jsonb_agg(entry ORDER BY
                         (entry->>'batchSeq')::bigint,
                         (entry->>'eventIndex')::bigint), '[]'::jsonb)
                  FROM (
                    SELECT entry
                      FROM jsonb_array_elements(
                        (CASE WHEN activity_tail.expires_at > $3
                              THEN activity_tail.entries ELSE '[]'::jsonb END) || $4::jsonb
                      ) AS element(entry)
                     ORDER BY (entry->>'batchSeq')::bigint DESC,
                              (entry->>'eventIndex')::bigint DESC
                     LIMIT $6
                  ) retained
              ),
              dropped = (CASE WHEN activity_tail.expires_at > $3
                              THEN activity_tail.dropped ELSE 0 END)
                        + $5::integer
                        + GREATEST(
                            jsonb_array_length(
                              (CASE WHEN activity_tail.expires_at > $3
                                    THEN activity_tail.entries ELSE '[]'::jsonb END) || $4::jsonb
                            ) - $6,
                            0
                          ),
              capacity = EXCLUDED.capacity,
              expires_at = EXCLUDED.expires_at
        WHERE activity_tail.expires_at <= $3
           OR (
              NOT EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(activity_tail.entries) AS stored(entry)
                 WHERE jsonb_typeof(entry) <> 'object'
                    OR NOT (entry ?& ARRAY[
                         'taskId', 'sourceEnvelopeId', 'batchSeq',
                         'eventIndex', 'receivedAt', 'event'
                       ])
              )
              AND NOT EXISTS (
                SELECT 1
                  FROM jsonb_array_elements(activity_tail.entries) AS old_element(entry)
                  CROSS JOIN jsonb_array_elements($4::jsonb) AS new_element(candidate)
                 WHERE (entry->>'batchSeq')::bigint = (candidate->>'batchSeq')::bigint
                   AND (entry->>'eventIndex')::bigint = (candidate->>'eventIndex')::bigint
                   AND entry->>'sourceEnvelopeId' <> candidate->>'sourceEnvelopeId'
              )
           )
       RETURNING tenant_id, task_id, entries, dropped, capacity, expires_at`,
      [tenant, input.taskId, receivedAt, JSON.stringify(incoming), input.dropped, capacity, expiresAt],
      );
      const row = result.rows[0];
      if (row === undefined) {
        throw new ByokCloudError(
          'coordination_input_invalid',
          `Activity batch ${input.batchSeq} conflicts with the existing typed tail authority.`,
        );
      }
      await client.query('COMMIT');
      return toTail(row);
    } catch (caught) {
      await client.query('ROLLBACK').catch(() => {});
      throw caught;
    } finally {
      client.release();
    }
  }

  async read(tenant: TenantId, taskId: string): Promise<ActivityTail | undefined> {
    const result = await this.pool.query<TailRow>(
      `SELECT tenant_id, task_id, entries, dropped, capacity, expires_at
         FROM activity_tail
        WHERE tenant_id = $1 AND task_id = $2 AND expires_at > $3`,
      [tenant, taskId, this.clock.now().toISOString()],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toTail(row);
  }
}
