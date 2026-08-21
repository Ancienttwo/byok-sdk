/**
 * Package-owned, resumable tenant erasure for the Node maintenance surface.
 *
 * Cleanup's policy/cursor/accounting lifecycle is intentionally not reused.
 * Here the durable operation receipt is the authority: it records the opaque
 * R2 cursor before any SQL is touched, carries a short CAS lease while one
 * caller advances bounded work, and survives every product-data deletion.
 */
import { randomUUID } from 'node:crypto';
import { tenantId, type Clock, type TenantId } from '@byok-sdk/core';
import type { Pool } from 'pg';
import {
  R2ObjectMaintenanceStore,
  type R2BlobStoreOptions,
  type R2ObjectMaintenance,
} from './stores/r2-blobs';

const DEFAULT_BATCH_SIZE = 100;
const DEFAULT_MAX_PAGES_PER_RUN = 10;
const DEFAULT_LEASE_MS = 30_000;
const MAX_BATCH_SIZE = 1_000;
const MAX_PAGES_PER_RUN = 100;
const MAX_LEASE_MS = 5 * 60_000;

/** Every tenant-owned table as of 0010, in child-before-parent deletion order. */
export const TENANT_ERASURE_TABLES = [
  'object_reference',
  'object_manifest',
  'storage_reservation',
  'storage_usage',
  'storage_entitlement',
  'gc_cursor',
  'cleanup_job',
  'tenant_retention_policy',
  'skill_pack_file',
  'skill_pack',
  'approval_timeline_tail',
  'activity_tail',
  'attested_record',
  'board_item',
  'tenant_stream',
  'outbox',
  'device_request_receipts',
  'proof_request_receipt',
  'task',
  'device_presence',
  'device_assertion_replay',
  'device_stream',
  'inbound_dedup',
  'auth_nonce',
  'pairing_code',
  'device',
] as const;

const TENANT_ERASURE_TABLE_SET = new Set<string>(TENANT_ERASURE_TABLES);

export const TENANT_ERASURE_ERROR_CODES = {
  tenant_erasure_invalid_input: 'tenant_erasure_invalid_input',
  tenant_erasure_schema_drift: 'tenant_erasure_schema_drift',
  tenant_erasure_object_key_invalid: 'tenant_erasure_object_key_invalid',
  tenant_erasure_storage_failure: 'tenant_erasure_storage_failure',
  tenant_erasure_database_failure: 'tenant_erasure_database_failure',
  tenant_erasure_cas_lost: 'tenant_erasure_cas_lost',
} as const;

export type TenantErasureErrorCode =
  (typeof TENANT_ERASURE_ERROR_CODES)[keyof typeof TENANT_ERASURE_ERROR_CODES];

export class TenantErasureError extends Error {
  readonly code: TenantErasureErrorCode;

  constructor(code: TenantErasureErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'TenantErasureError';
    this.code = code;
  }
}

export type TenantErasureStatus = 'outstanding' | 'partial' | 'completed';

export interface TenantErasureReadback {
  readonly status: TenantErasureStatus;
  readonly tenantId: TenantId;
  readonly operationId: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly completedAt?: string;
  readonly r2Complete: boolean;
  readonly sqlTableIndex: number;
  readonly r2ObjectsDeleted: bigint;
  readonly sqlRowsDeleted: bigint;
  /** A closed, audit-safe class. Remote messages and object names are never retained. */
  readonly errorCode?: TenantErasureErrorCode;
}

export interface TenantErasureConflict {
  readonly status: 'conflict';
  readonly tenantId: TenantId;
  readonly operationId: string;
  readonly activeOperationId: string;
}

export type TenantErasureResult = TenantErasureReadback | TenantErasureConflict;

export interface PostgresTenantErasureOptions {
  /** A Node direct-DSN pool. The host owns pool lifetime and write quiescence. */
  readonly pool: Pool;
  readonly clock: Clock;
  readonly objectStorage: R2ObjectMaintenance;
  /** ListObjectsV2 and one SQL DELETE use this bound; valid range is 1..1000. */
  readonly batchSize?: number;
  /** Maximum R2/SQL pages one operator invocation may advance; valid range is 1..100. */
  readonly maxPagesPerRun?: number;
  /** Crash-recovery lease; a retry may take an expired lease using the operation CAS. */
  readonly leaseMs?: number;
}

export interface PostgresTenantErasureCompositionOptions {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly objectStorage: Omit<R2BlobStoreOptions, 'objects'>;
  readonly batchSize?: number;
  readonly maxPagesPerRun?: number;
  readonly leaseMs?: number;
}

