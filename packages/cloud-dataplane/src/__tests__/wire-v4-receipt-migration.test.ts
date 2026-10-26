import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ReceiptMigrationUnmappableError,
  WireV4LegacyTaskListMismatchError,
  wireV3LegacyOfferReceiptKeys,
} from '@byok-sdk/cloud';
import { decodeEnvelope } from '@byok-sdk/protocol';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { migratePostgresToWireV4, preflightPostgresWireV4Migration } from '../wire-v4-receipt-migration';
import { createDataplaneScope, SKIP_DATAPLANE } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const v3Lines = readFileSync(new URL('../../../protocol/src/__tests__/golden/v3.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd().split('\n');
const v3Terminal = v3Lines.find((line) => (JSON.parse(line) as { type: string }).type === 'task.complete')!;
const AGENT = { agentId: 'agent-1', profileRevision: 'rev-1' };
const agentOffer = JSON.stringify({ deviceId: 'device-1', type: 'task.offer_for_agent', payload: { instruction: 'x', agentRef: AGENT } });
const AT = '2026-10-01T00:00:00.000Z';
const LEGACY = { tenantId: 'tenant-a', taskId: 'legacy-1', deviceId: 'device-1', type: 'task.offer' };

/** Every table that holds data of a store-wide snapshot the tests compare. */
const TABLES = [
  'task', 'device_request_receipts', 'outbox', 'approval_timeline_tail', 'activity_tail', 'agent_message_draft',
  'agent_message_admission', 'object_manifest', 'object_reference', 'attested_record',
] as const;

async function snapshot(pool: Pool): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES) out[table] = (await pool.query(`SELECT * FROM ${table} ORDER BY 1, 2, 3`)).rows;
  return out;
}

async function receipt(pool: Pool, tenant: string, key: string, body: string): Promise<void> {
  await pool.query('INSERT INTO device_request_receipts (tenant_id, key, body, recorded_at) VALUES ($1, $2, $3, $4)', [tenant, key, body, AT]);
}

async function task(pool: Pool, tenant: string, taskId: string, agent?: typeof AGENT): Promise<void> {
  await pool.query(
    `INSERT INTO task (tenant_id, task_id, device_id, status, updated_at, agent_id, agent_profile_revision)
     VALUES ($1, $2, 'device-1', 'complete', $3, $4, $5)`,
    [tenant, taskId, AT, agent?.agentId ?? null, agent?.profileRevision ?? null],
  );
}

async function outbox(pool: Pool, tenant: string, seq: number, taskId: string): Promise<void> {
  const body = JSON.stringify({ v: 3, id: `m-${taskId}-${seq}`, ts: AT, type: 'task.cancel', task_id: taskId, seq, payload: {} });
  await pool.query(
    `INSERT INTO outbox (tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at)
     VALUES ($1, 'device-1', $2, $3, $4, $5, $6, 'acked', $7)`,
    [tenant, seq, `m-${taskId}-${seq}`, body, `sha256:${'0'.repeat(64)}`, body.length, AT],
  );
}

/** A legacy task with a row in every table a task can own. */
async function seedLegacyTask(pool: Pool): Promise<void> {
  const { tenantId: tenant, taskId } = LEGACY;
  await task(pool, tenant, taskId);
  const keys = await wireV3LegacyOfferReceiptKeys(tenant, taskId, 'device-1');
  await receipt(pool, tenant, keys.offer, JSON.stringify({ deviceId: 'device-1', type: 'task.offer', payload: { instruction: 'legacy' } }));
  await receipt(pool, tenant, keys.delivered, keys.offer.slice('task-offer:'.length));
  await receipt(pool, tenant, `task:${taskId}:terminal`, v3Terminal.replace('task-golden-1', taskId));
  await outbox(pool, tenant, 1, taskId);
  const tail = (event: object) => JSON.stringify([{ taskId, sourceEnvelopeId: 'e1', revision: 1, receivedAt: AT, event }]);
  await pool.query(
    `INSERT INTO approval_timeline_tail (tenant_id, task_id, entries, next_revision, dropped, capacity, expires_at)
     VALUES ($1, $2, $3, 2, 0, 50, '2999-01-01T00:00:00.000Z')`,
    [tenant, taskId, tail({ type: 'approval_requested', summary: 'no id' })],
  );
  await pool.query(
    "INSERT INTO activity_tail (tenant_id, task_id, entries, dropped, capacity, expires_at) VALUES ($1, $2, '[]', 0, 50, '2999-01-01T00:00:00.000Z')",
    [tenant, taskId],
  );
  await pool.query(
    `INSERT INTO agent_message_draft (tenant_id, task_id, device_id, agent_ref, revision, text, byte_count, state, updated_at, expires_at)
     VALUES ($1, $2, 'device-1', $3, 1, 'draft', 5, 'open', $4, '2999-01-01T00:00:00.000Z')`,
    [tenant, taskId, JSON.stringify(AGENT), AT],
  );
  await pool.query(
    "INSERT INTO agent_message_admission (tenant_id, device_id, task_id, message_id, payload_body) VALUES ($1, 'device-1', $2, 'msg-1', '{}')",
    [tenant, taskId],
  );
  const hash = `sha256:${'b'.repeat(64)}`;
  await pool.query(
    "INSERT INTO object_manifest (tenant_id, hash, byte_size, content_type, state, ref_count, created_at, updated_at) VALUES ($1, $2, 3, 'application/octet-stream', 'committed', 2, $3, $3)",
    [tenant, hash, AT],
  );
  for (const [kind, id] of [['sealed-task', taskId], ['truth', `task.terminal:${taskId}`]]) {
    await pool.query('INSERT INTO object_reference (tenant_id, hash, ref_kind, ref_id, created_at) VALUES ($1, $2, $3, $4, $5)', [tenant, hash, kind, id, AT]);
  }
  await pool.query(
    `INSERT INTO attested_record (tenant_id, kind, subject_id, rev, content_hash, byte_size, body_kind, body_inline, written_at)
     VALUES ($1, 'task.terminal', $2, 1, $3, 2, 'inline', '{}', $4)`,
    [tenant, taskId, hash, AT],
  );
  // A redaction audit receipt holds no wire bytes and is kept.
  await receipt(pool, tenant, `task-redaction:${taskId}`, '{"audit":true}');
}

