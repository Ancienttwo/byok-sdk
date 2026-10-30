import { assertCollectExpiredInput, type Clock, type CollectExpiredInput, type CollectExpiredResult, type TenantId } from '@byok-sdk/core';
import {
  ByokCloudError, activityEntryBytes, activitySourceHash, createActivityEntry, validateActivityAppend,
  MAX_ACTIVITY_BYTES, type ActivityAppendInput, type ActivityReadOptions, type ActivityStore, type ActivityTail, type ActivityTailEntry,
} from '@byok-sdk/cloud';
import type { PoolClient } from 'pg';
import type { ByokPool } from '../pool';
import { assertByokPool } from '../pool-brand';

interface Head {
  tenant_id: string; task_id: string; generation: string;
  revision: bigint; floor: bigint; dropped: bigint; source_dropped: bigint;
  capacity: number; byte_capacity: number; retained_bytes: number; ttl_ms: number;
  terminal_at: string | null; expires_at: string | null; removed: boolean;
}

/** All operations serialize on the durable task head; no process-local replay state. */
export class PostgresActivityStore implements ActivityStore {
  constructor(private readonly pool: ByokPool, private readonly clock: Clock) { assertByokPool(pool, 'PostgresActivityStore'); }

  async #transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async #head(client: PoolClient, tenant: TenantId, taskId: string): Promise<Head | undefined> {
    return (await client.query<Head>('SELECT * FROM activity_log_head WHERE tenant_id = $1 AND task_id = $2 FOR UPDATE', [tenant, taskId])).rows[0];
  }

  async #clearExpired(client: PoolClient, head: Head, now: string): Promise<void> {
    if (head.expires_at === null || head.expires_at > now || head.retained_bytes === 0) return;
    await client.query('UPDATE activity_log_entry SET body = NULL, byte_size = 0 WHERE tenant_id = $1 AND task_id = $2 AND body IS NOT NULL', [head.tenant_id, head.task_id]);
    await client.query('UPDATE activity_log_head SET floor = revision, retained_bytes = 0 WHERE tenant_id = $1 AND task_id = $2', [head.tenant_id, head.task_id]);
    head.floor = head.revision;
    head.retained_bytes = 0;
  }

  async #tail(client: PoolClient, head: Head, after = 0): Promise<ActivityTail> {
    const rows = await client.query<{ body: ActivityTailEntry }>(
      'SELECT body FROM activity_log_entry WHERE tenant_id = $1 AND task_id = $2 AND revision > $3 AND body IS NOT NULL ORDER BY revision',
      [head.tenant_id, head.task_id, after],
    );
    return {
      tenantId: head.tenant_id as TenantId, taskId: head.task_id, entries: rows.rows.map(row => row.body),
      cursor: { version: 1, tenantId: head.tenant_id as TenantId, taskId: head.task_id, generation: head.generation, revision: Number(head.revision) },
      floor: Number(head.floor), dropped: Number(head.dropped), sourceDropped: Number(head.source_dropped),
      capacity: head.capacity, byteCapacity: head.byte_capacity, retainedBytes: head.retained_bytes,
      ...(head.terminal_at === null ? {} : { terminalAt: head.terminal_at }),
      ...(head.expires_at === null ? {} : { expiresAt: head.expires_at }),
    };
  }

  async append(tenant: TenantId, input: ActivityAppendInput): Promise<ActivityTail> {
    const capacity = validateActivityAppend(input);
    const snapshot = structuredClone(input);
    const hash = await activitySourceHash(snapshot);
    const byteCapacity = snapshot.byteCapacity ?? MAX_ACTIVITY_BYTES;
    return this.#transaction(async client => {
      const created = await client.query(
        `INSERT INTO activity_log_head (tenant_id, task_id, capacity, byte_capacity, ttl_ms)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING task_id`,
        [tenant, snapshot.taskId, capacity, byteCapacity, snapshot.ttlMs],
      );
      const head = (await this.#head(client, tenant, snapshot.taskId))!;
      if (head.removed) throw new ByokCloudError('activity_history_gap', 'Activity content was removed.');
      const previous = (await client.query<{ source_hash: string }>(
        'SELECT source_hash FROM activity_log_entry WHERE tenant_id = $1 AND task_id = $2 AND source_envelope_id = $3',
        [tenant, snapshot.taskId, snapshot.sourceEnvelopeId],
      )).rows[0];
      if (previous !== undefined) {
        if (previous.source_hash !== hash) throw new ByokCloudError('coordination_input_invalid', 'Activity source identity conflicts with a previous submission.');
        await this.#clearExpired(client, head, this.clock.now().toISOString());
        return this.#tail(client, head);
      }
      if (head.terminal_at !== null) throw new ByokCloudError('activity_task_settled', 'Task activity admission is closed.');
      if (created.rowCount === 0 && (head.capacity !== capacity || head.byte_capacity !== byteCapacity || head.ttl_ms !== snapshot.ttlMs)) {
        throw new ByokCloudError('coordination_input_invalid', 'Activity retention bounds are fixed by the first append.');
      }
      const revision = Number(head.revision) + 1;
      if (!Number.isSafeInteger(revision)) throw new ByokCloudError('coordination_input_invalid', 'Activity revision exhausted.');
      const entry = createActivityEntry(snapshot, revision, this.clock.now().toISOString());
      const bytes = activityEntryBytes(entry);
      if (bytes > byteCapacity) throw new ByokCloudError('activity_batch_too_large', 'Activity entry exceeds its serialized byte cap.');
      await client.query(
        `INSERT INTO activity_log_entry (tenant_id, task_id, revision, source_envelope_id, source_hash, body, byte_size)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [tenant, snapshot.taskId, revision, snapshot.sourceEnvelopeId, hash, JSON.stringify(entry), bytes],
      );
      const retained = (await client.query<{ revision: bigint; byte_size: number }>(
        'SELECT revision, byte_size FROM activity_log_entry WHERE tenant_id = $1 AND task_id = $2 AND body IS NOT NULL ORDER BY revision',
        [tenant, snapshot.taskId],
      )).rows;
      let retainedBytes = head.retained_bytes + bytes, evicted = 0, floor = Number(head.floor);
      while (retained.length - evicted > capacity || retainedBytes > byteCapacity) {
        const oldest = retained[evicted++]!;
        retainedBytes -= oldest.byte_size;
        floor = Number(oldest.revision);
      }
      if (evicted > 0) await client.query(
        'UPDATE activity_log_entry SET body = NULL, byte_size = 0 WHERE tenant_id = $1 AND task_id = $2 AND revision <= $3 AND body IS NOT NULL',
        [tenant, snapshot.taskId, floor],
      );
      const updated = (await client.query<Head>(
        `UPDATE activity_log_head SET revision = $3, floor = $4, retained_bytes = $5,
           dropped = dropped + $6, source_dropped = source_dropped + $7
         WHERE tenant_id = $1 AND task_id = $2 RETURNING *`,
        [tenant, snapshot.taskId, revision, floor, retainedBytes, evicted, 'dropped' in snapshot ? snapshot.dropped : 0],
      )).rows[0]!;
      return this.#tail(client, updated);
    });
  }

  async settle(tenant: TenantId, taskId: string, terminalAt: string): Promise<ActivityTail> {
    const terminalMs = Date.parse(terminalAt);
    if (!Number.isFinite(terminalMs) || new Date(terminalMs).toISOString() !== terminalAt) {
      throw new ByokCloudError('coordination_input_invalid', 'Activity terminal time must be canonical ISO.');
    }
    return this.#transaction(async client => {
      await client.query('INSERT INTO activity_log_head (tenant_id, task_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [tenant, taskId]);
      let head = (await this.#head(client, tenant, taskId))!;
      if (head.removed) throw new ByokCloudError('activity_history_gap', 'Activity content was removed.');
      if (head.terminal_at === null) head = (await client.query<Head>(
        'UPDATE activity_log_head SET terminal_at = $3, expires_at = $4 WHERE tenant_id = $1 AND task_id = $2 RETURNING *',
        [tenant, taskId, terminalAt, new Date(terminalMs + head.ttl_ms).toISOString()],
      )).rows[0]!;
      await this.#clearExpired(client, head, this.clock.now().toISOString());
      return this.#tail(client, head);
    });
  }

  async read(tenant: TenantId, taskId: string, options: ActivityReadOptions = {}): Promise<ActivityTail | undefined> {
    const after = options.after;
    if (after !== undefined) {
      const cursor = after as unknown;
      if (cursor !== null && typeof cursor === 'object' && !('version' in cursor)
        && 'batchSeq' in cursor && Number.isSafeInteger(cursor.batchSeq) && Number(cursor.batchSeq) >= 0
        && 'eventIndex' in cursor && Number.isSafeInteger(cursor.eventIndex) && Number(cursor.eventIndex) >= 0) {
        throw new ByokCloudError('activity_history_gap', 'Activity cursor predates this log generation.');
      }
      if (cursor === null || typeof cursor !== 'object' || after.version !== 1
        || after.tenantId !== tenant || after.taskId !== taskId || !Number.isSafeInteger(after.revision)
        || after.revision < 0 || typeof after.generation !== 'string' || after.generation.length === 0) {
        throw new ByokCloudError('activity_cursor_invalid', 'Invalid activity cursor.');
      }
    }
    return this.#transaction(async client => {
      const head = await this.#head(client, tenant, taskId);
      if (head === undefined || head.removed) {
        if (after !== undefined) throw new ByokCloudError('activity_history_gap', 'Activity history is unavailable.');
        return undefined;
      }
      await this.#clearExpired(client, head, this.clock.now().toISOString());
      if (after !== undefined && (after.generation !== head.generation || after.revision < Number(head.floor))) {
        throw new ByokCloudError('activity_history_gap', 'Activity cursor is below the retained floor or from another generation.');
      }
      if (after !== undefined && after.revision > Number(head.revision)) throw new ByokCloudError('activity_cursor_invalid', 'Activity cursor is ahead of the log.');
      if (head.expires_at !== null && head.expires_at <= this.clock.now().toISOString()) {
        if (after !== undefined) throw new ByokCloudError('activity_history_gap', 'Activity history expired.');
        return undefined;
      }
      return this.#tail(client, head, after?.revision);
    });
  }

  async collectExpired(tenant: TenantId, input: CollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    return this.#transaction(async client => {
      const heads = (await client.query<Head>(
        `SELECT * FROM activity_log_head WHERE tenant_id = $1 AND expires_at <= $2 AND retained_bytes > 0
         ORDER BY expires_at, task_id LIMIT $3 FOR UPDATE SKIP LOCKED`, [tenant, input.now, input.limit + 1],
      )).rows;
      for (const head of heads.slice(0, input.limit)) await this.#clearExpired(client, head, input.now);
      return { removed: Math.min(heads.length, input.limit), expired: 0, releasedBytes: 0n, more: heads.length > input.limit };
    });
  }
}
