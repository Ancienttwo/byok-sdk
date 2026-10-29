/**
 * Postgres authority for the terminal-task archive step (#1120).
 *
 * `archive` is one transaction that holds the task row lock: the same body
 * rewrite as redaction (`rewriteTaskBodies`), the task's object references
 * removed, and `archived_at` set. Nothing is deleted from the mailbox, so each
 * device's recovery-floor dead letter stays (#1115), and no object is deleted
 * here: orphan GC reclaims an object once nothing references it. With the
 * references gone in the same commit as the tombstones, a live task never has
 * its objects collected.
 */
import type { Clock, TenantId } from '@byok-sdk/core';
import type {
  TaskArchiveListInput,
  TaskArchiveStore,
  TaskArchiveStoreInput,
  TaskArchiveStoreResult,
  TaskArchiveWork,
} from '@byok-sdk/cloud';
import type { Pool } from 'pg';
import type { ByokPool } from '../pool';
import { assertByokPool } from '../pool-brand';
import { BEGIN_OUTBOX_WRITE } from './core/outbox-writer';
import { readTask, refusalFor, rewriteTaskBodies, type Querier } from './task-redaction';

interface WorkRow {
  readonly task_id: string;
  readonly device_id: string;
  readonly agent_id: string | null;
  readonly agent_profile_revision: string | null;
  readonly phase: 'archive' | 'settle';
}

export class PostgresTaskArchiveStore implements TaskArchiveStore {
  readonly #pool: Pool;

  constructor(pool: ByokPool, private readonly clock: Clock) {
    assertByokPool(pool, 'PostgresTaskArchiveStore');
    this.#pool = pool;
  }

  async listWork(tenant: TenantId, input: TaskArchiveListInput): Promise<readonly TaskArchiveWork[]> {
    const result = await this.#pool.query<WorkRow>(
      `(SELECT task_id, device_id, agent_id, agent_profile_revision, 'settle' AS phase FROM task
         WHERE tenant_id = $1 AND archived_at IS NOT NULL AND archive_settled_at IS NULL
         ORDER BY task_id LIMIT $3)
       UNION ALL
       (SELECT task_id, device_id, agent_id, agent_profile_revision, 'archive' AS phase FROM task
         WHERE tenant_id = $1 AND archived_at IS NULL AND archive_after IS NOT NULL AND archive_after < $2
           AND status IN ('complete', 'failed', 'cancelled')
         ORDER BY archive_after, task_id LIMIT $3)`,
      [tenant, input.archiveBefore, input.limit],
    );
    // Settling first finishes interrupted archives before starting new ones.
    return result.rows.slice(0, input.limit).map((row) => ({
      taskId: row.task_id,
      deviceId: row.device_id,
      ...(row.agent_id === null || row.agent_profile_revision === null
        ? {}
        : { agentRef: { agentId: row.agent_id, profileRevision: row.agent_profile_revision } }),
      phase: row.phase,
    }));
  }

  async archive(tenant: TenantId, input: TaskArchiveStoreInput): Promise<TaskArchiveStoreResult> {
    const { taskId, codec } = input;
    const client = await this.#pool.connect();
    try {
      await client.query(BEGIN_OUTBOX_WRITE);
      const task = await readTask(client, tenant, taskId, true);
      if (task === undefined) {
        await client.query('ROLLBACK');
        return { outcome: 'not_found' };
      }
      const archived = await client.query('SELECT 1 FROM task WHERE tenant_id = $1 AND task_id = $2 AND archived_at IS NOT NULL', [tenant, taskId]);
      if (archived.rowCount === 1) {
        await client.query('ROLLBACK');
        return { outcome: 'already_archived' };
      }
      const refusal = await refusalFor(client, tenant, taskId, task, true);
      if (refusal !== undefined) {
        await client.query('ROLLBACK');
        return { outcome: 'refused', reason: refusal.outcome === 'refused' ? refusal.reason : 'task_not_terminal' };
      }
      const rewritten = await rewriteTaskBodies(client, {
        tenant, taskId, task, codec, receiptKeys: input.receiptKeys, terminalReceiptKey: input.terminalReceiptKey, now: this.clock.now(),
      });
      const referencesReleased = await releaseReferences(client, tenant, input.releaseObjectReferences, input.archivedAt);
      await client.query('UPDATE task SET archived_at = $3 WHERE tenant_id = $1 AND task_id = $2', [tenant, taskId, input.archivedAt]);
      await client.query('COMMIT');
      return {
        outcome: 'archived',
        counts: {
          receiptsRedacted: rewritten.receiptsRedacted,
          admissionsRedacted: rewritten.admissionsRedacted,
          outboxRedacted: rewritten.outboxRedacted,
          ephemeralRowsDeleted: rewritten.ephemeralRowsDeleted,
          referencesReleased,
        },
      };
    } catch (cause) {
      await client.query('ROLLBACK').catch(() => {});
      throw cause;
    } finally {
      client.release();
    }
  }

  async settle(tenant: TenantId, taskId: string, settledAt: string): Promise<void> {
    await this.#pool.query(
      `UPDATE task SET archive_settled_at = $3
        WHERE tenant_id = $1 AND task_id = $2 AND archived_at IS NOT NULL AND archive_settled_at IS NULL`,
      [tenant, taskId, settledAt],
    );
  }
}

/** Inside the archive transaction, after the task row lock: manifest row, then reference, as `addReference` orders them. */
async function releaseReferences(
  client: Querier,
  tenant: TenantId,
  releases: TaskArchiveStoreInput['releaseObjectReferences'],
  now: string,
): Promise<number> {
  let released = 0;
  for (const { refKind, refId } of releases) {
    const held = await client.query<{ hash: string }>(
      'SELECT hash FROM object_reference WHERE tenant_id = $1 AND ref_kind = $2 AND ref_id = $3 ORDER BY hash',
      [tenant, refKind, refId],
    );
    for (const { hash } of held.rows) {
      await client.query('SELECT 1 FROM object_manifest WHERE tenant_id = $1 AND hash = $2 FOR UPDATE', [tenant, hash]);
      const deleted = await client.query(
        'DELETE FROM object_reference WHERE tenant_id = $1 AND hash = $2 AND ref_kind = $3 AND ref_id = $4',
        [tenant, hash, refKind, refId],
      );
      await client.query(
        `UPDATE object_manifest SET ref_count = (SELECT count(*) FROM object_reference r WHERE r.tenant_id = $1 AND r.hash = $2),
                updated_at = $3
          WHERE tenant_id = $1 AND hash = $2`,
        [tenant, hash, now],
      );
      released += deleted.rowCount ?? 0;
    }
  }
  return released;
}