interface OperationRow {
  readonly tenant_id: string;
  readonly operation_id: string;
  readonly state: 'running' | 'completed';
  readonly revision: bigint;
  readonly lease_token: string | null;
  readonly lease_expires_at: Date | null;
  readonly r2_cursor: string | null;
  readonly r2_complete: boolean;
  readonly sql_table_index: number;
  readonly r2_objects_deleted: bigint;
  readonly sql_rows_deleted: bigint;
  readonly started_at: Date;
  readonly updated_at: Date;
  readonly completed_at: Date | null;
  readonly last_error_code: string | null;
}

const OPERATION_COLUMNS = [
  'tenant_id',
  'operation_id',
  'state',
  'revision',
  'lease_token',
  'lease_expires_at',
  'r2_cursor',
  'r2_complete',
  'sql_table_index',
  'r2_objects_deleted',
  'sql_rows_deleted',
  'started_at',
  'updated_at',
  'completed_at',
  'last_error_code',
].join(', ');

/**
 * The Node-only erasure authority. It has no raw-table or raw-key API: the
 * static inventory and canonical R2 adapter are the only deletion authority.
 */
export class PostgresTenantErasure {
  readonly #pool: Pool;
  readonly #clock: Clock;
  readonly #objectStorage: R2ObjectMaintenance;
  readonly #batchSize: number;
  readonly #maxPagesPerRun: number;
  readonly #leaseMs: number;

