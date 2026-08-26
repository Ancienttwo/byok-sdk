/** U5: real Postgres + MinIO evidence for the package-owned erasure authority. */
import { fileURLToPath } from 'node:url';
import {
  contentHash,
  objectKeyPrefix,
  tenantId,
  tenantObjectKey,
  type Clock,
  type ContentHash,
  type TenantId,
} from '@byok-sdk/core';
import type { BlobObservation } from '@byok-sdk/cloud';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import * as root from '../index';
import { migrate } from '../migrate';
import {
  PostgresTenantErasure,
  TenantErasureError,
  type TenantErasureReadback,
} from '../tenant-erasure';
import {
  R2ObjectMaintenanceStore,
  type R2DeleteResult,
  type R2ObjectMaintenance,
  type R2ObjectPage,
} from '../stores/r2-blobs';
import {
  createDataplaneScope,
  createObjectStorageScope,
  SKIP_DATAPLANE,
} from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT_A = tenantId('tenant-erasure-a');
const TENANT_B = tenantId('tenant-erasure-b');
const HASH_A = contentHash(`sha256:${'a'.repeat(64)}`);
const HASH_B = contentHash(`sha256:${'b'.repeat(64)}`);

class MutableClock implements Clock {
  #instant: Date;

  constructor(iso: string) {
    this.#instant = new Date(iso);
  }

  now(): Date {
    return new Date(this.#instant);
  }

  advance(ms: number): void {
    this.#instant = new Date(this.#instant.getTime() + ms);
  }
}

class DeleteThenFailR2 implements R2ObjectMaintenance {
  #failAfterDelete = true;

  constructor(private readonly inner: R2ObjectMaintenance) {}

  inspectObject(tenant: TenantId, hash: ContentHash): Promise<BlobObservation | undefined> {
    return this.inner.inspectObject(tenant, hash);
  }

  async deleteObject(tenant: TenantId, hash: ContentHash): Promise<R2DeleteResult> {
    const result = await this.inner.deleteObject(tenant, hash);
    if (this.#failAfterDelete) {
      this.#failAfterDelete = false;
      throw new Error('injected response loss after MinIO accepted DELETE');
    }
    return result;
  }

  listTenantObjects(tenant: TenantId, cursor?: string, limit?: number): Promise<R2ObjectPage> {
    return this.inner.listTenantObjects(tenant, cursor, limit);
  }
}

class BlockingR2 implements R2ObjectMaintenance {
  #blockOnce = true;
  #release!: () => void;
  #entered!: () => void;
  readonly entered = new Promise<void>((resolve) => {
    this.#entered = resolve;
  });
  readonly release = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  constructor(private readonly inner: R2ObjectMaintenance) {}

  inspectObject(tenant: TenantId, hash: ContentHash): Promise<BlobObservation | undefined> {
    return this.inner.inspectObject(tenant, hash);
  }

  deleteObject(tenant: TenantId, hash: ContentHash): Promise<R2DeleteResult> {
    return this.inner.deleteObject(tenant, hash);
  }

  async listTenantObjects(tenant: TenantId, cursor?: string, limit?: number): Promise<R2ObjectPage> {
    if (this.#blockOnce) {
      this.#blockOnce = false;
      this.#entered();
      await this.release;
    }
    return this.inner.listTenantObjects(tenant, cursor, limit);
  }

