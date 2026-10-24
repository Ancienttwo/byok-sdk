import { assertCollectExpiredInput, InMemoryStorageLedger, type ObjectCollectExpiredInput, CollectExpiredFailure } from '@byok-sdk/core';
import { REQUEST_RECEIPT_PREFIXES, createInMemoryBlobBytes, type ReceiptCollectExpiredInput } from '@byok-sdk/cloud';
import {
  ByokCoreError,
  CoreConflictError,
  InMemoryQuotaStore,
  assertCanonicalTimestamp,
  InMemoryBoardStore,
  InMemoryTruthStore,
  InMemoryPresenceStore,
  InMemorySkillPackStore,
  isLegalObjectTransition,
  type Clock,
  type ContentHash,
  type CoreStores,
  type MailboxAppendInput,
  type MailboxCursorState,
  type MailboxMessage,
  type MailboxPage,
  type MailboxReadQuery,
  type MailboxRecordDeliveryInput,
  type MailboxAdvanceCursorInput,
  type MailboxCollectExpiredInput,
  type CollectExpiredResult,
  type MailboxStore,
  type MailboxUsage,
  type ObjectCommitInput,
  type ObjectListQuery,
  type ObjectManifestEntry,
  type ObjectManifestInput,
  type ObjectReferenceInput,
  type ObjectStore,
  type QuotaStore,
  type StorageReservation,
  type TenantId,
} from '@byok-sdk/core';
import {
  InMemoryPairingCodeStore,
  TASK_ATTEMPT_ACTIVE_STATUSES,
  TASK_ATTEMPT_STATUSES,
  assertTaskAttemptListLimit,
  createInMemoryCloudStores,
  type AgentMessageAdmission,
  type AgentRef,
  type BlobContentProxy,
  type CloudBlobStore,
  type BlobObservation,
  type BlobReadResult,
  type BlobWriteResult,
  type CloudCrypto,
  type CloudStores,
  type E2eeMemberStore,
  type ProofReceiptRetentionAuthority,
  type RequestReceipt,
  type RequestReceiptStore,
  type TaskAttempt,
  type TaskAttemptCounts,
  type TaskAttemptListQuery,
  type TaskAttemptPage,
  type TaskAttemptStatus,
  type TaskAttemptStore,
  type TaskCancellationMutation,
  type TaskCancellationRequest,
  type TaskCancellationStore,
} from '@byok-sdk/cloud';
import { PROTOCOL_VERSION, byokBlobContentPath, type RuntimeCapabilities, type RuntimeId } from '@byok-sdk/protocol';
import type { DatabaseSync } from 'node:sqlite';
import {
  closeSqliteDatabaseAfterInitializationFailure,
  openSqliteDatabase,
  secureSqliteFilePermissions,
  SqliteSchemaError,
  type SqliteSchemaErrorCode,
} from '../../sqlite-support';

const DEFAULT_MAILBOX_READ_LIMIT = 50;
const DEFAULT_OBJECT_LIST_LIMIT = 100;
const DEFAULT_BLOB_URL_TTL_MS = 15 * 60_000;
const SIGNING_SECRET_BYTES = 32;
const SQLITE_SCHEMA_VERSION = '5';

import { SqliteWakeStore, WAKE_SCHEMA } from './wakes';
import type { WakeStore } from '../../wakes/store';
import { WakeHookMissingError, type WakeConsumer } from '../../wakes/types';

import { SqliteDeviceDirectory, DEVICE_SCHEMA } from './device-directory';
import { E2EE_MEMBER_PROJECTIONS, E2EE_MEMBER_SCHEMA, SqliteE2eeMemberStore } from './e2ee-member';

const RECEIPT_SCHEMA = `
CREATE TABLE request_receipt (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  body TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS byok_sqlite_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mailbox_cursor (
  tenant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 1,
  delivered_seq INTEGER NOT NULL DEFAULT 0,
  acked_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, device_id)
);
CREATE TABLE IF NOT EXISTS mailbox_message (
  tenant_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  message_id TEXT NOT NULL,
  body TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  byte_size TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'acked', 'expired')),
  appended_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, device_id, seq),
  UNIQUE (tenant_id, device_id, message_id)
);
CREATE TABLE IF NOT EXISTS task_attempt (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  agent_ref_json TEXT,
  owner_device_id TEXT,
  claimed_runtime TEXT,
  claimed_harness_id TEXT,
  claimed_runtime_capabilities_json TEXT,
  status TEXT NOT NULL,
  terminal_cause TEXT,
  cancellation_requested_at TEXT,
  cancellation_reason TEXT,
  cancellation_message_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, task_id)
);
CREATE TABLE IF NOT EXISTS agent_message_admission (
  tenant_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload_body TEXT NOT NULL,
  terminal_body TEXT,
  PRIMARY KEY (tenant_id, task_id)
);
CREATE TABLE IF NOT EXISTS object_manifest (
  tenant_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  byte_size TEXT NOT NULL,
  content_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'delete_pending', 'deleted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  delete_pending_at TEXT,
  PRIMARY KEY (tenant_id, hash)
);
CREATE TABLE IF NOT EXISTS object_reference (
  tenant_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  ref_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, hash, ref_kind, ref_id),
  FOREIGN KEY (tenant_id, hash) REFERENCES object_manifest(tenant_id, hash) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS blob (
  blob_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_size TEXT NOT NULL,
  content_type TEXT NOT NULL,
  uploaded INTEGER NOT NULL DEFAULT 0,
  data BLOB,
  UNIQUE (tenant_id, reservation_id)
);
`;

export interface SqliteEmbeddedStoreOptions {
  readonly path: string;
  readonly urlTtlMs?: number;
  readonly migration?: 'v1-to-v5' | 'v2-to-v5' | 'v3-to-v5' | 'v4-to-v5';
}

export interface SqliteEmbeddedStores {
  readonly core: CoreStores;
  readonly cloud: CloudStores;
  readonly blobContentProxy: BlobContentProxy;
  readonly e2eeMember: E2eeMemberStore;
  /** Prunes the used device-proof request ids that `e2eeMember` records. */
  readonly proofReceiptAuthority: ProofReceiptRetentionAuthority;
  wakes(tenant: TenantId): WakeStore;
  close(): Promise<void>;
}

