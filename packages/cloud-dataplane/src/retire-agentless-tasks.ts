/**
 * One-shot operator command between migrations 0038 and 0039 (#1780).
 *
 * Builds up to v0.30.2 stored task rows without an Agent identity. Each such
 * terminal task is archived through the archive step's own store transaction
 * (bodies become tombstones, object references go), its board item is removed,
 * and its row moves into `task_agentless_retired`, the fence that keeps its id
 * used. A task that is not terminal stops the command before any change: settle
 * it on v0.41.0 first. So does one whose offer or cancel delivery is still
 * pending, which the archive refuses: the command bypasses the retention window,
 * so the policy floor that keeps the archive step clear of those rows does not
 * apply. Safe to run again; a later run finds nothing to retire.
 */
import { taskArchiveInput, type CloudCrypto } from '@byok-sdk/cloud';
import { tenantId, type Clock } from '@byok-sdk/core';
import type { ByokPool } from './pool';
import { assertByokPool } from './pool-brand';
import { PostgresBoardStore } from './stores/core/board';
import { PostgresTaskArchiveStore } from './stores/task-archive';
import { refusalFor } from './stores/task-redaction';

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
  // Preflight with the archive's own refusal rule, so no task is retired unless all can be.
  const blocked: Record<string, Partial<Record<'task_not_terminal' | 'pending_delivery', number>>> = {};
  let after: readonly [string, string] = ['', ''];
  for (;;) {
    const page = await pool.query<{ tenant_id: string; task_id: string; device_id: string; owner_device_id: string | null; status: string }>(
      `SELECT tenant_id, task_id, device_id, owner_device_id, status FROM task
        WHERE agent_id IS NULL AND (tenant_id, task_id) > ($1, $2) ORDER BY tenant_id, task_id LIMIT 500`,
      [...after],
    );
    if (page.rows.length === 0) break;
    for (const row of page.rows) {
      const refusal = await refusalFor(pool, tenantId(row.tenant_id), row.task_id, row, false);
      if (refusal?.outcome !== 'refused') continue;
      const tenant = (blocked[row.tenant_id] ??= {});
      tenant[refusal.reason] = (tenant[refusal.reason] ?? 0) + 1;
    }
    const last = page.rows[page.rows.length - 1]!;
    after = [last.tenant_id, last.task_id];
  }
  if (Object.keys(blocked).length > 0) {
    throw new Error(`Tasks without an Agent identity cannot be retired yet; nothing was changed. Per tenant: ${JSON.stringify(blocked)}. ` +
      'On v0.41.0, settle task_not_terminal ones with cancelTask, or abandonTask for a task whose device is gone or that stays cancel_requested; ' +
      'for pending_delivery, bring the device online to receive them, or revokeDevice a device that will not return so its pending rows expire.');
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