  unblock(): void {
    this.#release();
  }
}

function failOneSqlDelete(pool: Pool): Pool {
  let failed = false;
  return {
    query: async (...args: unknown[]) => {
      const sql = typeof args[0] === 'string' ? args[0] : '';
      if (!failed && sql.includes('WITH deleted AS')) {
        failed = true;
        throw new Error('injected Postgres DELETE failure');
      }
      return (pool.query as (...queryArgs: unknown[]) => Promise<unknown>)(...args);
    },
  } as unknown as Pool;
}

async function plant(
  endpoint: string,
  bucket: string,
  put: (url: string, init: RequestInit) => Promise<Response>,
  tenant: TenantId,
  hash: ContentHash,
  keyPrefix?: string,
): Promise<void> {
  const key = tenantObjectKey(tenant, hash, keyPrefix === undefined ? undefined : objectKeyPrefix(keyPrefix));
  const response = await put(`${endpoint}/${bucket}/${key}`, {
    method: 'PUT',
    body: 'erasure test bytes',
    headers: { 'content-type': 'text/plain' },
  });
  expect(response.status, await response.text()).toBe(200);
}

async function seedEveryTenantTable(pool: Pool, tenant: TenantId, suffix: string, hash: ContentHash): Promise<void> {
  const now = '2026-08-21T00:00:00.000Z';
  const device = `device-${suffix}`;
  await pool.query(
    `INSERT INTO device (
       tenant_id, device_id, product_id, device_name, device_public_key, proof_key_id, proof_key_epoch
     ) VALUES ($1, $2, 'product', 'device', 'public-key', 'identity', 0)`,
    [tenant, device],
  );
  await pool.query(
    `INSERT INTO pairing_code (code, tenant_id, product_id, expires_at)
     VALUES ($1, $2, 'product', $3)`,
    [`pair-${suffix}`, tenant, now],
  );
  await pool.query(`INSERT INTO auth_nonce (tenant_id, device_id, nonce, expires_at) VALUES ($1, $2, 'nonce', $3)`, [tenant, device, now]);
  await pool.query(`INSERT INTO inbound_dedup (tenant_id, device_id, envelope_id) VALUES ($1, $2, 'envelope')`, [tenant, device]);
  await pool.query(
    `INSERT INTO task (tenant_id, task_id, device_id, status, updated_at)
     VALUES ($1, 'task', $2, 'offered', $3)`,
    [tenant, device, now],
  );
  await pool.query(`INSERT INTO device_request_receipts (tenant_id, key, body, recorded_at) VALUES ($1, 'receipt', '{}', $2)`, [tenant, now]);
  await pool.query(`INSERT INTO device_stream (tenant_id, device_id) VALUES ($1, $2)`, [tenant, device]);
  await pool.query(
    `INSERT INTO outbox (tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at)
     VALUES ($1, $2, 1, 'message', '{}', $3, 2, 'pending', $4)`,
    [tenant, device, hash, now],
  );
  await pool.query(`INSERT INTO tenant_stream (tenant_id) VALUES ($1)`, [tenant]);
  await pool.query(
    `INSERT INTO board_item (tenant_id, item_id, channel, title, status, board_seq, created_at, updated_at)
     VALUES ($1, 'item', 'inbox', 'title', 'open', 1, $2, $2)`,
    [tenant, now],
  );
  await pool.query(
    `INSERT INTO attested_record (
       tenant_id, kind, subject_id, rev, content_hash, byte_size, body_kind, body_inline, written_at
     ) VALUES ($1, 'memory', 'subject', 1, $2, 2, 'inline', '{}', $3)`,
    [tenant, hash, now],
  );
  await pool.query(
    `INSERT INTO device_presence (tenant_id, device_id, level, observed_at, expires_at)
     VALUES ($1, $2, 'online', $3, $3)`,
    [tenant, device, now],
  );
  await pool.query(
    `INSERT INTO activity_tail (tenant_id, task_id, entries, dropped, capacity, expires_at)
     VALUES ($1, 'task', '[]'::jsonb, 0, 1, $2)`,
    [tenant, now],
  );
  await pool.query(
    `INSERT INTO object_manifest (tenant_id, hash, byte_size, content_type, state, created_at, updated_at)
     VALUES ($1, $2, 2, 'text/plain', 'committed', $3, $3)`,
    [tenant, hash, now],
  );
  await pool.query(
    `INSERT INTO object_reference (tenant_id, hash, ref_kind, ref_id, created_at)
     VALUES ($1, $2, 'truth', 'subject', $3)`,
    [tenant, hash, now],
  );
  await pool.query(
    `INSERT INTO storage_entitlement (
       tenant_id, version, hard_limit_bytes, max_object_bytes, max_inline_bytes, mailbox_limit_bytes, retention_policy_id
     ) VALUES ($1, 1, 100, 100, 100, 100, 'policy')`,
    [tenant],
  );
  await pool.query(`INSERT INTO storage_usage (tenant_id, updated_at) VALUES ($1, $2)`, [tenant, now]);
  await pool.query(
    `INSERT INTO storage_reservation (
       tenant_id, reservation_id, state, kind, expected_bytes, content_hash, content_type, created_at, expires_at
     ) VALUES ($1, 'reservation', 'reserved', 'object', 2, $2, 'text/plain', $3, $3)`,
    [tenant, hash, now],
  );
  await pool.query(
    `INSERT INTO tenant_retention_policy (
       tenant_id, policy_id, mailbox_acked_retention_ms, mailbox_unacked_retention_ms,
       request_receipt_retention_ms, object_orphan_grace_ms, updated_at
     ) VALUES ($1, 'policy', 0, 0, 0, 0, $2)`,
    [tenant, now],
  );
  await pool.query(
    `INSERT INTO cleanup_job (tenant_id, job_id, kind, state, started_at)
     VALUES ($1, 'cleanup', 'retention', 'completed', $2)`,
    [tenant, now],
  );
  await pool.query(`INSERT INTO gc_cursor (tenant_id, cursor_kind, updated_at) VALUES ($1, 'manifest', $2)`, [tenant, now]);
  await pool.query(
    `INSERT INTO proof_request_receipt (
       tenant_id, device_id, request_id, operation, resource, body_sha256, body_size, response_status, response_body, recorded_at
     ) VALUES ($1, $2, 'request', 'read', 'resource', $3, 2, 200, '{}', $4)`,
    [tenant, device, hash, now],
  );
  await pool.query(
    `INSERT INTO skill_pack (tenant_id, name, version, description, content_hash)
     VALUES ($1, 'pack', '1', 'description', $2)`,
    [tenant, hash],
  );
  await pool.query(
    `INSERT INTO skill_pack_file (tenant_id, pack_name, path, content_hash, byte_size, content)
     VALUES ($1, 'pack', 'README.md', $2, 2, '{}')`,
    [tenant, hash],
  );
  await pool.query(
    `INSERT INTO approval_timeline_tail (tenant_id, task_id, entries, next_revision, dropped, capacity, expires_at)
     VALUES ($1, 'task', '[]'::jsonb, 1, 0, 1, $2)`,
    [tenant, now],
  );
  await pool.query(
    `INSERT INTO device_assertion_replay (
       tenant_id, issuer, product_id, device_id, audience, jti, expires_at
     ) VALUES ($1, 'issuer', 'product', $2, 'audience', 'jti', $3)`,
    [tenant, device, now],
  );
  await pool.query(
    `INSERT INTO agent_egress_event (
       tenant_id, device_id, event_id, agent_id, agent_profile_revision,
       session_ref, policy_revision, cursor, payload_json, content_hash,
       byte_count, receipt_id, recorded_at
     ) VALUES (
       $1, $2, '10000000-0000-4000-8000-000000000001', 'agent', 'profile',
       'session', 'policy', 1, '{}'::jsonb, $3, 0,
       '10000000-0000-4000-8000-000000000002', $4
     )`,
    [tenant, device, hash, now],
  );
  await pool.query(
    `INSERT INTO agent_memory_projection_head (
       tenant_id, agent_id, writer_epoch, source_seq, mutation_id,
       device_id, task_id, agent_profile_revision, session_ref, runtime_id,
       grant_ref, policy_revision, redacted_hash, redacted_snapshot,
       redacted_byte_count, committed_at
     ) VALUES (
       $1, 'agent-memory', 1, 1, '10000000-0000-4000-8000-000000000003',
       $2, 'memory-task', 'memory-profile', 'memory-session', 'codex',
       'memory-grant', 'memory-policy', $3, ''::bytea,
       0, $4
     )`,
    [tenant, device, hash, now],
  );
  await pool.query(
    `INSERT INTO agent_memory_projection_metering_receipt (
       tenant_id, agent_id, writer_epoch, source_seq, mutation_id,
       device_id, task_id, agent_profile_revision, session_ref, runtime_id,
       grant_ref, policy_revision, redacted_hash, redacted_byte_count,
       metering_receipt_id, recorded_at
     ) VALUES (
       $1, 'agent-memory', 1, 1, '10000000-0000-4000-8000-000000000003',
       $2, 'memory-task', 'memory-profile', 'memory-session', 'codex',
       'memory-grant', 'memory-policy', $3, 0,
       '10000000-0000-4000-8000-000000000004', $4
     )`,
    [tenant, device, hash, now],
  );
}

async function eraseToCompletion(
  erasure: PostgresTenantErasure,
  tenant: TenantId,
  operationId: string,
): Promise<TenantErasureReadback> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await erasure.eraseTenant(tenant, operationId);
    if (result.status === 'completed') return result;
    expect(result.status).not.toBe('conflict');
  }
  throw new Error('tenant erasure did not finish within its bounded replay budget');
}