/** One serialized owner for the synchronous SQLite handle and every transaction on it. */
class SqliteCoordinator {
  readonly db: DatabaseSync;
  #tail: Promise<void> = Promise.resolve();
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    path: string,
    migration: SqliteEmbeddedStoreOptions['migration'],
    wake?: WakeConsumer,
  ) {
    if (migration !== undefined && !['v1-to-v5', 'v2-to-v5', 'v3-to-v5', 'v4-to-v5'].includes(migration)) {
      throw new SqliteSchemaError('SQLITE_SCHEMA_UNSUPPORTED', 'Unsupported migration selector. Target-v4 migration selectors are no longer supported.', undefined, SQLITE_SCHEMA_VERSION);
    }
    this.db = openSqliteDatabase(path);
    let foundVersion: string | undefined;
    const schemaError = (code: SqliteSchemaErrorCode, message: string, options?: ErrorOptions) =>
      new SqliteSchemaError(code, message, foundVersion, SQLITE_SCHEMA_VERSION, options);
    // Do not silently recreate missing durable authorities in an existing file.
    const assertProjection = (projection: string) => {
      try {
        this.db.prepare(`SELECT ${projection} LIMIT 0`);
      } catch (error) {
        throw schemaError('SQLITE_SCHEMA_INVALID', `Missing BYOK SQLite durable authority: SELECT ${projection}`, { cause: error });
      }
    };
    try {
      // openSqliteDatabase holds EXCLUSIVE ownership before this schema
      // transaction. Adoption still requires stopping writers and a backup.
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const hasMetadata = this.db
          .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'byok_sqlite_meta'")
          .get();
        if (hasMetadata !== undefined) {
          const version = this.db.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'")
            .get() as { value: string } | undefined;
          foundVersion = version?.value;
          if (version?.value !== SQLITE_SCHEMA_VERSION && !((version?.value === '1' && migration === 'v1-to-v5') || (version?.value === '2' && migration === 'v2-to-v5') || (version?.value === '3' && migration === 'v3-to-v5') || (version?.value === '4' && migration === 'v4-to-v5'))) {
            throw schemaError('SQLITE_SCHEMA_UNSUPPORTED', `Unsupported BYOK SQLite schema version ${JSON.stringify(version?.value)}; ` +
              `this build requires ${SQLITE_SCHEMA_VERSION}. Stop all writers, back up the database and explicitly select migration: 'v1-to-v5' or 'v2-to-v5' for a receipt-free legacy database without task history, 'v3-to-v5' for a database without ambiguous claimed identity, or 'v4-to-v5' to add the wake queue. Target-v4 migration selectors are no longer supported.`);
          }
          for (const projection of [
            'tenant_id, device_id, next_seq, delivered_seq, acked_seq, updated_at FROM mailbox_cursor',
            'tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at FROM mailbox_message',
            'tenant_id, task_id, device_id, agent_ref_json, owner_device_id, claimed_runtime, claimed_runtime_capabilities_json, status, terminal_cause, cancellation_requested_at, cancellation_reason, cancellation_message_id, updated_at FROM task_attempt',
            'tenant_id, task_id, message_id, payload_body, terminal_body FROM agent_message_admission',
            'tenant_id, hash, byte_size, content_type, state, created_at, updated_at, delete_pending_at FROM object_manifest',
            'tenant_id, hash, ref_kind, ref_id, created_at FROM object_reference',
            'blob_id, tenant_id, reservation_id, content_hash, byte_size, content_type, uploaded, data FROM blob',
          ]) {
            assertProjection(projection);
          }
          if (version?.value === '1' || version?.value === '2') {
            // Old compositions lost these facts on restart. Never synthesize
            // receipts from status, mailbox bodies or a caller's retry payload.
            for (const table of ['task_attempt', 'mailbox_message', 'agent_message_admission']) {
              if (this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined) {
                throw schemaError('SQLITE_MIGRATION_REFUSED', 'Cannot migrate BYOK SQLite database with task history: historical receipts are unavailable; preserve this database for reconciliation');
              }
            }
            if (this.db.prepare('SELECT 1 FROM mailbox_cursor WHERE next_seq <> 1 OR delivered_seq <> 0 OR acked_seq <> 0 LIMIT 1').get() !== undefined) {
              throw schemaError('SQLITE_MIGRATION_REFUSED', 'Cannot migrate BYOK SQLite database with delivery history: historical receipts are unavailable; preserve this database for reconciliation');
            }
            if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'request_receipt'").get() !== undefined) {
              throw schemaError('SQLITE_SCHEMA_INVALID', 'Unexpected request receipt authority in legacy BYOK SQLite schema');
            }
            this.db.exec(RECEIPT_SCHEMA);
          }
          if (version?.value === '1') {
            const unexpected = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'device_directory'").get();
            if (unexpected !== undefined) throw schemaError('SQLITE_SCHEMA_INVALID', 'Unexpected device directory in BYOK SQLite schema v1');
            this.db.exec(DEVICE_SCHEMA);
          }
          if (version?.value === '1' || version?.value === '2' || version?.value === '3') {
            // A v3 claim without a runtime may be a legacy built-in claim or a
            // custom claim whose identity was discarded. Neither mutable device
            // inventory nor the requested offer proves the actual adapter.
            if (this.db.prepare('SELECT 1 FROM task_attempt WHERE owner_device_id IS NOT NULL AND claimed_runtime IS NULL LIMIT 1').get() !== undefined) {
              throw schemaError('SQLITE_MIGRATION_REFUSED', 'Cannot migrate BYOK SQLite database with ambiguous claimed identity: historical harness identities are unavailable; preserve this database for reconciliation');
            }
            this.db.exec('ALTER TABLE task_attempt ADD COLUMN claimed_harness_id TEXT');
          }
          if (version?.value !== SQLITE_SCHEMA_VERSION) {
            if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'wake'").get() !== undefined) {
              throw schemaError('SQLITE_SCHEMA_INVALID', 'Unexpected wake authority in pre-v5 BYOK SQLite schema');
            }
            this.db.exec(WAKE_SCHEMA);
            this.db.prepare("UPDATE byok_sqlite_meta SET value = ? WHERE key = 'schema_version'").run(SQLITE_SCHEMA_VERSION);
          }
        } else {
          const existing = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get();
          if (existing !== undefined) throw schemaError('SQLITE_SCHEMA_INVALID', 'Existing SQLite database has no BYOK schema metadata');
          this.db.exec(SCHEMA);
          this.db.exec(RECEIPT_SCHEMA);
          this.db.exec(DEVICE_SCHEMA);
          this.db.exec(WAKE_SCHEMA);
          this.db.prepare("INSERT INTO byok_sqlite_meta (key, value) VALUES ('schema_version', ?)").run(SQLITE_SCHEMA_VERSION);
        }
        assertProjection('claimed_harness_id FROM task_attempt');
        assertProjection('tenant_id, wake_id, dedup_key, available_at, payload, state, due_at, retry_at, deliveries, last_error, done_at FROM wake');
        if (wake === undefined && this.db.prepare("SELECT 1 FROM wake WHERE state = 'queued' LIMIT 1").get() !== undefined) {
          throw new WakeHookMissingError();
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS task_attempt_status_idx ON task_attempt (tenant_id, status, cancellation_requested_at, task_id)');
        this.db.exec(E2EE_MEMBER_SCHEMA);
        for (const projection of E2EE_MEMBER_PROJECTIONS) assertProjection(projection);
        assertProjection('tenant_id, device_id, product_id, machine_id, device_name, device_public_key, proof_key_id, proof_key_epoch, capabilities_json, harnesses_json FROM device_directory');
        const receiptColumns = this.db.prepare('PRAGMA table_info(request_receipt)').all() as unknown as
          { name: string; type: string; notnull: number; pk: number }[];
        const expectedColumns = ['tenant_id', 'key', 'body', 'recorded_at'];
        if (receiptColumns.length !== expectedColumns.length || receiptColumns.some((column, index) =>
          column.name !== expectedColumns[index] || column.type !== 'TEXT' || column.notnull !== 1 ||
          column.pk !== (index < 2 ? index + 1 : 0))) {
          throw schemaError('SQLITE_SCHEMA_INVALID', 'Invalid BYOK SQLite request receipt schema');
        }
        // Schema v5 retains the wire-major fence. A pending old envelope must be
        // refused before routes can repeatedly fail to decode the same row.
        for (const row of this.db.prepare("SELECT body FROM mailbox_message WHERE state = 'pending'").iterate()) {
          let envelope: unknown;
          try { envelope = JSON.parse(row.body as string); } catch { envelope = undefined; }
          if (typeof envelope !== 'object' || envelope === null ||
              !('v' in envelope) || envelope.v !== PROTOCOL_VERSION) {
            throw schemaError('SQLITE_MAILBOX_PROTOCOL_UNSUPPORTED',
              `Pending mailbox rows do not use protocol v${PROTOCOL_VERSION}; preserve the database and drain with the previous SDK before upgrading, or use a new state directory and enrollment`);
          }
        }
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      secureSqliteFilePermissions(path);
    } catch (error) {
      closeSqliteDatabaseAfterInitializationFailure(
        this.db, error,
        'SQLite embedded composition initialization failed and its native handle could not be closed',
      );
    }
  }

  run<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(new Error('SQLite embedded composition is closed'));
    const result = this.#tail.then(() => operation(this.db));
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }

  transaction<T>(operation: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
    return this.run(async (db) => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = await operation(db);
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The original failure remains authoritative.
        }
        throw error;
      }
    });
  }

  transactionSync<T>(body: (db: DatabaseSync) => T, afterCommit: (result: T) => void): Promise<T> {
    return this.run((db) => {
      db.exec('BEGIN IMMEDIATE');
      let result: T;
      try { result = body(db); db.exec('COMMIT'); }
      catch (cause) { try { db.exec('ROLLBACK'); } catch {} throw cause; }
      // No await splits the committed SQL state from its process-local ledger.
      afterCommit(result);
      return result;
    });
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    // Ownership outlives the handle by exactly the close: the next owner may
    // open the moment it is released, never while this handle still writes.
    this.#closePromise = this.#tail.then(() => this.#closeHandle());
    return this.#closePromise;
  }

  #closeHandle(): void {
    this.db.close();
  }
}

