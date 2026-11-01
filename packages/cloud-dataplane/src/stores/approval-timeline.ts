import { assertCollectExpiredInput, type CollectExpiredInput, type CollectExpiredResult } from '@byok-sdk/core';
import {
  ApprovalObservationSchema,
  ByokCloudError,
  approvalTimelineCursor,
  parseApprovalObservations,
  pendingApprovalObservation,
  retainApprovalObservations,
  sameApprovalTimelineEvent,
  validateApprovalTimelineAppend,
  validateApprovalTimelineResolve,
  type ApprovalTimelineAppendInput,
  type ApprovalTimelineResolvePendingInput,
  type ApprovalTimelineResolvePendingResult,
  type ApprovalTimelineStore,
  type ApprovalTimelineTail,
} from '@byok-sdk/cloud';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { PoolClient } from 'pg';
import type { ByokPool } from '../pool';

interface TailRow {
  readonly tenant_id: string;
  readonly task_id: string;
  readonly entries: unknown;
  readonly next_revision: string | number | bigint;
  readonly dropped: number;
  readonly capacity: number;
  readonly terminal_at: string | null;
  readonly expires_at: string | null;
}

const COLUMNS = 'tenant_id, task_id, entries, next_revision, dropped, capacity, terminal_at, expires_at';

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
    ...(row.terminal_at === null || row.expires_at === null ? {} : { terminalAt: row.terminal_at, expiresAt: row.expires_at }),
  };
}

function expired(row: TailRow, now: string): boolean {
  return row.expires_at !== null && row.expires_at <= now;
}

async function readLocked(
  client: PoolClient,
  tenant: TenantId,
  taskId: string,
): Promise<TailRow | undefined> {
  const result = await client.query<TailRow>(
    `SELECT ${COLUMNS} FROM approval_timeline_tail WHERE tenant_id = $1 AND task_id = $2 FOR UPDATE`,
    [tenant, taskId],
  );
  return result.rows[0];
}

/** Writes the next observation of an open timeline; eviction keeps the pending request. */
async function persist(
  client: PoolClient,
  tenant: TenantId,
  input: ApprovalTimelineAppendInput,
  validated: { readonly capacity: number; readonly event: ApprovalTimelineAppendInput['event'] },
  receivedAt: string,
  stored: TailRow | undefined,
): Promise<ApprovalTimelineTail> {
  const live = stored === undefined ? undefined : toTail(stored);
  const revision = stored === undefined ? 1 : Number(stored.next_revision);
  if (!Number.isSafeInteger(revision) || revision <= 0 || revision !== (live?.cursor ?? 0) + 1) {
    throw new ByokCloudError('coordination_input_invalid', 'Approval timeline revision authority is malformed.');
  }
  const observation = ApprovalObservationSchema.parse({
    taskId: input.taskId, sourceEnvelopeId: input.sourceEnvelopeId, revision, receivedAt, event: validated.event,
  });
  const retained = retainApprovalObservations(live?.entries ?? [], observation, validated.capacity);
  const result = await client.query<TailRow>(
    `INSERT INTO approval_timeline_tail (tenant_id, task_id, entries, next_revision, dropped, capacity)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)
     ON CONFLICT (tenant_id, task_id) DO UPDATE
       SET entries = EXCLUDED.entries, next_revision = EXCLUDED.next_revision,
           dropped = EXCLUDED.dropped, capacity = EXCLUDED.capacity
       WHERE approval_timeline_tail.terminal_at IS NULL
     RETURNING ${COLUMNS}`,
    [tenant, input.taskId, JSON.stringify(retained.entries), revision + 1, (live?.dropped ?? 0) + retained.evicted, validated.capacity],
  );
  // With no row to lock, the task's close can insert its closed row first;
  // the conflict then lands on that row and must not reopen it.
  if (result.rows[0] === undefined) {
    throw new ByokCloudError('approval_timeline_settled', 'The task output closed; its approval timeline admits no observation.');
  }
  return toTail(result.rows[0]);
}

export class PostgresApprovalTimelineStore implements ApprovalTimelineStore {
  constructor(
    private readonly pool: ByokPool,
    private readonly clock: Clock,
  ) {}

