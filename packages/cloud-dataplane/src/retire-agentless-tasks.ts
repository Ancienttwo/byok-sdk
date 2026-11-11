/**
 * One-shot operator command between migrations 0038 and 0039 (#1780).
 *
 * Builds up to v0.30.2 stored task rows without an Agent identity. Each such
 * terminal task is archived through the archive step's own store transaction
 * (bodies become tombstones, object references go), its board item is removed,
 * and its row moves into `task_agentless_retired`, the fence that keeps its id
 * used. A task that is not terminal stops the command before any change: settle
 * it on v0.41.0 first. Safe to run again; a later run finds nothing to retire.
 */
import { taskArchiveInput, type CloudCrypto } from '@byok-sdk/cloud';
import { tenantId, type Clock } from '@byok-sdk/core';
import type { ByokPool } from './pool';
import { assertByokPool } from './pool-brand';
import { PostgresBoardStore } from './stores/core/board';
import { PostgresTaskArchiveStore } from './stores/task-archive';

export interface RetireAgentlessTasksOptions {
  readonly clock: Clock;
  readonly crypto: Pick<CloudCrypto, 'sha256'>;
}

export interface RetireAgentlessTasksResult {
  /** Tasks moved into `task_agentless_retired` by this run, per tenant. */
  readonly retired: Readonly<Record<string, number>>;
}

export async function retireAgentlessTasks(
  pool: ByokPool,
  options: RetireAgentlessTasksOptions,
): Promise<RetireAgentlessTasksResult> {
  assertByokPool(pool, 'retireAgentlessTasks');
  const live = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM task WHERE agent_id IS NULL AND status NOT IN ('complete', 'failed', 'cancelled')`,
  );
  if (live.rows[0]!.n > 0) {
    throw new Error(`${live.rows[0]!.n} task(s) without an Agent identity are not terminal; nothing was changed. ` +
      'Settle them on v0.41.0 with cancelTask, or abandonTask for a task whose device is gone or that stays cancel_requested.');
  }
  const archive = new PostgresTaskArchiveStore(pool, options.clock);
  const board = new PostgresBoardStore(pool, options.clock);
  const retired: Record<string, number> = {};
  for (;;) {
    const batch = await pool.query<{ tenant_id: string; task_id: string; device_id: string; archived_at: Date | null }>(
      `SELECT tenant_id, task_id, device_id, archived_at FROM task WHERE agent_id IS NULL ORDER BY tenant_id, task_id LIMIT 100`,
    );
    if (batch.rows.length === 0) return { retired };
    for (const row of batch.rows) {
      const tenant = tenantId(row.tenant_id);
      const now = options.clock.now().toISOString();
      if (row.archived_at === null) {
        const result = await archive.archive(tenant, await taskArchiveInput(options.crypto, tenant, { taskId: row.task_id, deviceId: row.device_id }, now));
        if (result.outcome === 'refused') {
          throw new Error(`Task ${row.task_id} of tenant ${row.tenant_id} was not archived (${result.reason}); nothing more was changed.`);
        }
      }
      await board.remove(tenant, row.task_id);
      await archive.settle(tenant, row.task_id, now);
      const moved = await pool.query(
        `WITH gone AS (DELETE FROM task WHERE tenant_id = $1 AND task_id = $2 AND agent_id IS NULL RETURNING *)
         INSERT INTO task_agentless_retired SELECT gone.*, now() FROM gone`,
        [row.tenant_id, row.task_id],
      );
      retired[row.tenant_id] = (retired[row.tenant_id] ?? 0) + (moved.rowCount ?? 0);
    }
  }
}
