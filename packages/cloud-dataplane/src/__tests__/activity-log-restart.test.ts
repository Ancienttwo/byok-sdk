import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { activityEntryBytes, activitySourceHash, createActivityEntry, MAX_ACTIVITY_BYTES, type ActivityAppendInput, type ActivityTail } from '@byok-sdk/cloud';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate';
import { PostgresActivityStore } from '../stores/activity';
import { createDataplaneScope, SKIP_DATAPLANE } from './support/dataplane';

const SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('activity-durable');
const input = (id: number): ActivityAppendInput => ({ taskId: 'task', sourceEnvelopeId: `e-${id}`, batchSeq: id, events: [{ type: 'progress', text: `${id}` }], dropped: 0, ttlMs: 600_000 });
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));

describe.skipIf(SKIP_DATAPLANE)('Postgres activity persistence and transactions', () => {
  let scope: Awaited<ReturnType<typeof createDataplaneScope>>;
  beforeAll(async () => {
    scope = await createDataplaneScope(8);
    await migrate(scope.pool, SQL);
  });
  // Reuse only the schema; every case starts without payloads or identity fences.
  beforeEach(async () => { await scope.pool.query('TRUNCATE activity_log_entry, activity_log_head'); });
  afterAll(async () => { await scope?.dispose(); });

  it('resumes from a separate Node process after the writer exits and ten minutes of inactivity', async () => {
    const run = (operation: 'write' | 'read', after?: ActivityTail['cursor']): ActivityTail => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { readFileSync } from 'node:fs';
      import { createByokPool, PostgresActivityStore } from './dist/index.js';
      import { createMutableClock, tenantId } from '@byok-sdk/core';
      const data = JSON.parse(readFileSync(0, 'utf8'));
      const pool = createByokPool({ connectionString: data.connectionString });
      try {
        const clock = createMutableClock(new Date('2026-10-30T00:00:00.000Z'));
        if (data.operation === 'read') clock.advance(700000);
        const store = new PostgresActivityStore(pool, clock);
        const tenant = tenantId('activity-durable');
        if (data.operation === 'write') {
          await store.append(tenant, { taskId: 'task', sourceEnvelopeId: 'e-1', batchSeq: 1, events: [{ type: 'progress', text: 'persisted' }], dropped: 0, ttlMs: 600000 });
          await store.append(tenant, { taskId: 'task', sourceEnvelopeId: 'e-2', batchSeq: 2, events: [{ type: 'turn_end' }], dropped: 0, ttlMs: 600000 });
        }
        process.stdout.write(JSON.stringify(await store.read(tenant, 'task', data.after ? { after: data.after } : {})));
      } finally { await pool.end(); }
    `], { cwd: packageRoot, input: JSON.stringify({ connectionString: scope.connectionString, operation, after }), encoding: 'utf8', timeout: 10_000 }));
    const written = run('write');
    const resumed = run('read', { ...written.cursor, revision: 1 });
    expect(resumed.cursor).toEqual(written.cursor);
    expect(resumed.entries).toEqual([written.entries[1]]);
    expect(resumed.expiresAt).toBeUndefined();
  });

  it('rolls back an oversized first insert and preserves existing history on rejection', async () => {
    const clock = createMutableClock();
    const store = new PostgresActivityStore(scope.pool, clock);
    const base = input(1);
    const overhead = activityEntryBytes(createActivityEntry(base, 1, clock.now().toISOString()));
    const exact = { ...base, events: [{ type: 'progress', text: 'x'.repeat(MAX_ACTIVITY_BYTES - overhead + 1) }] };
    const over = { ...exact, events: [{ type: 'progress', text: 'x'.repeat(MAX_ACTIVITY_BYTES - overhead + 2) }] };
    await expect(store.append(TENANT, over)).rejects.toMatchObject({ code: 'activity_batch_too_large' });
    expect((await scope.pool.query('SELECT count(*) FROM activity_log_head')).rows[0].count).toBe(0n);
    const tail = await store.append(TENANT, exact);
    expect(tail.retainedBytes).toBe(MAX_ACTIVITY_BYTES);
    await expect(store.append(TENANT, { ...over, sourceEnvelopeId: 'e-2' })).rejects.toMatchObject({ code: 'activity_batch_too_large' });
    expect(await store.read(TENANT, 'task')).toEqual(tail);
  });

  it('serializes same-source races and preserves fences through expiry and pool restart', async () => {
    const second = scope.openRestartPool(8);
    try {
      const clock = createMutableClock();
      const a = new PostgresActivityStore(scope.pool, clock);
      const b = new PostgresActivityStore(second, clock);
      const results = await Promise.all(Array.from({ length: 30 }, (_, n) => (n % 2 ? a : b).append(TENANT, input(1))));
      expect(results.every(tail => tail.cursor.revision === 1)).toBe(true);
      const settled = await a.settle(TENANT, 'task', clock.now().toISOString());
      clock.advance(600_000);
      expect(await b.collectExpired(TENANT, { now: clock.now().toISOString(), limit: 1 })).toMatchObject({ removed: 1, more: false });
      const fence = await scope.pool.query('SELECT source_hash, body, byte_size FROM activity_log_entry');
      expect(fence.rows).toEqual([{ source_hash: expect.stringMatching(/^[a-f0-9]{64}$/), body: null, byte_size: 0 }]);
      await expect(b.read(TENANT, 'task', { after: settled.cursor })).rejects.toMatchObject({ code: 'activity_history_gap' });
      expect((await b.append(TENANT, input(1))).cursor).toEqual(settled.cursor);
      await expect(b.append(TENANT, { ...input(1), dropped: 1 })).rejects.toMatchObject({ code: 'coordination_input_invalid' });
      await expect(b.append(TENANT, input(2))).rejects.toMatchObject({ code: 'activity_task_settled' });
    } finally { await second.end(); }
  });

  it('prunes to 1000 payloads while keeping the evicted identity fence', async () => {
    const clock = createMutableClock();
    const store = new PostgresActivityStore(scope.pool, clock);
    // Seed the boundary in one database write; the separate burst test exercises concurrent admission.
    const rows = await Promise.all(Array.from({ length: 1000 }, async (_, n) => {
      const body = createActivityEntry(input(n), n + 1, clock.now().toISOString());
      return { revision: n + 1, source: input(n).sourceEnvelopeId, hash: await activitySourceHash(input(n)), body, bytes: activityEntryBytes(body) };
    }));
    await scope.pool.query('INSERT INTO activity_log_head (tenant_id, task_id, revision, retained_bytes) VALUES ($1, $2, 1000, $3)', [TENANT, 'task', rows.reduce((sum, row) => sum + row.bytes, 0)]);
    await scope.pool.query(
      `INSERT INTO activity_log_entry (tenant_id, task_id, revision, source_envelope_id, source_hash, body, byte_size)
       SELECT $1, $2, revision, source, hash, body, bytes FROM jsonb_to_recordset($3::jsonb)
       AS row(revision bigint, source text, hash text, body jsonb, bytes integer)`, [TENANT, 'task', JSON.stringify(rows)],
    );
    await store.append(TENANT, input(1000));
    const tail = (await store.read(TENANT, 'task'))!;
    expect(tail).toMatchObject({ dropped: 1, floor: 1, cursor: { revision: 1001 } });
    expect(tail.entries).toHaveLength(1000);
    expect(await store.append(TENANT, input(0))).toEqual(tail);
    expect((await scope.pool.query('SELECT count(*) FROM activity_log_entry')).rows[0].count).toBe(1001n);
  });
});