  /** Clears expired observations and keeps each closed row as its fence. */
  async collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    const result = await this.pool.query<{removed: string; more: boolean}>(
      `WITH candidates AS MATERIALIZED (
         SELECT ctid FROM approval_timeline_tail
          WHERE tenant_id = $1 AND expires_at <= $2 AND entries <> '[]'::jsonb
         ORDER BY expires_at LIMIT $3 + 1 FOR UPDATE SKIP LOCKED
       ), cleared AS (
         UPDATE approval_timeline_tail SET entries = '[]'::jsonb WHERE ctid IN (SELECT ctid FROM candidates LIMIT $3) RETURNING 1
       ) SELECT (SELECT count(*) FROM cleared)::text AS removed,
                EXISTS(SELECT 1 FROM candidates OFFSET $3) AS more`,
      [tenant, input.now, input.limit],
    );
    return { removed: Number(result.rows[0]!.removed), expired: 0, releasedBytes: 0n, more: result.rows[0]!.more };
  }

  async append(
    tenant: TenantId,
    input: ApprovalTimelineAppendInput,
  ): Promise<ApprovalTimelineTail> {
    const validated = validateApprovalTimelineAppend(input);
    const receivedAt = this.clock.now().toISOString();
    return this.#locked(tenant, input.taskId, async (client) => {
      const stored = await readLocked(client, tenant, input.taskId);
      const duplicate = stored === undefined || expired(stored, receivedAt)
        ? undefined : toTail(stored).entries.find((entry) => entry.sourceEnvelopeId === input.sourceEnvelopeId);
      if (duplicate !== undefined) {
        if (!sameApprovalTimelineEvent(duplicate.event, validated.event)) {
          throw new ByokCloudError(
            'coordination_input_invalid',
            'Approval source envelope identity already belongs to another lifecycle event.',
          );
        }
        return toTail(stored!);
      }
      if (stored?.terminal_at != null) {
        throw new ByokCloudError('approval_timeline_settled', 'The task output closed; its approval timeline admits no observation.');
      }
      return persist(client, tenant, input, validated, receivedAt, stored);
    });
  }

  async resolvePending(
    tenant: TenantId,
    input: ApprovalTimelineResolvePendingInput,
  ): Promise<ApprovalTimelineResolvePendingResult> {
    const validated = validateApprovalTimelineResolve(input);
    const receivedAt = this.clock.now().toISOString();
    return this.#locked(tenant, input.taskId, async (client): Promise<ApprovalTimelineResolvePendingResult> => {
      const stored = await readLocked(client, tenant, input.taskId);
      if (stored === undefined || expired(stored, receivedAt)) return { status: 'absent' };
      const live = toTail(stored);
      const duplicate = live.entries.find((entry) => entry.sourceEnvelopeId === input.sourceEnvelopeId);
      if (duplicate !== undefined) {
        return sameApprovalTimelineEvent(duplicate.event, validated.event)
          ? { status: 'replayed', tail: live }
          : { status: 'conflict', tail: live };
      }
      // A closed timeline has no request left to decide.
      const pending = live.terminalAt === undefined ? pendingApprovalObservation(live.entries) : undefined;
      if (pending === undefined) return { status: 'absent', tail: live };
      if (pending.sourceEnvelopeId !== input.expectedSourceEnvelopeId || pending.revision !== input.expectedRevision) {
        return { status: 'superseded', tail: live };
      }
      return { status: 'applied', tail: await persist(client, tenant, input, validated, receivedAt, stored) };
    });
  }

  async read(tenant: TenantId, taskId: string): Promise<ApprovalTimelineTail | undefined> {
    const result = await this.pool.query<TailRow>(
      `SELECT ${COLUMNS} FROM approval_timeline_tail
        WHERE tenant_id = $1 AND task_id = $2 AND (expires_at IS NULL OR expires_at > $3)`,
      [tenant, taskId, this.clock.now().toISOString()],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : toTail(row);
  }

  /** One transaction under the task's advisory lock, the timeline's per-task serialization. */
  async #locked<T>(tenant: TenantId, taskId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1 || E'\\x1f' || $2, 0))`, [tenant, taskId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (caught) {
      await client.query('ROLLBACK');
      throw caught;
    } finally {
      client.release();
    }
  }
}
