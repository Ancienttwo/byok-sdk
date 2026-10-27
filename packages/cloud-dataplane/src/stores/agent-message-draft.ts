import type { Clock, TenantId } from '@byok-sdk/core';
import { DEFAULT_ACTIVITY_TTL_MS, type AgentMessageDraftStore, type AgentMessageDraftApplyInput, type AgentMessageDraftApplyResult, type AgentMessageDraftRow } from '@byok-sdk/cloud';
import type { ByokPool } from '../pool';

type DraftRow = {
  task_id: string; device_id: string; agent_ref: AgentMessageDraftRow['agentRef']; revision: string;
  text: string; byte_count: number; state: AgentMessageDraftRow['state']; updated_at: Date; expires_at: Date;
};
function decode(row: DraftRow): AgentMessageDraftRow {
  return { taskId: row.task_id, deviceId: row.device_id, agentRef: row.agent_ref, revision: Number(row.revision),
    text: JSON.parse(`"${row.text}"`) as string, byteCount: row.byte_count, state: row.state, updatedAt: row.updated_at.toISOString(), expiresAt: row.expires_at.toISOString() };
}

export class PostgresAgentMessageDraftStore implements AgentMessageDraftStore {
  constructor(private readonly pool: ByokPool, private readonly clock: Clock) {}

  async apply(tenant: TenantId, input: AgentMessageDraftApplyInput): Promise<AgentMessageDraftApplyResult> {
    const bytes = new TextEncoder().encode(input.text).byteLength;
    // PostgreSQL text cannot contain NUL. Store one JSON string fragment, with
    // no outer quotes, so SQL concatenation preserves every protocol string.
    // Byte counts always describe the decoded UTF-8 text, not this encoding.
    const text = JSON.stringify(input.text).slice(1, -1);
    const expiresAt = new Date(Date.parse(input.now) + DEFAULT_ACTIVITY_TTL_MS).toISOString();
    // The normal append is one row CAS. It does not take an advisory lock.
    const appended = await this.pool.query(
      `UPDATE agent_message_draft SET text = text || $5, byte_count = byte_count + $6,
         state = $7, updated_at = $8, expires_at = $9
       WHERE tenant_id = $1 AND task_id = $2 AND revision = $3 AND byte_count = $4::bigint
         AND state = 'open' AND expires_at > $8 AND byte_count + $6 <= $10 RETURNING task_id`,
      [tenant, input.taskId, input.revision, input.offset, text, bytes,
        input.overflow ? 'overflow' : 'open', input.now, expiresAt, input.maxBytes],
    );
    if (appended.rowCount) return 'applied';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      let result: AgentMessageDraftApplyResult;
      // A concurrent first insert can win after the absent read. Retry that
      // read under a row lock; never overwrite its revision with stale bytes.
      for (;;) {
        const found = await client.query<DraftRow>(
          'SELECT * FROM agent_message_draft WHERE tenant_id = $1 AND task_id = $2 FOR UPDATE', [tenant, input.taskId]);
        const stored = found.rows[0];
        const row = stored !== undefined && stored.expires_at.getTime() > Date.parse(input.now) ? stored : undefined;
        if (row === undefined || input.revision > Number(row.revision)) {
          if (input.offset !== 0) { result = 'gap'; break; }
          const tooLarge = bytes > input.maxBytes;
          const values = [tenant, input.taskId, input.deviceId, JSON.stringify(input.agentRef), input.revision,
            tooLarge ? '' : text, tooLarge ? 0 : bytes, tooLarge || input.overflow ? 'overflow' : 'open', input.now, expiresAt];
          const replaced = await client.query(
            `INSERT INTO agent_message_draft
             (tenant_id, task_id, device_id, agent_ref, revision, text, byte_count, state, updated_at, expires_at)
             VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (tenant_id, task_id) ${stored === undefined ? 'DO NOTHING' : `DO UPDATE SET
               device_id = EXCLUDED.device_id, agent_ref = EXCLUDED.agent_ref, revision = EXCLUDED.revision,
               text = EXCLUDED.text, byte_count = EXCLUDED.byte_count, state = EXCLUDED.state,
               updated_at = EXCLUDED.updated_at, expires_at = EXCLUDED.expires_at`}
             RETURNING task_id`, values);
          if (!replaced.rowCount) continue;
          result = tooLarge ? 'overflow' : 'applied'; break;
        }
        if (input.revision < Number(row.revision) || input.offset < row.byte_count) { result = 'stale'; break; }
        if (row.state !== 'open') { result = row.state; break; }
        if (input.offset > row.byte_count || row.byte_count + bytes > input.maxBytes) {
          result = input.offset > row.byte_count ? 'gap' : 'overflow';
          await client.query('UPDATE agent_message_draft SET state = $3 WHERE tenant_id = $1 AND task_id = $2', [tenant, input.taskId, result]);
          break;
        }
        // Another frame may have filled the missing prefix before this lock.
        await client.query(`UPDATE agent_message_draft SET text = text || $3, byte_count = byte_count + $4,
          state = $5, updated_at = $6, expires_at = $7 WHERE tenant_id = $1 AND task_id = $2`,
        [tenant, input.taskId, text, bytes, input.overflow ? 'overflow' : 'open', input.now, expiresAt]);
        result = 'applied'; break;
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async read(tenant: TenantId, taskId: string): Promise<AgentMessageDraftRow | undefined> {
    const result = await this.pool.query<DraftRow>(
      'SELECT * FROM agent_message_draft WHERE tenant_id = $1 AND task_id = $2 AND expires_at > $3',
      [tenant, taskId, this.clock.now().toISOString()]);
    return result.rows[0] === undefined ? undefined : decode(result.rows[0]);
  }
  async delete(tenant: TenantId, taskId: string): Promise<void> {
    await this.pool.query('DELETE FROM agent_message_draft WHERE tenant_id = $1 AND task_id = $2', [tenant, taskId]);
  }
  async sweepExpired(now: string): Promise<void> {
    await this.pool.query('DELETE FROM agent_message_draft WHERE expires_at <= $1', [now]);
  }
}