async function expectAllProductRows(pool: Pool, tenant: TenantId, expected: number): Promise<void> {
  for (const table of root.TENANT_ERASURE_TABLES) {
    const result = await pool.query<{ readonly count: bigint }>(
      `SELECT count(*)::bigint AS count FROM ${table} WHERE tenant_id = $1`,
      [tenant],
    );
    expect(result.rows[0]!.count, table).toBe(BigInt(expected));
  }
}

describe.skipIf(SKIP_DATAPLANE)('PostgresTenantErasure [postgres + minio]', () => {
  it('completes and exactly replays an empty tenant receipt', async () => {
    const database = await createDataplaneScope();
    const storage = await createObjectStorageScope();
    const clock = new MutableClock('2026-08-21T00:00:00.000Z');
    try {
      await migrate(database.pool, DEPLOY_SQL);
      const erasure = new PostgresTenantErasure({
        pool: database.pool,
        clock,
        objectStorage: new R2ObjectMaintenanceStore(storage.config),
        maxPagesPerRun: 100,
      });
      const completed = await eraseToCompletion(erasure, TENANT_A, 'empty');
      expect(completed).toMatchObject({
        status: 'completed', r2Complete: true, r2ObjectsDeleted: 0n, sqlRowsDeleted: 0n,
      });
      await expect(erasure.eraseTenant(TENANT_A, 'empty')).resolves.toEqual(completed);
    } finally {
      await database.dispose();
    }
  });

  it('erases every inventory table and canonical/untracked R2 objects, preserves second tenant and replays its receipt', async () => {
    const database = await createDataplaneScope();
    const storage = await createObjectStorageScope();
    const clock = new MutableClock('2026-08-21T00:00:00.000Z');
    try {
      await migrate(database.pool, DEPLOY_SQL);
      await seedEveryTenantTable(database.pool, TENANT_A, 'a', HASH_A);
      await seedEveryTenantTable(database.pool, TENANT_B, 'b', HASH_B);
      await plant(storage.config.endpoint, storage.bucket, storage.client.fetch.bind(storage.client), TENANT_A, HASH_A);
      // No manifest is intentionally written for this object: every canonical
      // object under an owned tenant namespace is erased, not only manifest-backed ones.
      await plant(storage.config.endpoint, storage.bucket, storage.client.fetch.bind(storage.client), TENANT_A, HASH_B);
      await plant(storage.config.endpoint, storage.bucket, storage.client.fetch.bind(storage.client), TENANT_B, HASH_B);

      const erasure = new PostgresTenantErasure({
        pool: database.pool,
        clock,
        objectStorage: new R2ObjectMaintenanceStore(storage.config),
        batchSize: 1,
        maxPagesPerRun: 1,
      });
      const first = await erasure.eraseTenant(TENANT_A, 'erase-a');
      expect(first.status).toBe('outstanding');
      const completed = await eraseToCompletion(erasure, TENANT_A, 'erase-a');
      expect(completed.r2ObjectsDeleted).toBe(2n);
      await expectAllProductRows(database.pool, TENANT_A, 0);
      await expectAllProductRows(database.pool, TENANT_B, 1);
      expect((await new R2ObjectMaintenanceStore(storage.config).listTenantObjects(TENANT_A)).objects).toEqual([]);
      expect((await new R2ObjectMaintenanceStore(storage.config).listTenantObjects(TENANT_B)).objects).toHaveLength(1);

      const replay = await erasure.eraseTenant(TENANT_A, 'erase-a');
      expect(replay).toEqual(completed);
      const receiptRows = await database.pool.query<{ readonly count: bigint }>(
        `SELECT count(*)::bigint AS count FROM tenant_erasure_operation WHERE tenant_id = $1`,
        [TENANT_A],
      );
      expect(receiptRows.rows[0]!.count).toBe(1n);
    } finally {
      await database.dispose();
    }
  }, 15_000);

  it('lists the exact canonical keyPrefix against MinIO', async () => {
    const storage = await createObjectStorageScope();
    const keyPrefix = 'u5/regression';
    try {
      await plant(
        storage.config.endpoint,
        storage.bucket,
        storage.client.fetch.bind(storage.client),
        TENANT_A,
        HASH_A,
        keyPrefix,
      );
      const store = new R2ObjectMaintenanceStore({ ...storage.config, keyPrefix });
      const page = await store.listTenantObjects(TENANT_A, undefined, 1);
      expect(page.objects).toEqual([
        {
          key: `u5/regression/tenants/${TENANT_A}/objects/sha256/${HASH_A.slice('sha256:'.length)}`,
          hash: HASH_A,
          byteSize: 18n,
        },
      ]);
    } finally {
      // Buckets are disposable MinIO test substrate; their tmpfs is reclaimed by compose down.
    }
  });

  it('returns typed conflict for concurrent same/different operation ids and resumes after R2 response loss', async () => {
    const database = await createDataplaneScope();
    const storage = await createObjectStorageScope();
    const clock = new MutableClock('2026-08-21T00:00:00.000Z');
    try {
      await migrate(database.pool, DEPLOY_SQL);
      await seedEveryTenantTable(database.pool, TENANT_A, 'a', HASH_A);
      await seedEveryTenantTable(database.pool, TENANT_B, 'b', HASH_B);
      await plant(storage.config.endpoint, storage.bucket, storage.client.fetch.bind(storage.client), TENANT_A, HASH_A);
      const blocking = new BlockingR2(new R2ObjectMaintenanceStore(storage.config));
      const erasure = new PostgresTenantErasure({
        pool: database.pool,
        clock,
        objectStorage: blocking,
        maxPagesPerRun: 1,
      });
      const first = erasure.eraseTenant(TENANT_A, 'op-one');
      await blocking.entered;
      await expect(erasure.eraseTenant(TENANT_A, 'op-one')).resolves.toMatchObject({
        status: 'conflict', activeOperationId: 'op-one',
      });
      await expect(erasure.eraseTenant(TENANT_A, 'op-two')).resolves.toMatchObject({
        status: 'conflict', activeOperationId: 'op-one',
      });
      blocking.unblock();
      await first;

      const responseLoss = new PostgresTenantErasure({
        pool: database.pool,
        clock,
        objectStorage: new DeleteThenFailR2(new R2ObjectMaintenanceStore(storage.config)),
        maxPagesPerRun: 100,
      });
      await plant(storage.config.endpoint, storage.bucket, storage.client.fetch.bind(storage.client), TENANT_B, HASH_B);
      const partial = await responseLoss.eraseTenant(TENANT_B, 'response-loss');
      expect(partial).toMatchObject({ status: 'partial', errorCode: 'tenant_erasure_storage_failure' });
      await expectAllProductRows(database.pool, TENANT_B, 1);
      const resumed = await eraseToCompletion(responseLoss, TENANT_B, 'response-loss');
      expect(resumed.status).toBe('completed');
      await expectAllProductRows(database.pool, TENANT_B, 0);
    } finally {
      await database.dispose();
    }
  });

  it('records database failure, resumes stale crash lease, and fails closed on tenant-table drift', async () => {
    const database = await createDataplaneScope();
    const storage = await createObjectStorageScope();
    const clock = new MutableClock('2026-08-21T00:00:00.000Z');
    try {
      await migrate(database.pool, DEPLOY_SQL);
      await seedEveryTenantTable(database.pool, TENANT_A, 'a', HASH_A);
      const objectStorage = new R2ObjectMaintenanceStore(storage.config);
      const databaseFault = new PostgresTenantErasure({
        pool: failOneSqlDelete(database.pool),
        clock,
        objectStorage,
        maxPagesPerRun: 100,
      });
      const partial = await databaseFault.eraseTenant(TENANT_A, 'db-failure');
      expect(partial).toMatchObject({ status: 'partial', errorCode: 'tenant_erasure_database_failure' });
      expect(await databaseFault.readTenantErasure(TENANT_A, 'db-failure')).toMatchObject({ status: 'partial' });
      expect((await objectStorage.listTenantObjects(TENANT_A)).objects).toEqual([]);
      await expectAllProductRows(database.pool, TENANT_A, 1);

      await database.pool.query(
        `UPDATE tenant_erasure_operation
            SET lease_token = 'crashed-worker', lease_expires_at = $1, revision = revision + 1
          WHERE tenant_id = $2 AND operation_id = 'db-failure'`,
        [clock.now(), TENANT_A],
      );
      clock.advance(30_001);
      const resumed = await eraseToCompletion(
        new PostgresTenantErasure({ pool: database.pool, clock, objectStorage, maxPagesPerRun: 100 }),
        TENANT_A,
        'db-failure',
      );
      expect(resumed.status).toBe('completed');

      await database.pool.query(`CREATE TABLE future_tenant_state (tenant_id text NOT NULL, value text NOT NULL)`);
      await expect(
        new PostgresTenantErasure({ pool: database.pool, clock, objectStorage }).eraseTenant(TENANT_A, 'db-failure'),
      ).resolves.toEqual(resumed);
      await expect(
        new PostgresTenantErasure({ pool: database.pool, clock, objectStorage }).eraseTenant(TENANT_B, 'drift'),
      ).rejects.toMatchObject({ code: 'tenant_erasure_schema_drift' } satisfies Partial<TenantErasureError>);
      expect(await new PostgresTenantErasure({ pool: database.pool, clock, objectStorage }).readTenantErasure(TENANT_B, 'drift')).toBeUndefined();
    } finally {
      await database.dispose();
    }
  });
});