interface TaskRow extends Record<string, unknown> {
  tenant_id: string;
  task_id: string;
  device_id: string;
  agent_ref_json: string | null;
  owner_device_id: string | null;
  claimed_runtime: string | null;
  claimed_harness_id: string | null;
  claimed_runtime_capabilities_json: string | null;
  status: string;
  terminal_cause: string | null;
  cancellation_requested_at: string | null;
  cancellation_reason: string | null;
  cancellation_message_id: string | null;
  updated_at: string;
}

function taskRow(row: TaskRow): TaskAttempt {
  return {
    tenantId: row.tenant_id as TenantId,
    taskId: row.task_id,
    deviceId: row.device_id,
    ...(row.agent_ref_json === null ? {} : { agentRef: JSON.parse(row.agent_ref_json) as AgentRef }),
    ...(row.owner_device_id === null ? {} : { ownerDeviceId: row.owner_device_id }),
    ...(row.claimed_runtime === null ? {} : { claimedRuntime: row.claimed_runtime as RuntimeId }),
    ...(row.claimed_harness_id === null ? {} : { claimedHarnessId: row.claimed_harness_id }),
    ...(row.claimed_runtime_capabilities_json === null
      ? {}
      : { claimedRuntimeCapabilities: JSON.parse(row.claimed_runtime_capabilities_json) as RuntimeCapabilities }),
    status: row.status as TaskAttemptStatus,
    ...(row.terminal_cause === null ? {} : { terminalCause: row.terminal_cause }),
    ...(row.cancellation_requested_at === null
      ? {}
      : {
          cancellation: {
            requestedAt: row.cancellation_requested_at,
            ...(row.cancellation_reason === null ? {} : { reason: row.cancellation_reason }),
          },
        }),
    updatedAt: row.updated_at,
  };
}

function readTask(db: DatabaseSync, tenant: TenantId, taskId: string): TaskAttempt | undefined {
  const row = db.prepare('SELECT * FROM task_attempt WHERE tenant_id = ? AND task_id = ?').get(tenant, taskId) as
    | TaskRow
    | undefined;
  return row === undefined ? undefined : taskRow(row);
}

function sameAgentRef(left: AgentRef | undefined, right: AgentRef | undefined): boolean {
  return left?.agentId === right?.agentId && left?.profileRevision === right?.profileRevision;
}

/** Receipts are lifetime facts: mailbox retirement must never delete them. */
class SqliteRequestReceiptStore implements RequestReceiptStore {
  constructor(private readonly coordinator: SqliteCoordinator, private readonly clock: Clock) {}

  collectExpired(tenant: TenantId, input: ReceiptCollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    assertCanonicalTimestamp(input.requestBefore, 'requestBefore');
    return this.coordinator.transaction((db) => {
      if (REQUEST_RECEIPT_PREFIXES.length === 0) return { removed: 0, expired: 0, releasedBytes: 0n, more: false };
      const predicate = REQUEST_RECEIPT_PREFIXES.map(() => 'substr(key, 1, length(?)) = ?').join(' OR ');
      const parameters = REQUEST_RECEIPT_PREFIXES.flatMap(prefix => [prefix, prefix]);
      const removed = Number(db.prepare(`DELETE FROM request_receipt WHERE rowid IN
        (SELECT rowid FROM request_receipt WHERE tenant_id = ? AND recorded_at < ? AND (${predicate}) ORDER BY recorded_at, key LIMIT ?)`)
        .run(tenant, input.requestBefore, ...parameters, input.limit).changes);
      const more = db.prepare(`SELECT 1 FROM request_receipt WHERE tenant_id = ? AND recorded_at < ? AND (${predicate}) LIMIT 1`)
        .get(tenant, input.requestBefore, ...parameters) !== undefined;
      return { removed, expired: 0, releasedBytes: 0n, more };
    });
  }

  record(tenant: TenantId, input: { key: string; body: string }): Promise<{ receipt: RequestReceipt; created: boolean }> {
    // The INSERT is atomic; rows are immutable and never deleted, so the
    // following read cannot observe a different winner. No async lock is held.
    return this.coordinator.run((db) => {
      const result = db.prepare(
        `INSERT INTO request_receipt (tenant_id, key, body, recorded_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (tenant_id, key) DO NOTHING`,
      ).run(tenant, input.key, input.body, this.clock.now().toISOString());
      return { receipt: this.#read(db, tenant, input.key)!, created: Number(result.changes) === 1 };
    });
  }

  get(tenant: TenantId, key: string): Promise<RequestReceipt | undefined> {
    return this.coordinator.run((db) => this.#read(db, tenant, key));
  }

  #read(db: DatabaseSync, tenant: TenantId, key: string): RequestReceipt | undefined {
    const row = db.prepare('SELECT body, recorded_at FROM request_receipt WHERE tenant_id = ? AND key = ?')
      .get(tenant, key) as { body: string; recorded_at: string } | undefined;
    return row === undefined ? undefined : { tenantId: tenant, key, body: row.body, recordedAt: row.recorded_at };
  }
}

export class SqliteTaskAttemptStore implements TaskAttemptStore {
  constructor(private readonly coordinator: SqliteCoordinator, private readonly clock: Clock) {}