async function withStore(run: (pool: Pool) => Promise<void>): Promise<void> {
  const scope = await createDataplaneScope(2);
  try {
    await migrate(scope.pool, DEPLOY_SQL);
    await run(scope.pool);
  } finally {
    await scope.dispose();
  }
}

describe.skipIf(SKIP_DATAPLANE)('Postgres wire v3 -> v4 migration (#925)', () => {
  it('deletes every row of a confirmed legacy task and re-encodes the remaining v3 receipts', async () => {
    await withStore(async (pool) => {
      await seedLegacyTask(pool);
      await task(pool, 'tenant-a', 'agent-1', AGENT);
      await receipt(pool, 'tenant-a', 'task:agent-1:terminal', v3Terminal);
      await receipt(pool, 'tenant-b', 'task:agent-1:terminal', v3Terminal);
      await receipt(pool, 'tenant-a', 'task-offer:agent-offer', agentOffer);
      await outbox(pool, 'tenant-a', 2, 'agent-1');

      const preflight = await preflightPostgresWireV4Migration(pool);
      expect(preflight).toEqual({ legacyTasks: [LEGACY], unmappable: [] });
      expect(await migratePostgresToWireV4(pool, preflight.legacyTasks)).toEqual({ migrated: 2, unchanged: 1, deletedTasks: 1 });

      const after = await snapshot(pool);
      expect((after.task as { task_id: string }[]).map((row) => row.task_id)).toEqual(['agent-1']);
      for (const table of ['approval_timeline_tail', 'activity_tail', 'agent_message_draft', 'agent_message_admission', 'object_reference', 'attested_record']) {
        expect(after[table], table).toEqual([]);
      }
      expect((after.object_manifest as { ref_count: number }[])[0]?.ref_count).toBe(0);
      expect((after.outbox as { message_id: string }[]).map((row) => row.message_id)).toEqual(['m-agent-1-2']);
      const receipts = after.device_request_receipts as { tenant_id: string; key: string; body: string }[];
      expect(receipts.map((row) => `${row.tenant_id}/${row.key}`).sort()).toEqual([
        'tenant-a/task-offer:agent-offer', 'tenant-a/task-redaction:legacy-1', 'tenant-a/task:agent-1:terminal', 'tenant-b/task:agent-1:terminal',
      ]);
      for (const row of receipts.filter((r) => r.key.endsWith(':terminal'))) expect(decodeEnvelope(row.body)).toMatchObject({ v: 4 });
      expect(await preflightPostgresWireV4Migration(pool)).toEqual({ legacyTasks: [], unmappable: [] });
      expect(await migratePostgresToWireV4(pool, [])).toEqual({ migrated: 0, unchanged: 3, deletedTasks: 0 });
    });
  });

  it('changes nothing when the confirmed legacy task list differs from the preflight', async () => {
    await withStore(async (pool) => {
      await seedLegacyTask(pool);
      await receipt(pool, 'tenant-a', 'task:agent-1:terminal', v3Terminal);
      const before = await snapshot(pool);
      for (const confirmed of [[], [{ ...LEGACY, deviceId: 'device-2' }], [LEGACY, { ...LEGACY, taskId: 'other' }]]) {
        await expect(migratePostgresToWireV4(pool, confirmed)).rejects.toBeInstanceOf(WireV4LegacyTaskListMismatchError);
      }
      expect(await snapshot(pool)).toEqual(before);
    });
  });

  it('changes nothing and lists every unmappable row, including an approval without an id', async () => {
    await withStore(async (pool) => {
      await seedLegacyTask(pool);
      await task(pool, 'tenant-a', 'agent-1', AGENT);
      await receipt(pool, 'tenant-a', 'task-offer:bad', JSON.stringify({ deviceId: 'device-1', type: 'task.offer_for_agent', payload: { instruction: 'x' } }));
      await pool.query(
        `INSERT INTO approval_timeline_tail (tenant_id, task_id, entries, next_revision, dropped, capacity, expires_at)
         VALUES ('tenant-a', 'agent-1', $1, 2, 0, 50, '2999-01-01T00:00:00.000Z')`,
        [JSON.stringify([{ taskId: 'agent-1', sourceEnvelopeId: 'e1', revision: 1, receivedAt: AT, event: { type: 'approval_requested', summary: 's' } }])],
      );
      const before = await snapshot(pool);

      const preflight = await preflightPostgresWireV4Migration(pool);
      const unmappable = [
        { kind: 'receipt', tenantId: 'tenant-a', key: 'task-offer:bad', receiptKind: 'offer', refusal: 'invalid_under_v4', type: 'task.offer_for_agent' },
        { kind: 'approval', tenantId: 'tenant-a', taskId: 'agent-1', refusal: 'approval_id_missing' },
      ];
      expect(preflight).toEqual({ legacyTasks: [LEGACY], unmappable });
      const failure = await migratePostgresToWireV4(pool, preflight.legacyTasks).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ReceiptMigrationUnmappableError);
      expect((failure as ReceiptMigrationUnmappableError).unmappable).toEqual(unmappable);
      expect(await snapshot(pool)).toEqual(before);
    });
  });
});
