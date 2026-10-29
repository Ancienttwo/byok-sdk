import type { Clock, TenantId } from '@byok-sdk/core';
import type {
  AgentRef,
  TaskArchiveListInput,
  TaskArchiveStore,
  TaskArchiveStoreInput,
  TaskArchiveStoreResult,
  TaskArchiveWork,
} from '@byok-sdk/cloud';
import type { DatabaseSync } from 'node:sqlite';

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['complete', 'failed', 'cancelled']);
const TERMINAL_SQL = "('complete', 'failed', 'cancelled')";

interface Coordinator {
  run<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
  transaction<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T>;
}

/** Ephemeral rows that this composition keeps in memory, not in the file. Each returns the rows removed. */
export interface InMemoryTaskRows {
  deleteActivity(tenant: TenantId, taskId: string): number;
  deleteAgentMessageDraft(tenant: TenantId, taskId: string): number;
}

interface TaskArchiveRow {
  readonly device_id: string;
  readonly owner_device_id: string | null;
  readonly status: string;
  readonly archived_at: string | null;
}

interface MailboxBodyRow {
  readonly device_id: string;
  readonly seq: number;
  readonly state: string;
  readonly body: string;
}

/**
 * SQLite {@link TaskArchiveStore}. The coordinator serializes every statement
 * on the handle, so the one `BEGIN IMMEDIATE` transaction below is the only
 * writer while the codec's async tombstones are computed inside it.
 */
export class SqliteTaskArchiveStore implements TaskArchiveStore {
  constructor(
    private readonly coordinator: Coordinator,
    private readonly clock: Clock,
    private readonly ephemeral: InMemoryTaskRows,
  ) {}

  listWork(tenant: TenantId, input: TaskArchiveListInput): Promise<readonly TaskArchiveWork[]> {
    return this.coordinator.run((db) => {
      type Row = { task_id: string; device_id: string; agent_ref_json: string | null };
      const work = (row: Row, phase: TaskArchiveWork['phase']): TaskArchiveWork => ({
        taskId: row.task_id,
        deviceId: row.device_id,
        ...(row.agent_ref_json === null ? {} : { agentRef: JSON.parse(row.agent_ref_json) as AgentRef }),
        phase,
      });
      const settle = db.prepare(
        `SELECT task_id, device_id, agent_ref_json FROM task_attempt
          WHERE tenant_id = ? AND archived_at IS NOT NULL AND archive_settled_at IS NULL
          ORDER BY task_id COLLATE BINARY LIMIT ?`,
      ).all(tenant, input.limit) as unknown as Row[];
      const archive = settle.length >= input.limit ? [] : db.prepare(
        `SELECT task_id, device_id, agent_ref_json FROM task_attempt
          WHERE tenant_id = ? AND status IN ${TERMINAL_SQL} AND archived_at IS NULL
            AND archive_after IS NOT NULL AND archive_after < ?
          ORDER BY archive_after, task_id COLLATE BINARY LIMIT ?`,
      ).all(tenant, input.archiveBefore, input.limit - settle.length) as unknown as Row[];
      return [...settle.map((row) => work(row, 'settle')), ...archive.map((row) => work(row, 'archive'))];
    });
  }