  constructor(options: PostgresTenantErasureOptions) {
    this.#pool = options.pool;
    this.#clock = options.clock;
    this.#objectStorage = options.objectStorage;
    this.#batchSize = assertBoundedWhole(options.batchSize ?? DEFAULT_BATCH_SIZE, 'batchSize', MAX_BATCH_SIZE);
    this.#maxPagesPerRun = assertBoundedWhole(
      options.maxPagesPerRun ?? DEFAULT_MAX_PAGES_PER_RUN,
      'maxPagesPerRun',
      MAX_PAGES_PER_RUN,
    );
    this.#leaseMs = assertBoundedWhole(options.leaseMs ?? DEFAULT_LEASE_MS, 'leaseMs', MAX_LEASE_MS);
  }

  /** Read a durable operation receipt without advancing it. */
  async readTenantErasure(tenant: TenantId, operationId: string): Promise<TenantErasureReadback | undefined> {
    assertOperationId(operationId);
    const row = await this.#readOperation(tenant, operationId);
    return row === undefined ? undefined : toReadback(row);
  }

  /**
   * Advance one bounded operation slice. Calls with a completed id replay its
   * receipt; another running id for the same tenant gets a typed conflict.
   */
  async eraseTenant(tenant: TenantId, operationId: string): Promise<TenantErasureResult> {
    assertOperationId(operationId);
    await this.#assertSchemaInventory();

    let row: OperationRow;
    try {
      const opened = await this.#openOperation(tenant, operationId);
      if ('status' in opened) return opened;
      row = opened;
    } catch (cause) {
      throw databaseFailure('opening tenant erasure operation', cause);
    }

    if (row.state === 'completed') return toReadback(row);

    const leaseToken = randomUUID();
    let claimed: OperationRow | undefined;
    try {
      claimed = await this.#claim(tenant, operationId, row.revision, leaseToken);
      if (claimed === undefined) return await this.#readConflictOrReceipt(tenant, operationId);

      for (let page = 0; page < this.#maxPagesPerRun; page += 1) {
        if (!claimed.r2_complete) {
          claimed = await this.#eraseR2Page(tenant, claimed, leaseToken);
          continue;
        }
        if (claimed.sql_table_index < TENANT_ERASURE_TABLES.length) {
          claimed = await this.#eraseSqlPage(tenant, claimed, leaseToken);
          continue;
        }
        claimed = await this.#verifyAndComplete(tenant, claimed, leaseToken);
        if (claimed.state === 'completed') return toReadback(claimed);
      }

      return toReadback(await this.#release(tenant, operationId, claimed.revision, leaseToken));
    } catch (cause) {
      if (claimed === undefined) throw databaseFailure('claiming tenant erasure operation', cause);
      const code = cause instanceof TenantErasureError
        ? cause.code
        : TENANT_ERASURE_ERROR_CODES.tenant_erasure_database_failure;
      try {
        return toReadback(await this.#recordPartial(tenant, operationId, claimed.revision, leaseToken, code));
      } catch (recordCause) {
        throw databaseFailure('recording tenant erasure partial outcome', recordCause);
      }
    }
  }

  async #assertSchemaInventory(): Promise<void> {
    const found = await this.#pool.query<{ readonly relname: string }>(
      `SELECT t.relname
         FROM pg_class t
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = current_schema()
          AND t.relkind = 'r'
          AND t.relname NOT IN ('byok_schema_migration', 'tenant_erasure_operation')
        ORDER BY t.relname`,
    );
    const actual = new Set(found.rows.map((row) => row.relname));
    const missing = TENANT_ERASURE_TABLES.filter((name) => !actual.has(name));
    const unexpected = [...actual].filter((name) => !TENANT_ERASURE_TABLE_SET.has(name));
    if (missing.length === 0 && unexpected.length === 0 && actual.size === TENANT_ERASURE_TABLES.length) return;
    throw new TenantErasureError(
      'tenant_erasure_schema_drift',
      `Tenant erasure inventory drift: missing=[${missing.join(',')}], unexpected=[${unexpected.join(',')}].`,
    );
  }

  async #openOperation(
    tenant: TenantId,
    operationId: string,
  ): Promise<OperationRow | TenantErasureConflict> {
    const now = this.#clock.now();
    try {
      await this.#pool.query(
        `INSERT INTO tenant_erasure_operation (
           tenant_id, operation_id, state, started_at, updated_at
         ) VALUES ($1, $2, 'running', $3, $3)
         ON CONFLICT (tenant_id, operation_id) DO NOTHING`,
        [tenant, operationId, now],
      );
    } catch (cause) {
      if (postgresCode(cause) !== '23505') throw cause;
      return this.#conflict(tenant, operationId);
    }

    const own = await this.#readOperation(tenant, operationId);
    if (own !== undefined) return own;
    // The only possible winner is another active operation. If it finished in
    // the intervening instant, retrying is an operator decision, not a silent
    // second erase under an id that never acquired a receipt.
    return this.#conflict(tenant, operationId);
  }

  async #claim(
    tenant: TenantId,
    operationId: string,
    revision: bigint,
    leaseToken: string,
  ): Promise<OperationRow | undefined> {
    const now = this.#clock.now();
    const leaseExpiresAt = new Date(now.getTime() + this.#leaseMs);
    const result = await this.#pool.query<OperationRow>(
      `UPDATE tenant_erasure_operation
          SET lease_token = $1,
              lease_expires_at = $2,
              revision = revision + 1,
              updated_at = $3,
              last_error_code = NULL
        WHERE tenant_id = $4
          AND operation_id = $5
          AND state = 'running'
          AND revision = $6::bigint
          AND (lease_token IS NULL OR lease_expires_at <= $3)
      RETURNING ${OPERATION_COLUMNS}`,
      [leaseToken, leaseExpiresAt, now, tenant, operationId, revision],
    );
    return result.rows[0];
  }

  async #eraseR2Page(tenant: TenantId, row: OperationRow, leaseToken: string): Promise<OperationRow> {
    let page;
    try {
      page = await this.#objectStorage.listTenantObjects(
        tenant,
        row.r2_cursor ?? undefined,
        this.#batchSize,
      );
    } catch (cause) {
      throw storageFailure('listing the tenant R2 namespace', cause);
    }

    for (const object of page.objects) {
      if (object.hash === undefined) {
        throw new TenantErasureError(
          'tenant_erasure_object_key_invalid',
          'Tenant R2 namespace contains a non-canonical object key; erasure refused before SQL deletion.',
        );
      }
      try {
        await this.#objectStorage.deleteObject(tenant, object.hash);
      } catch (cause) {
        throw storageFailure('deleting a tenant R2 object', cause);
      }
    }

    return this.#casUpdate(tenant, row.operation_id, row.revision, leaseToken,
      `r2_cursor = $1,
       r2_complete = $2,
       r2_objects_deleted = r2_objects_deleted + $3::bigint`,
      [page.nextContinuationToken ?? null, page.nextContinuationToken === undefined, page.objects.length],
    );
  }

  async #eraseSqlPage(tenant: TenantId, row: OperationRow, leaseToken: string): Promise<OperationRow> {
    const table = TENANT_ERASURE_TABLES[row.sql_table_index];
    if (table === undefined) {
      throw new TenantErasureError('tenant_erasure_cas_lost', 'Tenant erasure SQL progress escaped its static inventory.');
    }
    let deleted: bigint;
    try {
      const result = await this.#pool.query<{ readonly deleted: bigint }>(
        `WITH deleted AS (
           DELETE FROM ${table}
            WHERE ctid IN (
              SELECT ctid FROM ${table}
               WHERE tenant_id = $1
               LIMIT $2
            )
           RETURNING 1
         )
         SELECT count(*)::bigint AS deleted FROM deleted`,
        [tenant, this.#batchSize],
      );
      deleted = result.rows[0]!.deleted;
    } catch (cause) {
      throw databaseFailure(`deleting tenant rows from ${table}`, cause);
    }

    const nextTableIndex = deleted < BigInt(this.#batchSize)
      ? row.sql_table_index + 1
      : row.sql_table_index;
    return this.#casUpdate(tenant, row.operation_id, row.revision, leaseToken,
      `sql_table_index = $1,
       sql_rows_deleted = sql_rows_deleted + $2::bigint`,
      [nextTableIndex, deleted],
    );
  }

  async #verifyAndComplete(tenant: TenantId, row: OperationRow, leaseToken: string): Promise<OperationRow> {
    try {
      const r2 = await this.#objectStorage.listTenantObjects(tenant, undefined, 1);
      if (r2.objects.length > 0) {
        return this.#casUpdate(tenant, row.operation_id, row.revision, leaseToken,
          'r2_cursor = NULL, r2_complete = false',
          [],
        );
      }
    } catch (cause) {
      throw storageFailure('verifying the tenant R2 namespace is empty', cause);
    }

    for (const table of TENANT_ERASURE_TABLES) {
      let present: boolean;
      try {
        const result = await this.#pool.query<{ readonly present: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM ${table} WHERE tenant_id = $1) AS present`,
          [tenant],
        );
        present = result.rows[0]!.present;
      } catch (cause) {
        throw databaseFailure(`verifying tenant rows in ${table}`, cause);
      }
      if (present) {
        return this.#casUpdate(tenant, row.operation_id, row.revision, leaseToken,
          'sql_table_index = 0',
          [],
        );
      }
    }

    const now = this.#clock.now();
    return this.#casUpdate(tenant, row.operation_id, row.revision, leaseToken,
      `state = 'completed',
       completed_at = $1,
       lease_token = NULL,
       lease_expires_at = NULL,
       last_error_code = NULL`,
      [now],
      false,
    );
  }

  async #release(tenant: TenantId, operationId: string, revision: bigint, leaseToken: string): Promise<OperationRow> {
    return this.#casUpdate(tenant, operationId, revision, leaseToken,
      'lease_token = NULL, lease_expires_at = NULL',
      [],
      false,
    );
  }

  async #recordPartial(
    tenant: TenantId,
    operationId: string,
    revision: bigint,
    leaseToken: string,
    errorCode: TenantErasureErrorCode,
  ): Promise<OperationRow> {
    return this.#casUpdate(tenant, operationId, revision, leaseToken,
      `lease_token = NULL,
       lease_expires_at = NULL,
       last_error_code = $1`,
      [errorCode],
      false,
    );
  }

  async #casUpdate(
    tenant: TenantId,
    operationId: string,
    revision: bigint,
    leaseToken: string,
    setClause: string,
    setValues: readonly unknown[],
    refreshLease = true,
  ): Promise<OperationRow> {
    const now = this.#clock.now();
    const values = [...setValues];
    let refreshClause = '';
    if (refreshLease) {
      values.push(new Date(now.getTime() + this.#leaseMs));
      refreshClause = `, lease_expires_at = $${String(values.length)}`;
    }
    values.push(now, tenant, operationId, revision, leaseToken);
    const updatedAtIndex = values.length - 4;
    const tenantIndex = values.length - 3;
    const operationIndex = values.length - 2;
    const revisionIndex = values.length - 1;
    const leaseIndex = values.length;
    const result = await this.#pool.query<OperationRow>(
      `UPDATE tenant_erasure_operation
          SET ${setClause}${refreshClause},
              revision = revision + 1,
              updated_at = $${String(updatedAtIndex)}
        WHERE tenant_id = $${String(tenantIndex)}
          AND operation_id = $${String(operationIndex)}
          AND state = 'running'
          AND revision = $${String(revisionIndex)}::bigint
          AND lease_token = $${String(leaseIndex)}
      RETURNING ${OPERATION_COLUMNS}`,
      values,
    );
    const row = result.rows[0];
    if (row !== undefined) return row;
    throw new TenantErasureError(
      'tenant_erasure_cas_lost',
      'Tenant erasure operation no longer owns its durable progress lease.',
    );
  }

  async #readOperation(tenant: TenantId, operationId: string): Promise<OperationRow | undefined> {
    const result = await this.#pool.query<OperationRow>(
      `SELECT ${OPERATION_COLUMNS}
         FROM tenant_erasure_operation
        WHERE tenant_id = $1 AND operation_id = $2`,
      [tenant, operationId],
    );
    return result.rows[0];
  }

  async #readConflictOrReceipt(tenant: TenantId, operationId: string): Promise<TenantErasureResult> {
    const own = await this.#readOperation(tenant, operationId);
    if (own?.state === 'completed') return toReadback(own);
    // The same id is idempotent only after its receipt is terminal. While a
    // caller holds the CAS lease, a second concurrent caller receives the
    // same typed conflict a distinct operation id receives; it must not be
    // handed an "outstanding" result that suggests it owns progress.
    if (
      own !== undefined &&
      own.lease_token !== null &&
      own.lease_expires_at !== null &&
      own.lease_expires_at > this.#clock.now()
    ) {
      return { status: 'conflict', tenantId: tenant, operationId, activeOperationId: own.operation_id };
    }
    if (own !== undefined) return toReadback(own);
    return this.#conflict(tenant, operationId);
  }

  async #conflict(tenant: TenantId, operationId: string): Promise<TenantErasureConflict> {
    const active = await this.#pool.query<{ readonly operation_id: string }>(
      `SELECT operation_id
         FROM tenant_erasure_operation
        WHERE tenant_id = $1 AND state = 'running'`,
      [tenant],
    );
    const winner = active.rows[0];
    if (winner === undefined) {
      throw new TenantErasureError(
        'tenant_erasure_cas_lost',
        'Tenant erasure operation changed while acquiring its receipt; retry with the same operation id.',
      );
    }
    return { status: 'conflict', tenantId: tenant, operationId, activeOperationId: winner.operation_id };
  }
}

