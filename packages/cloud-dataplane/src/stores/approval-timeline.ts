import {
  ApprovalObservationSchema,
  ByokCloudError,
  approvalTimelineCursor,
  parseApprovalObservations,
  validateApprovalTimelineAppend,
  type ApprovalTimelineAppendInput,
  type ApprovalTimelineStore,
  type ApprovalTimelineTail,
} from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool, PoolClient } from 'pg';

interface TailRow {
  readonly tenant_id: string;
  readonly task_id: string;
  readonly entries: unknown;
  readonly next_revision: string | number | bigint;
  readonly dropped: number;
  readonly capacity: number;
  readonly expires_at: string;
}

function toTail(row: TailRow): ApprovalTimelineTail {
  const entries = parseApprovalObservations(row.entries);
  const cursor = approvalTimelineCursor(entries);
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

async function readLocked(
  client: PoolClient,
  tenant: TenantId,
  taskId: string,
): Promise<TailRow | undefined> {
  const result = await client.query<TailRow>(
    `SELECT tenant_id, task_id, entries, next_revision, dropped, capacity, expires_at
       FROM approval_timeline_tail
      WHERE tenant_id = $1 AND task_id = $2
      FOR UPDATE`,
    [tenant, taskId],
  );
  return result.rows[0];
}

export class PostgresApprovalTimelineStore implements ApprovalTimelineStore {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  async append(
    tenant: TenantId,
    input: ApprovalTimelineAppendInput,
  ): Promise<ApprovalTimelineTail> {
    const { capacity, ttlMs, event } = validateApprovalTimelineAppend(input);
    const now = this.clock.now();
    const receivedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1 || E'\\x1f' || $2, 0))`,
        [tenant, input.taskId],
      );
      const stored = await readLocked(client, tenant, input.taskId);
      const live = stored !== undefined && receivedAt < stored.expires_at ? toTail(stored) : undefined;
      const duplicate = live?.entries.find(
        (entry) => entry.sourceEnvelopeId === input.sourceEnvelopeId,
      );
      if (duplicate !== undefined) {
        if (JSON.stringify(duplicate.event) !== JSON.stringify(event)) {
          throw new ByokCloudError(
            'coordination_input_invalid',
            'Approval source envelope identity already belongs to another lifecycle event.',
          );
        }
        await client.query('COMMIT');
        return live!;
      }

      const revision = live === undefined ? 1 : Number(stored!.next_revision);
      if (!Number.isSafeInteger(revision) || revision <= 0) {
        throw new ByokCloudError(
          'coordination_input_invalid',
          'Approval timeline revision authority is malformed.',
        );
      }
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
      const dropped = (live?.dropped ?? 0) + evicted;
      const result = await client.query<TailRow>(
        `INSERT INTO approval_timeline_tail
           (tenant_id, task_id, entries, next_revision, dropped, capacity, expires_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, task_id) DO UPDATE
           SET entries = EXCLUDED.entries,
               next_revision = EXCLUDED.next_revision,
               dropped = EXCLUDED.dropped,
               capacity = EXCLUDED.capacity,
               expires_at = EXCLUDED.expires_at
         RETURNING tenant_id, task_id, entries, next_revision, dropped, capacity, expires_at`,
        [
          tenant,
          input.taskId,
          JSON.stringify(entries),
          revision + 1,
          dropped,
          capacity,
          expiresAt,
        ],
      );
      await client.query('COMMIT');
      return toTail(result.rows[0]!);
    } catch (caught) {
      await client.query('ROLLBACK');
      throw caught;
    } finally {
      client.release();
    }
  }

  async read(tenant: TenantId, taskId: string): Promise<ApprovalTimelineTail | undefined> {
    const result = await this.pool.query<TailRow>(
      `SELECT tenant_id, task_id, entries, next_revision, dropped, capacity, expires_at
         FROM approval_timeline_tail
        WHERE tenant_id = $1 AND task_id = $2 AND expires_at > $3`,
      [tenant, taskId, this.clock.now().toISOString()],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toTail(row);
  }
}