  archive(tenant: TenantId, input: TaskArchiveStoreInput): Promise<TaskArchiveStoreResult> {
    return this.coordinator.transaction(async (db): Promise<TaskArchiveStoreResult> => {
      const { taskId, codec } = input;
      const task = db.prepare(
        'SELECT device_id, owner_device_id, status, archived_at FROM task_attempt WHERE tenant_id = ? AND task_id = ?',
      ).get(tenant, taskId) as TaskArchiveRow | undefined;
      if (task === undefined) return { outcome: 'not_found' };
      if (task.archived_at !== null) return { outcome: 'already_archived' };
      if (!TERMINAL_STATUSES.has(task.status)) return { outcome: 'refused', reason: 'task_not_terminal' };
      const mailbox = readMailbox(db, tenant, taskId, task);
      if (mailbox.some((row) => row.state === 'pending')) return { outcome: 'refused', reason: 'pending_delivery' };

      // Fence an absent terminal key first, so a device terminal that arrives
      // after the archive finds it and stores nothing.
      db.prepare(
        `INSERT INTO request_receipt (tenant_id, key, body, recorded_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id, key) DO NOTHING`,
      ).run(tenant, input.terminalReceiptKey, codec.absent, this.clock.now().toISOString());
      let receiptsRedacted = 0;
      for (const key of input.receiptKeys) {
        const row = db.prepare('SELECT body FROM request_receipt WHERE tenant_id = ? AND key = ?').get(tenant, key) as
          | { body: string }
          | undefined;
        if (row === undefined || codec.isTombstone(row.body)) continue;
        db.prepare('UPDATE request_receipt SET body = ? WHERE tenant_id = ? AND key = ?')
          .run((await codec.tombstone(row.body)).body, tenant, key);
        receiptsRedacted += 1;
      }

      let admissionsRedacted = 0;
      const admission = db.prepare(
        'SELECT payload_body, terminal_body FROM agent_message_admission WHERE tenant_id = ? AND task_id = ?',
      ).get(tenant, taskId) as { payload_body: string; terminal_body: string | null } | undefined;
      if (admission !== undefined) {
        const payload = codec.isTombstone(admission.payload_body) ? undefined : (await codec.tombstone(admission.payload_body)).body;
        const terminal = admission.terminal_body === null || codec.isTombstone(admission.terminal_body)
          ? undefined
          : (await codec.tombstone(admission.terminal_body)).body;
        if (payload !== undefined || terminal !== undefined) {
          db.prepare(
            `UPDATE agent_message_admission SET payload_body = COALESCE(?, payload_body), terminal_body = COALESCE(?, terminal_body)
              WHERE tenant_id = ? AND task_id = ?`,
          ).run(payload ?? null, terminal ?? null, tenant, taskId);
          admissionsRedacted += 1;
        }
      }

      // A mailbox row is never deleted: a device's highest-seq expired row is the recovery floor (#1115).
      for (const row of mailbox) {
        const tombstone = await codec.tombstone(row.body);
        db.prepare('UPDATE mailbox_message SET body = ?, body_hash = ?, byte_size = ? WHERE tenant_id = ? AND device_id = ? AND seq = ?')
          .run(tombstone.body, tombstone.bodyHash, String(tombstone.byteSize), tenant, row.device_id, row.seq);
      }

      let ephemeralRowsDeleted = Number(
        db.prepare('DELETE FROM approval_timeline_tail WHERE tenant_id = ? AND task_id = ?').run(tenant, taskId).changes,
      );
      ephemeralRowsDeleted += this.ephemeral.deleteActivity(tenant, taskId) + this.ephemeral.deleteAgentMessageDraft(tenant, taskId);

      let referencesReleased = 0;
      for (const { refKind, refId } of input.releaseObjectReferences) {
        const held = db.prepare('SELECT hash FROM object_reference WHERE tenant_id = ? AND ref_kind = ? AND ref_id = ?')
          .all(tenant, refKind, refId) as unknown as { hash: string }[];
        for (const { hash } of held) {
          db.prepare('DELETE FROM object_reference WHERE tenant_id = ? AND hash = ? AND ref_kind = ? AND ref_id = ?')
            .run(tenant, hash, refKind, refId);
          db.prepare('UPDATE object_manifest SET updated_at = ? WHERE tenant_id = ? AND hash = ?')
            .run(this.clock.now().toISOString(), tenant, hash);
          referencesReleased += 1;
        }
      }

      db.prepare(
        `UPDATE task_attempt SET terminal_cause = NULL, cancellation_reason = NULL, archived_at = ?
          WHERE tenant_id = ? AND task_id = ?`,
      ).run(input.archivedAt, tenant, taskId);
      return {
        outcome: 'archived',
        counts: { receiptsRedacted, admissionsRedacted, outboxRedacted: mailbox.length, ephemeralRowsDeleted, referencesReleased },
      };
    });
  }

  settle(tenant: TenantId, taskId: string, settledAt: string): Promise<void> {
    return this.coordinator.run((db) => {
      db.prepare(
        `UPDATE task_attempt SET archive_settled_at = ?
          WHERE tenant_id = ? AND task_id = ? AND archived_at IS NOT NULL AND archive_settled_at IS NULL`,
      ).run(settledAt, tenant, taskId);
    });
  }
}

/**
 * The task's mailbox rows on its target and owner devices. An envelope names
 * its task in a top-level `task_id`; the text filter narrows the scan and the
 * parse confirms each match. A tombstone has none, so a redacted row is not
 * read again.
 */
function readMailbox(db: DatabaseSync, tenant: TenantId, taskId: string, task: TaskArchiveRow): readonly MailboxBodyRow[] {
  const devices = task.owner_device_id === null || task.owner_device_id === task.device_id
    ? [task.device_id]
    : [task.device_id, task.owner_device_id];
  const rows = db.prepare(
    `SELECT device_id, seq, state, body FROM mailbox_message
      WHERE tenant_id = ? AND device_id IN (${devices.map(() => '?').join(', ')}) AND instr(body, ?) > 0
      ORDER BY device_id, seq`,
  ).all(tenant, ...devices, `"task_id":${JSON.stringify(taskId)}`) as unknown as MailboxBodyRow[];
  return rows.filter((row) => envelopeTaskId(row.body) === taskId);
}

function envelopeTaskId(body: string): unknown {
  try {
    const value = JSON.parse(body) as unknown;
    return value !== null && typeof value === 'object' ? (value as { readonly task_id?: unknown }).task_id : undefined;
  } catch {
    return undefined;
  }
}