  open(tenant: TenantId, input: { taskId: string; deviceId: string; agentRef?: AgentRef }): Promise<TaskAttempt> {
    return this.coordinator.run((db) => {
      db.prepare(
        `INSERT OR IGNORE INTO task_attempt
         (tenant_id, task_id, device_id, agent_ref_json, status, updated_at)
         VALUES (?, ?, ?, ?, 'offered', ?)`,
      ).run(tenant, input.taskId, input.deviceId, input.agentRef === undefined ? null : JSON.stringify(input.agentRef), this.#now());
      return readTask(db, tenant, input.taskId)!;
    });
  }

  reserveAgentOffer(
    tenant: TenantId,
    input: { taskId: string; deviceId: string; agentRef: AgentRef },
  ): Promise<{ attempt: TaskAttempt; created: boolean }> {
    return this.coordinator.run((db) => {
      const result = db.prepare(
        `INSERT OR IGNORE INTO task_attempt
         (tenant_id, task_id, device_id, agent_ref_json, status, updated_at)
         VALUES (?, ?, ?, ?, 'offered', ?)`,
      ).run(tenant, input.taskId, input.deviceId, JSON.stringify(input.agentRef), this.#now());
      return { attempt: readTask(db, tenant, input.taskId)!, created: Number(result.changes) === 1 };
    });
  }

  reserveAgentMessage(
    tenant: TenantId,
    input: { taskId: string; deviceId: string; messageId: string; payloadBody: string },
  ): Promise<'reserved' | 'pending' | 'rejected'> {
    return this.coordinator.run((db) => {
      const attempt = readTask(db, tenant, input.taskId);
      if (attempt === undefined || attempt.deviceId !== input.deviceId) return 'rejected';
      const existing = db.prepare(
        'SELECT message_id, payload_body FROM agent_message_admission WHERE tenant_id = ? AND task_id = ?',
      ).get(tenant, input.taskId) as { message_id: string; payload_body: string } | undefined;
      if (existing !== undefined) {
        return existing.message_id === input.messageId && existing.payload_body === input.payloadBody
          ? 'pending'
          : 'rejected';
      }
      // The shared coordinator serializes cancellation and admission. An
      // existing exact message can reconcile its product outcome after the
      // task changes state; only a new reservation needs a live task.
      if (
        attempt.cancellation !== undefined ||
        !['offered', 'claimed', 'running'].includes(attempt.status)
      ) return 'rejected';
      db.prepare(
        `INSERT INTO agent_message_admission (tenant_id, task_id, message_id, payload_body)
         VALUES (?, ?, ?, ?)`,
      ).run(tenant, input.taskId, input.messageId, input.payloadBody);
      return 'reserved';
    });
  }

  readTaskAgentMessage(
    tenant: TenantId, input: { taskId: string; deviceId: string },
  ): Promise<AgentMessageAdmission | undefined> {
    return this.coordinator.run((db) => {
      if (readTask(db, tenant, input.taskId)?.deviceId !== input.deviceId) return undefined;
      const row = db.prepare(
        `SELECT message_id, payload_body, terminal_body FROM agent_message_admission
         WHERE tenant_id = ? AND task_id = ?`,
      ).get(tenant, input.taskId) as { message_id: string; payload_body: string; terminal_body: string | null } | undefined;
      return row === undefined ? undefined : { messageId: row.message_id, payloadBody: row.payload_body,
        ...(row.terminal_body === null ? {} : { terminalBody: row.terminal_body }) };
    });
  }

  readAgentMessage(
    tenant: TenantId,
    input: { taskId: string; deviceId: string; messageId: string; payloadBody: string },
  ): Promise<AgentMessageAdmission | undefined> {
    return this.coordinator.run((db) => {
      const attempt = readTask(db, tenant, input.taskId);
      if (attempt?.deviceId !== input.deviceId) return undefined;
      const row = db.prepare(
        `SELECT message_id, payload_body, terminal_body FROM agent_message_admission
         WHERE tenant_id = ? AND task_id = ? AND message_id = ? AND payload_body = ?`,
      ).get(tenant, input.taskId, input.messageId, input.payloadBody) as
        | { message_id: string; payload_body: string; terminal_body: string | null }
        | undefined;
      return row === undefined
        ? undefined
        : {
            messageId: row.message_id,
            payloadBody: row.payload_body,
            ...(row.terminal_body === null ? {} : { terminalBody: row.terminal_body }),
          };
    });
  }

  finalizeAgentMessage(
    tenant: TenantId,
    input: { taskId: string; deviceId: string; messageId: string; payloadBody: string; terminalBody: string },
  ): Promise<AgentMessageAdmission | undefined> {
    return this.coordinator.run((db) => {
      const attempt = readTask(db, tenant, input.taskId);
      if (attempt?.deviceId !== input.deviceId) return undefined;
      db.prepare(
        `UPDATE agent_message_admission SET terminal_body = ?
         WHERE tenant_id = ? AND task_id = ? AND message_id = ? AND payload_body = ? AND terminal_body IS NULL`,
      ).run(input.terminalBody, tenant, input.taskId, input.messageId, input.payloadBody);
      const row = db.prepare(
        `SELECT message_id, payload_body, terminal_body FROM agent_message_admission
         WHERE tenant_id = ? AND task_id = ? AND message_id = ? AND payload_body = ?`,
      ).get(tenant, input.taskId, input.messageId, input.payloadBody) as
        | { message_id: string; payload_body: string; terminal_body: string | null }
        | undefined;
      return row === undefined
        ? undefined
        : {
            messageId: row.message_id,
            payloadBody: row.payload_body,
            ...(row.terminal_body === null ? {} : { terminalBody: row.terminal_body }),
          };
    });
  }

  get(tenant: TenantId, taskId: string): Promise<TaskAttempt | undefined> {
    return this.coordinator.run((db) => readTask(db, tenant, taskId));
  }

  getMany(tenant: TenantId, taskIds: readonly string[]): Promise<readonly TaskAttempt[]> {
    return this.coordinator.run((db) => taskIds.flatMap((taskId) => {
      const attempt = readTask(db, tenant, taskId);
      return attempt === undefined ? [] : [attempt];
    }));
  }

  async list(tenant: TenantId, query: TaskAttemptListQuery): Promise<TaskAttemptPage> {
    assertTaskAttemptListLimit(query.limit, query.active);
    return this.coordinator.run((db) => {
      const rows = db.prepare(
        `SELECT * FROM task_attempt ${query.active === true ? 'INDEXED BY task_attempt_status_idx' : ''}
         WHERE tenant_id = ? ${query.active === true ? `AND status IN (${TASK_ATTEMPT_ACTIVE_STATUSES.map(() => '?').join(', ')}) AND cancellation_requested_at IS NULL` : ''} AND task_id > ?
         ORDER BY task_id COLLATE BINARY LIMIT ?`,
      ).all(tenant, ...(query.active === true ? TASK_ATTEMPT_ACTIVE_STATUSES : []), query.cursor ?? '', query.limit + 1) as unknown as TaskRow[];
      const hasMore = rows.length > query.limit;
      const attempts = rows.slice(0, query.limit).map(taskRow);
      const last = attempts.at(-1);
      return { attempts, ...(hasMore && last !== undefined ? { nextCursor: last.taskId } : {}) };
    });
  }

  countByStatus(tenant: TenantId): Promise<TaskAttemptCounts> {
    return this.coordinator.run((db) => {
      const rows = db.prepare(
        `SELECT status, cancellation_requested_at IS NOT NULL AS cancelled, COUNT(*) AS n
         FROM task_attempt WHERE tenant_id = ? GROUP BY status, cancelled`,
      ).all(tenant) as unknown as { status: string; cancelled: number; n: number }[];
      const byStatus = Object.fromEntries(TASK_ATTEMPT_STATUSES.map((status) => [status, 0])) as Record<TaskAttemptStatus, number>;
      let cancellationRequested = 0;
      for (const row of rows) {
        if (!TASK_ATTEMPT_STATUSES.some((status) => status === row.status)) throw new Error('Unknown stored task attempt status');
        if (!Number.isSafeInteger(row.n) || row.n < 0) throw new Error('Invalid task attempt aggregate count');
        if (row.cancelled === 1) cancellationRequested += row.n;
        else byStatus[row.status as TaskAttemptStatus] += row.n;
      }
      return { byStatus, cancellationRequested };
    });
  }

  claim(
    tenant: TenantId,
    input: { taskId: string; deviceId: string; runtime?: RuntimeId; harnessId?: string; capabilities?: RuntimeCapabilities },
  ): Promise<TaskAttempt | undefined> {
    return this.coordinator.run((db) => {
      db.prepare(
        `UPDATE task_attempt SET owner_device_id = ?, claimed_runtime = ?, claimed_harness_id = ?, claimed_runtime_capabilities_json = ?,
          status = 'claimed', updated_at = ?
         WHERE tenant_id = ? AND task_id = ? AND device_id = ? AND owner_device_id IS NULL
           AND cancellation_requested_at IS NULL AND status = 'offered'`,
      ).run(
        input.deviceId,
        input.runtime ?? null,
        input.harnessId ?? null,
        input.capabilities === undefined ? null : JSON.stringify(input.capabilities),
        this.#now(),
        tenant,
        input.taskId,
        input.deviceId,
      );
      return readTask(db, tenant, input.taskId);
    });
  }

  recordStatus(
    tenant: TenantId,
    input: { taskId: string; status: TaskAttemptStatus; agentRef?: AgentRef; terminalCause?: string },
  ): Promise<TaskAttempt | undefined> {
    return this.coordinator.run((db) => {
      const existing = readTask(db, tenant, input.taskId);
      if (existing === undefined) return undefined;
      if (!sameAgentRef(existing.agentRef, input.agentRef)) return existing;
      if (existing.cancellation !== undefined) {
        if (input.status !== 'cancelled' || existing.status === 'cancelled') return existing;
      } else if (['complete', 'failed', 'cancelled'].includes(existing.status)) {
        return existing;
      }
      db.prepare(
        `UPDATE task_attempt SET status = ?, terminal_cause = ?, updated_at = ?
         WHERE tenant_id = ? AND task_id = ?`,
      ).run(input.status, input.terminalCause ?? null, this.#now(), tenant, input.taskId);
      return readTask(db, tenant, input.taskId);
    });
  }

  #now(): string {
    return this.clock.now().toISOString();
  }
}

interface MailboxRow extends Record<string, unknown> {
  tenant_id: string;
  device_id: string;
  seq: number;
  message_id: string;
  body: string;
  body_hash: string;
  byte_size: string;
  state: 'pending' | 'acked' | 'expired';
  appended_at: string;
}

function mailboxMessage(row: MailboxRow): MailboxMessage {
  return {
    tenantId: row.tenant_id as TenantId,
    deviceId: row.device_id,
    seq: Number(row.seq),
    messageId: row.message_id,
    body: row.body,
    bodyHash: row.body_hash as ContentHash,
    byteSize: BigInt(row.byte_size),
    state: row.state,
    appendedAt: row.appended_at,
  };
}

function ensureMailboxCursor(db: DatabaseSync, clock: Clock, tenant: TenantId, deviceId: string): void {
  if (deviceId.length === 0) {
    throw new ByokCoreError('mailbox_message_not_found', 'Device id must not be empty.');
  }
  db.prepare(
    `INSERT OR IGNORE INTO mailbox_cursor (tenant_id, device_id, updated_at) VALUES (?, ?, ?)`,
  ).run(tenant, deviceId, clock.now().toISOString());
}

function readCursor(db: DatabaseSync, clock: Clock, tenant: TenantId, deviceId: string): MailboxCursorState {
  const row = db.prepare(
    `SELECT delivered_seq, acked_seq, updated_at FROM mailbox_cursor WHERE tenant_id = ? AND device_id = ?`,
  ).get(tenant, deviceId) as { delivered_seq: number; acked_seq: number; updated_at: string } | undefined;
  return row === undefined
    ? { tenantId: tenant, deviceId, deliveredSeq: 0, ackedSeq: 0, updatedAt: clock.now().toISOString() }
    : {
        tenantId: tenant,
        deviceId,
        deliveredSeq: Number(row.delivered_seq),
        ackedSeq: Number(row.acked_seq),
        updatedAt: row.updated_at,
      };
}

/** The mailbox reads its limit from quota; quota never reads the mailbox. */
type MailboxQuota = Pick<QuotaStore, 'readEntitlement'>;

/**
 * Mailbox bytes are the retained rows, so usage is recomputed from the durable
 * table on every read and stays correct across a restart. `byte_size` is TEXT;
 * the sum is rendered back to TEXT so it never passes through a JS number.
 */
function mailboxUsedBytes(db: DatabaseSync, tenant: TenantId): bigint {
  const row = db.prepare(
    `SELECT CAST(COALESCE(SUM(CAST(byte_size AS INTEGER)), 0) AS TEXT) AS bytes
       FROM mailbox_message WHERE tenant_id = ?`,
  ).get(tenant) as { bytes: string };
  return BigInt(row.bytes);
}

/**
 * The one SQLite mailbox row writer. It runs inside the coordinator's
 * transaction, which serializes every writer globally, so reading the
 * entitlement, summing and inserting cannot be interleaved by another append.
 */
async function appendMailbox(
  db: DatabaseSync,
  clock: Clock,
  quota: MailboxQuota,
  tenant: TenantId,
  input: MailboxAppendInput,
): Promise<MailboxMessage> {
  ensureMailboxCursor(db, clock, tenant, input.deviceId);
  const existing = db.prepare(
    `SELECT * FROM mailbox_message WHERE tenant_id = ? AND device_id = ? AND message_id = ?`,
  ).get(tenant, input.deviceId, input.messageId) as MailboxRow | undefined;
  if (existing !== undefined) return mailboxMessage(existing);
  // Anything but the one exempt class is limited: an unknown admission fails
  // closed instead of skipping the check.
  let limit: bigint | undefined;
  if (input.admission !== 'cancellation') {
    const entitlement = await quota.readEntitlement(tenant);
    if (entitlement === undefined) {
      throw new ByokCoreError(
        'storage_entitlement_missing',
        'No storage entitlement has been issued for this tenant.',
      );
    }
    limit = entitlement.mailboxLimitBytes;
  }
  const cursor = db.prepare(
    `SELECT next_seq FROM mailbox_cursor WHERE tenant_id = ? AND device_id = ?`,
  ).get(tenant, input.deviceId) as { next_seq: number };
  const seq = Number(cursor.next_seq);
  const materialized = await input.materialize(seq);
  if (limit !== undefined) {
    const used = mailboxUsedBytes(db, tenant);
    if (used + materialized.byteSize > limit) {
      throw new ByokCoreError(
        'storage_quota_exceeded',
        `Mailbox would reach ${String(used + materialized.byteSize)} bytes, over the limit of ${String(limit)} bytes.`,
      );
    }
  }
  db.prepare(
    `INSERT INTO mailbox_message
     (tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(
    tenant,
    input.deviceId,
    seq,
    input.messageId,
    materialized.body,
    materialized.bodyHash,
    String(materialized.byteSize),
    clock.now().toISOString(),
  );
  db.prepare(
    `UPDATE mailbox_cursor SET next_seq = ? WHERE tenant_id = ? AND device_id = ?`,
  ).run(seq + 1, tenant, input.deviceId);
  return mailboxMessage(db.prepare(
    `SELECT * FROM mailbox_message WHERE tenant_id = ? AND device_id = ? AND seq = ?`,
  ).get(tenant, input.deviceId, seq) as MailboxRow);
}

export class SqliteMailboxStore implements MailboxStore {
  constructor(
    private readonly coordinator: SqliteCoordinator,
    private readonly clock: Clock,
    private readonly quota: MailboxQuota,
  ) {}

  append(tenant: TenantId, input: MailboxAppendInput): Promise<MailboxMessage> {
    return this.coordinator.transaction((db) => appendMailbox(db, this.clock, this.quota, tenant, input));
  }

  readUsage(tenant: TenantId): Promise<MailboxUsage> {
    return this.coordinator.run((db) => ({ bytes: mailboxUsedBytes(db, tenant) }));
  }

  readAfter(tenant: TenantId, query: MailboxReadQuery): Promise<MailboxPage> {
    return this.coordinator.run((db) => {
      const limit = query.limit ?? DEFAULT_MAILBOX_READ_LIMIT;
      const rows = db.prepare(
        `SELECT * FROM mailbox_message
         WHERE tenant_id = ? AND device_id = ? AND state = 'pending' AND seq > ?
         ORDER BY seq LIMIT ?`,
      ).all(tenant, query.deviceId, query.afterSeq, limit + 1) as unknown as MailboxRow[];
      const page = rows.slice(0, limit).map(mailboxMessage);
      const last = page.at(-1);
      const lost = db.prepare(
        `SELECT MAX(seq) AS lost FROM mailbox_message
         WHERE tenant_id = ? AND device_id = ? AND state = 'expired'`,
      ).get(tenant, query.deviceId) as { lost: number | null };
      return {
        messages: page,
        nextSeq: last?.seq ?? query.afterSeq,
        hasMore: rows.length > limit,
        recoverableFrom: Number(lost.lost ?? 0) + 1,
      };
    });
  }

  recordDelivery(tenant: TenantId, input: MailboxRecordDeliveryInput): Promise<MailboxCursorState> {
    return this.coordinator.run((db) => {
      ensureMailboxCursor(db, this.clock, tenant, input.deviceId);
      db.prepare(
        `UPDATE mailbox_cursor SET delivered_seq = MAX(delivered_seq, ?)
         WHERE tenant_id = ? AND device_id = ?`,
      ).run(input.deliveredSeq, tenant, input.deviceId);
      return readCursor(db, this.clock, tenant, input.deviceId);
    });
  }

  advanceCursor(tenant: TenantId, input: MailboxAdvanceCursorInput): Promise<MailboxCursorState> {
    return this.coordinator.transaction((db) => {
      ensureMailboxCursor(db, this.clock, tenant, input.deviceId);
      const current = readCursor(db, this.clock, tenant, input.deviceId);
      const observedAt = this.clock.now().toISOString();
      if (input.ackedSeq < current.ackedSeq) {
        throw new CoreConflictError(
          'mailbox_cursor_regression',
          `Cursor for device ${input.deviceId} is at ${current.ackedSeq}; refusing to move it back to ${input.ackedSeq}.`,
          current,
          observedAt,
        );
      }
      if (input.ackedSeq > current.deliveredSeq) {
        throw new CoreConflictError(
          'mailbox_cursor_ahead_of_delivery',
          `Cursor for device ${input.deviceId} was delivered through ${current.deliveredSeq}; refusing to acknowledge future cursor ${input.ackedSeq}.`,
          current,
          observedAt,
        );
      }
      db.prepare(
        `UPDATE mailbox_cursor SET acked_seq = ?, updated_at = ? WHERE tenant_id = ? AND device_id = ?`,
      ).run(input.ackedSeq, observedAt, tenant, input.deviceId);
      db.prepare(
        `UPDATE mailbox_message SET state = 'acked'
         WHERE tenant_id = ? AND device_id = ? AND state = 'pending' AND seq <= ?`,
      ).run(tenant, input.deviceId, input.ackedSeq);
      return readCursor(db, this.clock, tenant, input.deviceId);
    });
  }

  readCursor(tenant: TenantId, deviceId: string): Promise<MailboxCursorState> {
    return this.coordinator.run((db) => readCursor(db, this.clock, tenant, deviceId));
  }

  async collectExpired(tenant: TenantId, input: MailboxCollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    assertCanonicalTimestamp(input.ackedBefore, 'ackedBefore');
    assertCanonicalTimestamp(input.expireUnackedBefore, 'expireUnackedBefore');
    return this.coordinator.transaction((db) => {
      const removed = Number(db.prepare(`DELETE FROM mailbox_message WHERE rowid IN
        (SELECT rowid FROM mailbox_message WHERE tenant_id = ? AND state = 'acked' AND appended_at < ? ORDER BY appended_at, rowid LIMIT ?)`)
        .run(tenant, input.ackedBefore, input.limit).changes);
      const remaining = input.limit - removed;
      const expired = Number(db.prepare(`UPDATE mailbox_message SET state = 'expired' WHERE rowid IN
        (SELECT rowid FROM mailbox_message WHERE tenant_id = ? AND state = 'pending' AND appended_at < ? ORDER BY appended_at, rowid LIMIT ?)`)
        .run(tenant, input.expireUnackedBefore, remaining).changes);
      const more = db.prepare(`SELECT 1 FROM mailbox_message WHERE tenant_id = ? AND
        ((state = 'acked' AND appended_at < ?) OR (state = 'pending' AND appended_at < ?)) LIMIT 1`)
        .get(tenant, input.ackedBefore, input.expireUnackedBefore) !== undefined;
      return { removed, expired, releasedBytes: 0n, more };
    });
  }

}

export class SqliteTaskCancellationStore implements TaskCancellationStore {
  constructor(
    private readonly coordinator: SqliteCoordinator,
    private readonly clock: Clock,
    private readonly quota: MailboxQuota,
  ) {}

  request(tenant: TenantId, input: TaskCancellationRequest): Promise<TaskCancellationMutation | undefined> {
    return this.coordinator.transaction(async (db) => {
      const existing = readTask(db, tenant, input.taskId);
      if (existing === undefined) return undefined;
      if (
        existing.cancellation === undefined &&
        ['complete', 'failed', 'cancelled'].includes(existing.status)
      ) return { attempt: existing };

      const existingMessageId = (db.prepare(
        `SELECT cancellation_message_id FROM task_attempt WHERE tenant_id = ? AND task_id = ?`,
      ).get(tenant, input.taskId) as { cancellation_message_id: string | null }).cancellation_message_id;
      if (existingMessageId !== null) {
        const row = db.prepare(
          `SELECT * FROM mailbox_message WHERE tenant_id = ? AND device_id = ? AND message_id = ?`,
        ).get(tenant, existing.deviceId, existingMessageId) as MailboxRow | undefined;
        if (row === undefined) {
          if (existing.status === 'cancelled') return { attempt: existing };
          throw new Error(`Cancellation delivery ${existingMessageId} is missing for task ${input.taskId}`);
        }
        return { attempt: existing, message: mailboxMessage(row) };
      }

      const message = await appendMailbox(db, this.clock, this.quota, tenant, {
        deviceId: existing.deviceId,
        messageId: input.proposedMessageId,
        materialize: (seq) => input.materialize(seq, input.proposedMessageId),
        admission: 'cancellation',
      });
      const requestedAt = this.clock.now().toISOString();
      db.prepare(
        `UPDATE task_attempt SET
           status = CASE WHEN owner_device_id IS NULL THEN 'cancelled' ELSE 'cancel_requested' END,
           cancellation_requested_at = ?, cancellation_reason = ?, cancellation_message_id = ?, updated_at = ?
         WHERE tenant_id = ? AND task_id = ?`,
      ).run(requestedAt, input.reason ?? null, input.proposedMessageId, requestedAt, tenant, input.taskId);
      return { attempt: readTask(db, tenant, input.taskId)!, message };
    });
  }
}

interface ManifestRow extends Record<string, unknown> {
  tenant_id: string;
  hash: string;
  byte_size: string;
  content_type: string;
  state: ObjectManifestEntry['state'];
  created_at: string;
  updated_at: string;
  delete_pending_at: string | null;
  ref_count: number;
}

function manifestRow(row: ManifestRow): ObjectManifestEntry {
  return {
    tenantId: row.tenant_id as TenantId,
    hash: row.hash as ContentHash,
    byteSize: BigInt(row.byte_size),
    contentType: row.content_type,
    state: row.state,
    refCount: Number(row.ref_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.delete_pending_at === null ? {} : { deletePendingAt: row.delete_pending_at }),
  };
}

const MANIFEST_SELECT = `
SELECT m.*, COUNT(r.ref_id) AS ref_count
FROM object_manifest m
LEFT JOIN object_reference r ON r.tenant_id = m.tenant_id AND r.hash = m.hash`;

function readManifest(db: DatabaseSync, tenant: TenantId, hash: ContentHash): ObjectManifestEntry | undefined {
  const row = db.prepare(
    `${MANIFEST_SELECT} WHERE m.tenant_id = ? AND m.hash = ? GROUP BY m.tenant_id, m.hash`,
  ).get(tenant, hash) as ManifestRow | undefined;
  return row === undefined ? undefined : manifestRow(row);
}

function requireManifest(db: DatabaseSync, tenant: TenantId, hash: ContentHash): ObjectManifestEntry {
  const entry = readManifest(db, tenant, hash);
  if (entry === undefined) {
    throw new ByokCoreError('object_not_found', `Object ${hash} has no manifest row in this tenant.`);
  }
  return entry;
}

function putManifest(db: DatabaseSync, clock: Clock, tenant: TenantId, input: ObjectManifestInput): ObjectManifestEntry {
  const existing = readManifest(db, tenant, input.hash);
  if (existing !== undefined && existing.state !== 'deleted') return existing;
  const now = clock.now().toISOString();
  db.prepare('DELETE FROM object_reference WHERE tenant_id = ? AND hash = ?').run(tenant, input.hash);
  db.prepare(
    `INSERT INTO object_manifest
     (tenant_id, hash, byte_size, content_type, state, created_at, updated_at, delete_pending_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL)
     ON CONFLICT (tenant_id, hash) DO UPDATE SET
       byte_size = excluded.byte_size, content_type = excluded.content_type, state = 'pending',
       created_at = excluded.created_at, updated_at = excluded.updated_at, delete_pending_at = NULL`,
  ).run(tenant, input.hash, String(input.byteSize), input.contentType, now, now);
  return readManifest(db, tenant, input.hash)!;
}

export class SqliteObjectStore implements ObjectStore {
  constructor(private readonly coordinator: SqliteCoordinator, private readonly clock: Clock, private readonly ledger: InMemoryStorageLedger) {}
  readonly #deleteCursor = new Map<TenantId, string>();

  async collectExpired(tenant: TenantId, input: ObjectCollectExpiredInput): Promise<CollectExpiredResult> {
    assertCollectExpiredInput(input);
    assertCanonicalTimestamp(input.orphanBefore, 'orphanBefore');
    const predicate = `m.tenant_id = ? AND m.state IN ('pending', 'committed', 'delete_pending')
      AND (m.state = 'delete_pending' OR m.updated_at < ?)
      AND NOT EXISTS (SELECT 1 FROM object_reference r WHERE r.tenant_id = m.tenant_id AND r.hash = m.hash)
      AND m.hash NOT IN (SELECT value FROM json_each(?))`;
    const cursor = this.#deleteCursor.get(tenant) ?? '';
    const candidates = await this.coordinator.run(db => db.prepare(`SELECT m.hash, m.state FROM object_manifest m WHERE ${predicate}
      ORDER BY CASE WHEN m.state = 'delete_pending' AND m.hash > ? THEN 0 WHEN m.state <> 'delete_pending' THEN 1 ELSE 2 END, CASE WHEN m.state <> 'delete_pending' THEN m.updated_at ELSE '' END, m.hash LIMIT ?`)
      .all(tenant, input.orphanBefore, JSON.stringify(this.ledger.reservedObjectHashes(tenant)), cursor, input.limit + 1) as Array<{hash: string; state: string}>);
    let removed = 0, releasedBytes = 0n, failures = 0;
    let firstFailure: unknown;
    for (const { hash } of candidates.slice(0, input.limit)) {

      try {
        const tombstoned = await this.coordinator.transactionSync((db) => {
          const entry = readManifest(db, tenant, hash as ContentHash);
          if (entry === undefined || entry.refCount !== 0 || this.ledger.hasReservedObject(tenant, entry.hash)
            || !(entry.state === 'delete_pending' || ((entry.state === 'pending' || entry.state === 'committed') && entry.updatedAt < input.orphanBefore))) return false;
          if (entry.state !== 'delete_pending') db.prepare("UPDATE object_manifest SET state = 'delete_pending', delete_pending_at = ?, updated_at = ? WHERE tenant_id = ? AND hash = ?")
            .run(input.now, input.now, tenant, hash);
          return true;
        }, () => {});
        if (!tombstoned) continue;
        const result = await this.coordinator.transactionSync((db) => {
          const entry = readManifest(db, tenant, hash as ContentHash);
          if (entry === undefined || entry.refCount !== 0 || this.ledger.hasReservedObject(tenant, entry.hash)
            || entry.state !== 'delete_pending') return undefined;
          const release = this.ledger.prepareCollectedObjectRelease(tenant, entry.hash, entry.byteSize, input.now);
          db.prepare('DELETE FROM blob WHERE tenant_id = ? AND content_hash = ?').run(tenant, hash);
          db.prepare("UPDATE object_manifest SET state = 'deleted', updated_at = ? WHERE tenant_id = ? AND hash = ?").run(input.now, tenant, hash);
          return release;
        }, release => release?.commit());
        if (result !== undefined) { removed++; releasedBytes += result.releasedBytes; }
      } catch (cause) { failures++; firstFailure ??= cause; }
    }
    const committed = { removed, expired: 0, releasedBytes };
    let more: boolean;
    try {
      const selected = candidates.slice(0, input.limit).filter(row => row.state === 'delete_pending');
      const wrapped = selected.filter(row => row.hash <= cursor);
      const first = selected.filter(row => row.hash > cursor);
      this.#deleteCursor.set(tenant, wrapped.at(-1)?.hash ?? first.at(-1)?.hash ?? '');
      more = await this.coordinator.run(db => db.prepare(`SELECT 1 FROM object_manifest m WHERE ${predicate} LIMIT 1`)
        .get(tenant, input.orphanBefore, JSON.stringify(this.ledger.reservedObjectHashes(tenant))) !== undefined);
    } catch (cause) {
      throw new CollectExpiredFailure(committed, failures, undefined, { cause });
    }
    if (failures > 0) throw new CollectExpiredFailure(committed, failures, more, { cause: firstFailure });
    return { ...committed, more };
  }

  putManifest(tenant: TenantId, input: ObjectManifestInput): Promise<ObjectManifestEntry> {
    return this.coordinator.transaction((db) => putManifest(db, this.clock, tenant, input));
  }

  commit(tenant: TenantId, input: ObjectCommitInput): Promise<ObjectManifestEntry> {
    return this.coordinator.transaction((db) => {
      const current = requireManifest(db, tenant, input.hash);
      if (current.byteSize !== input.observedByteSize || current.contentType !== input.observedContentType) {
        throw new ByokCoreError(
          'storage_integrity_mismatch',
          `Observed object ${input.hash} does not match the declared manifest.`,
        );
      }
      if (current.state === 'committed') return current;
      return this.#transition(db, tenant, current, 'committed');
    });
  }

  get(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry | undefined> {
    return this.coordinator.run((db) => readManifest(db, tenant, hash));
  }

  async list(tenant: TenantId, query: ObjectListQuery): Promise<readonly ObjectManifestEntry[]> {
    if (query.deletePendingBefore !== undefined) {
      assertCanonicalTimestamp(query.deletePendingBefore, 'deletePendingBefore');
    }
    return this.coordinator.run((db) => {
      const rows = db.prepare(
        `${MANIFEST_SELECT}
         WHERE m.tenant_id = ? AND (? IS NULL OR m.state = ?)
           AND (? IS NULL OR (m.delete_pending_at IS NOT NULL AND m.delete_pending_at < ?))
         GROUP BY m.tenant_id, m.hash ORDER BY m.hash COLLATE BINARY LIMIT ?`,
      ).all(
        tenant,
        query.state ?? null,
        query.state ?? null,
        query.deletePendingBefore ?? null,
        query.deletePendingBefore ?? null,
        query.limit ?? DEFAULT_OBJECT_LIST_LIMIT,
      ) as unknown as ManifestRow[];
      return rows.map(manifestRow);
    });
  }

  addReference(tenant: TenantId, input: ObjectReferenceInput): Promise<ObjectManifestEntry> {
    return this.coordinator.transaction((db) => {
      const current = requireManifest(db, tenant, input.hash);
      if (current.state !== 'committed') {
        throw new ByokCoreError('object_state_invalid', `Only committed objects can be referenced; ${input.hash} is ${current.state}.`);
      }
      db.prepare(
        `INSERT OR IGNORE INTO object_reference (tenant_id, hash, ref_kind, ref_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(tenant, input.hash, input.refKind, input.refId, this.clock.now().toISOString());
      db.prepare('UPDATE object_manifest SET updated_at = ? WHERE tenant_id = ? AND hash = ?')
        .run(this.clock.now().toISOString(), tenant, input.hash);
      return requireManifest(db, tenant, input.hash);
    });
  }

  removeReference(tenant: TenantId, input: ObjectReferenceInput): Promise<ObjectManifestEntry> {
    return this.coordinator.transaction((db) => {
      requireManifest(db, tenant, input.hash);
      db.prepare(
        `DELETE FROM object_reference WHERE tenant_id = ? AND hash = ? AND ref_kind = ? AND ref_id = ?`,
      ).run(tenant, input.hash, input.refKind, input.refId);
      db.prepare('UPDATE object_manifest SET updated_at = ? WHERE tenant_id = ? AND hash = ?')
        .run(this.clock.now().toISOString(), tenant, input.hash);
      return requireManifest(db, tenant, input.hash);
    });
  }

  markDeletePending(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry> {
    return this.coordinator.transaction((db) => {
      const current = requireManifest(db, tenant, hash);
      if (current.refCount !== 0) {
        throw new ByokCoreError('object_state_invalid', `Object ${hash} still has ${current.refCount} reference(s).`);
      }
      return this.#transition(db, tenant, current, 'delete_pending');
    });
  }

  markDeleted(tenant: TenantId, hash: ContentHash): Promise<ObjectManifestEntry> {
    return this.coordinator.transaction((db) => this.#transition(db, tenant, requireManifest(db, tenant, hash), 'deleted'));
  }

  #transition(
    db: DatabaseSync,
    tenant: TenantId,
    current: ObjectManifestEntry,
    next: ObjectManifestEntry['state'],
  ): ObjectManifestEntry {
    if (!isLegalObjectTransition(current.state, next)) {
      throw new ByokCoreError('object_state_invalid', `${current.state} to ${next} is not a legal object manifest transition.`);
    }
    const now = this.clock.now().toISOString();
    db.prepare(
      `UPDATE object_manifest SET state = ?, updated_at = ?, delete_pending_at = ?
       WHERE tenant_id = ? AND hash = ?`,
    ).run(next, now, next === 'delete_pending' ? now : current.deletePendingAt ?? null, tenant, current.hash);
    return requireManifest(db, tenant, current.hash);
  }
}

interface BlobRow extends Record<string, unknown> {
  blob_id: string;
  tenant_id: string;
  reservation_id: string;
  content_hash: string;
  byte_size: string;
  content_type: string;
  uploaded: number;
  data: Uint8Array | null;
}

function assertReservedObject(tenant: TenantId, reservation: StorageReservation): void {
  if (
    reservation.tenantId === tenant &&
    reservation.kind === 'object' &&
    reservation.state === 'reserved' &&
    reservation.expectedBytes >= 0n
  ) return;
  throw new ByokCoreError(
    'storage_integrity_mismatch',
    'An upload grant requires a reserved object reservation owned by this tenant.',
  );
}

class SqliteBlobRegistry {
  readonly secret: Uint8Array;
  readonly urlTtlMs: number;

  constructor(
    readonly coordinator: SqliteCoordinator,
    readonly clock: Clock,
    readonly crypto: CloudCrypto,
    urlTtlMs: number,
  ) {
    this.urlTtlMs = urlTtlMs;
    const row = coordinator.db.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'blob_signing_secret'").get() as
      | { value: string }
      | undefined;
    if (row === undefined) {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(SIGNING_SECRET_BYTES));
      coordinator.db.prepare(
        "INSERT OR IGNORE INTO byok_sqlite_meta (key, value) VALUES ('blob_signing_secret', ?)",
      ).run(Buffer.from(bytes).toString('base64url'));
    }
    const stored = coordinator.db.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'blob_signing_secret'").get() as { value: string };
    this.secret = Buffer.from(stored.value, 'base64url');
  }

  async signUrl(blobId: string, action: 'put' | 'get'): Promise<string> {
    const exp = this.clock.now().getTime() + this.urlTtlMs;
    const sig = await this.crypto.hmacSha256(this.secret, `${blobId}:${action}:${exp}`);
    return `${byokBlobContentPath(blobId)}?sig=${sig}&exp=${exp}`;
  }
}

export class SqliteCloudBlobStore implements CloudBlobStore {
  constructor(private readonly registry: SqliteBlobRegistry) {}