/** Build the Node maintenance composition against the same direct Postgres/R2 authorities. */
export function createPostgresTenantErasure(
  options: PostgresTenantErasureCompositionOptions,
): PostgresTenantErasure {
  return new PostgresTenantErasure({
    pool: options.pool,
    clock: options.clock,
    objectStorage: new R2ObjectMaintenanceStore(options.objectStorage),
    ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    ...(options.maxPagesPerRun === undefined ? {} : { maxPagesPerRun: options.maxPagesPerRun }),
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
  });
}

function toReadback(row: OperationRow): TenantErasureReadback {
  const status: TenantErasureStatus = row.state === 'completed'
    ? 'completed'
    : row.last_error_code === null
      ? 'outstanding'
      : 'partial';
  return {
    status,
    tenantId: tenantId(row.tenant_id),
    operationId: row.operation_id,
    startedAt: row.started_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at.toISOString() }),
    r2Complete: row.r2_complete,
    sqlTableIndex: row.sql_table_index,
    r2ObjectsDeleted: row.r2_objects_deleted,
    sqlRowsDeleted: row.sql_rows_deleted,
    ...(row.last_error_code === null ? {} : { errorCode: row.last_error_code as TenantErasureErrorCode }),
  };
}

function assertOperationId(operationId: string): void {
  if (operationId.length === 0 || operationId.length > 256 || operationId.trim() !== operationId) {
    throw new TenantErasureError(
      'tenant_erasure_invalid_input',
      'operationId must be a non-empty, unpadded string no longer than 256 characters.',
    );
  }
}

function assertBoundedWhole(value: number, field: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TenantErasureError(
      'tenant_erasure_invalid_input',
      `${field} must be a whole number in [1, ${String(max)}].`,
    );
  }
  return value;
}

function postgresCode(cause: unknown): string | undefined {
  return typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : undefined;
}

function storageFailure(action: string, cause: unknown): TenantErasureError {
  return new TenantErasureError(
    'tenant_erasure_storage_failure',
    `Tenant erasure could not finish ${action}; no SQL progress was advanced.`,
    { cause },
  );
}

function databaseFailure(action: string, cause: unknown): TenantErasureError {
  return cause instanceof TenantErasureError
    ? cause
    : new TenantErasureError(
      'tenant_erasure_database_failure',
      `Tenant erasure could not finish ${action}; retry with the same operation id.`,
      { cause },
    );
}