  async createUpload(tenant: TenantId, reservation: StorageReservation): Promise<{ blobId: string; uploadUrl: string }> {
    assertReservedObject(tenant, reservation);
    const blobId = await this.registry.coordinator.transaction((db) => {
      const existing = db.prepare(
        'SELECT * FROM blob WHERE tenant_id = ? AND reservation_id = ?',
      ).get(tenant, reservation.reservationId) as BlobRow | undefined;
      if (existing !== undefined) {
        const manifest = readManifest(db, tenant, reservation.contentHash);
        if (manifest?.state === 'committed') {
          throw new ByokCoreError('object_state_invalid', `Object ${reservation.contentHash} is already committed and immutable.`);
        }
        return existing.blob_id;
      }
      const entry = putManifest(db, this.registry.clock, tenant, {
        hash: reservation.contentHash,
        byteSize: reservation.expectedBytes,
        contentType: reservation.contentType,
      });
      if (entry.byteSize !== reservation.expectedBytes || entry.contentType !== reservation.contentType) {
        throw new ByokCoreError('storage_integrity_mismatch', `Object ${reservation.contentHash} already binds a different storage declaration.`);
      }
      if (entry.state === 'committed') {
        throw new ByokCoreError('object_state_invalid', `Object ${reservation.contentHash} is already committed and immutable.`);
      }
      const created = `blob_${this.registry.crypto.randomUuid()}`;
      db.prepare(
        `INSERT INTO blob
         (blob_id, tenant_id, reservation_id, content_hash, byte_size, content_type)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(created, tenant, reservation.reservationId, reservation.contentHash, String(reservation.expectedBytes), reservation.contentType);
      return created;
    });
    return { blobId, uploadUrl: await this.registry.signUrl(blobId, 'put') };
  }

  observeUpload(tenant: TenantId, blobId: string, reservation: StorageReservation): Promise<BlobObservation | undefined> {
    return this.registry.coordinator.run((db) => {
      const row = db.prepare('SELECT * FROM blob WHERE blob_id = ?').get(blobId) as BlobRow | undefined;
      if (
        row === undefined || row.tenant_id !== tenant || reservation.tenantId !== tenant ||
        row.reservation_id !== reservation.reservationId || row.content_hash !== reservation.contentHash || !row.uploaded
      ) return undefined;
      return { observedByteSize: BigInt(row.data?.byteLength ?? 0), observedContentType: row.content_type };
    });
  }

  async getDownloadUrl(tenant: TenantId, blobId: string): Promise<string | undefined> {
    const found = await this.registry.coordinator.run((db) => {
      const row = db.prepare('SELECT * FROM blob WHERE blob_id = ?').get(blobId) as BlobRow | undefined;
      if (row === undefined || row.tenant_id !== tenant || !row.uploaded) return false;
      return readManifest(db, tenant, row.content_hash as ContentHash)?.state === 'committed';
    });
    return found ? this.registry.signUrl(blobId, 'get') : undefined;
  }
}

export class SqliteBlobContentProxy implements BlobContentProxy {
  constructor(private readonly registry: SqliteBlobRegistry) {}

  async verifySignedUrl(blobId: string, action: 'put' | 'get', sig: string, exp: number): Promise<boolean> {
    if (!Number.isFinite(exp) || this.registry.clock.now().getTime() > exp) return false;
    const expected = await this.registry.crypto.hmacSha256(this.registry.secret, `${blobId}:${action}:${exp}`);
    return this.registry.crypto.timingSafeEqual(expected, sig);
  }

  expectedUploadBytes(blobId: string): Promise<bigint | undefined> {
    return this.registry.coordinator.run((db) => {
      const row = db.prepare('SELECT byte_size FROM blob WHERE blob_id = ?').get(blobId) as { byte_size: string } | undefined;
      return row === undefined ? undefined : BigInt(row.byte_size);
    });
  }

  writeContent(blobId: string, data: Uint8Array): Promise<BlobWriteResult> {
    return this.registry.coordinator.run(async (db) => {
      const row = db.prepare('SELECT * FROM blob WHERE blob_id = ?').get(blobId) as BlobRow | undefined;
      if (row === undefined) return { ok: false, reason: 'unknown blobId' };
      if (BigInt(data.length) !== BigInt(row.byte_size)) {
        return { ok: false, reason: `size mismatch: declared ${row.byte_size}, received ${data.length}` };
      }
      if (await this.registry.crypto.sha256(data) !== row.content_hash) {
        return { ok: false, reason: 'contentHash mismatch' };
      }
      db.prepare('UPDATE blob SET data = ?, uploaded = 1 WHERE blob_id = ?').run(data, blobId);
      return { ok: true };
    });
  }

  readContent(blobId: string): Promise<BlobReadResult | undefined> {
    return this.registry.coordinator.run((db) => {
      const row = db.prepare('SELECT * FROM blob WHERE blob_id = ?').get(blobId) as BlobRow | undefined;
      if (row === undefined || !row.uploaded || row.data === null) return undefined;
      const data = new Uint8Array(row.data.buffer, row.data.byteOffset, row.data.byteLength);
      return { ok: true, content: { data, contentType: row.content_type } };
    });
  }
}

/** Mixed embedded composition: eight durable interfaces, every other port unchanged in-memory. */
export function createSqliteEmbeddedStores(
  options: SqliteEmbeddedStoreOptions,
  dependencies: { readonly clock: Clock; readonly crypto: CloudCrypto; readonly wake?: WakeConsumer },
): SqliteEmbeddedStores {
  const coordinator = new SqliteCoordinator(options.path, options.migration, dependencies.wake);
  const ledger = new InMemoryStorageLedger(dependencies.clock);
  const objects = new SqliteObjectStore(coordinator, dependencies.clock, ledger);
  const quota = new InMemoryQuotaStore(dependencies.clock, objects, ledger);
  const mailbox = new SqliteMailboxStore(coordinator, dependencies.clock, quota);
  const tasks = new SqliteTaskAttemptStore(coordinator, dependencies.clock);
  const cancellations = new SqliteTaskCancellationStore(coordinator, dependencies.clock, quota);
  const registry = new SqliteBlobRegistry(
    coordinator,
    dependencies.clock,
    dependencies.crypto,
    options.urlTtlMs ?? DEFAULT_BLOB_URL_TTL_MS,
  );
  const blobs = new SqliteCloudBlobStore(registry);
  const blobContentProxy = new SqliteBlobContentProxy(registry);

  const core: CoreStores = {
    board: new InMemoryBoardStore(dependencies.clock),
    truth: new InMemoryTruthStore(dependencies.clock),
    presence: new InMemoryPresenceStore(dependencies.clock),
    skillPacks: new InMemorySkillPackStore(),
    mailbox,
    objects,
    quota,
  };
  // Activity and Agent message drafts remain ephemeral in this composition.
  const inMemoryCloud = createInMemoryCloudStores(
    dependencies.clock,
    dependencies.crypto,
    objects,
    mailbox,
    createInMemoryBlobBytes(dependencies.clock, dependencies.crypto),
  );
  const devices = new SqliteDeviceDirectory(coordinator);
  const pairing = new InMemoryPairingCodeStore(dependencies.clock, devices);
  const cloud: CloudStores = {
    ...inMemoryCloud.stores,
    devices,
    pairingCodes: { issue: pairing.issue.bind(pairing), collectExpired: pairing.collectExpired.bind(pairing) },
    pairing: { redeemAndRegister: pairing.redeemAndRegister.bind(pairing) },
    tasks,
    receipts: new SqliteRequestReceiptStore(coordinator, dependencies.clock),
    cancellations,
    blobs,
  };
  const e2eeMember = new SqliteE2eeMemberStore(coordinator, dependencies.clock);
  return {
    core,
    cloud,
    blobContentProxy,
    e2eeMember,
    proofReceiptAuthority: { collectExpired: (tenant, input) => e2eeMember.collectExpiredProofReceipts(tenant, input) },
    wakes: tenant => new SqliteWakeStore(coordinator, tenant),
    close: () => coordinator.close(),
  };
}
