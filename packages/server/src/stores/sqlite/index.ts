import {
  ByokCoreError,
  CoreConflictError,
  InMemoryQuotaStore,
  assertCanonicalTimestamp,
  createInMemoryCoreStores,
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
  type MailboxRetentionInput,
  type MailboxRetentionResult,
  type MailboxStore,
  type ObjectCommitInput,
  type ObjectListQuery,
  type ObjectManifestEntry,
  type ObjectManifestInput,
  type ObjectReferenceInput,
  type ObjectStore,
  type StorageReservation,
  type TenantId,
} from '@byok-sdk/core';
import {
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
  type TaskAttempt,
  type TaskAttemptListQuery,
  type TaskAttemptPage,
  type TaskAttemptStatus,
  type TaskAttemptStore,
  type TaskCancellationMutation,
  type TaskCancellationRequest,
  type TaskCancellationStore,
} from '@byok-sdk/cloud';
import { byokBlobContentPath, type RuntimeCapabilities, type RuntimeId } from '@byok-sdk/protocol';
import type { DatabaseSync } from 'node:sqlite';
import {
  closeSqliteDatabaseAfterInitializationFailure,
  openSqliteDatabase,
  secureSqliteFilePermissions,
} from '../../sqlite-support';

const DEFAULT_MAILBOX_READ_LIMIT = 50;
const DEFAULT_OBJECT_LIST_LIMIT = 100;
const DEFAULT_BLOB_URL_TTL_MS = 15 * 60_000;
const SIGNING_SECRET_BYTES = 32;
const SQLITE_SCHEMA_VERSION = '1';

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
}

export interface SqliteEmbeddedStores {
  readonly core: CoreStores;
  readonly cloud: CloudStores;
  readonly blobContentProxy: BlobContentProxy;
  close(): Promise<void>;
}

/** One serialized owner for the synchronous SQLite handle and every transaction on it. */
class SqliteCoordinator {
  readonly db: DatabaseSync;
  #tail: Promise<void> = Promise.resolve();
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(path: string) {
    this.db = openSqliteDatabase(path);
    try {
      const hasMetadata = this.db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'byok_sqlite_meta'")
        .get() as { present: number } | undefined;
      if (hasMetadata !== undefined) {
        const schemaVersion = this.db
          .prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'")
          .get() as { value: string } | undefined;
        if (schemaVersion?.value !== SQLITE_SCHEMA_VERSION) {
          throw new Error(
            `Unsupported BYOK SQLite schema version ${JSON.stringify(schemaVersion?.value)}; ` +
              `this build requires ${SQLITE_SCHEMA_VERSION}`,
          );
        }
      }
      this.db.exec(SCHEMA);
      if (hasMetadata === undefined) {
        this.db
          .prepare("INSERT INTO byok_sqlite_meta (key, value) VALUES ('schema_version', ?)")
          .run(SQLITE_SCHEMA_VERSION);
      }
      secureSqliteFilePermissions(path);
    } catch (error) {
      closeSqliteDatabaseAfterInitializationFailure(
        this.db,
        error,
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

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = this.#tail.then(() => this.db.close());
    return this.#closePromise;
  }
}

interface TaskRow extends Record<string, unknown> {
  tenant_id: string;
  task_id: string;
  device_id: string;
  agent_ref_json: string | null;
  owner_device_id: string | null;
  claimed_runtime: string | null;
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
    assertTaskAttemptListLimit(query.limit);
    return this.coordinator.run((db) => {
      const rows = db.prepare(
        `SELECT * FROM task_attempt WHERE tenant_id = ? AND task_id > ?
         ORDER BY task_id COLLATE BINARY LIMIT ?`,
      ).all(tenant, query.cursor ?? '', query.limit + 1) as unknown as TaskRow[];
      const hasMore = rows.length > query.limit;
      const attempts = rows.slice(0, query.limit).map(taskRow);
      const last = attempts.at(-1);
      return { attempts, ...(hasMore && last !== undefined ? { nextCursor: last.taskId } : {}) };
    });
  }

  claim(
    tenant: TenantId,
    input: { taskId: string; deviceId: string; runtime?: RuntimeId; capabilities?: RuntimeCapabilities },
  ): Promise<TaskAttempt | undefined> {
    return this.coordinator.run((db) => {
      db.prepare(
        `UPDATE task_attempt SET owner_device_id = ?, claimed_runtime = ?, claimed_runtime_capabilities_json = ?,
          status = 'claimed', updated_at = ?
         WHERE tenant_id = ? AND task_id = ? AND owner_device_id IS NULL
           AND cancellation_requested_at IS NULL AND status = 'offered'`,
      ).run(
        input.deviceId,
        input.runtime ?? null,
        input.capabilities === undefined ? null : JSON.stringify(input.capabilities),
        this.#now(),
        tenant,
        input.taskId,
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

async function appendMailbox(
  db: DatabaseSync,
  clock: Clock,
  tenant: TenantId,
  input: MailboxAppendInput,
): Promise<MailboxMessage> {
  ensureMailboxCursor(db, clock, tenant, input.deviceId);
  const existing = db.prepare(
    `SELECT * FROM mailbox_message WHERE tenant_id = ? AND device_id = ? AND message_id = ?`,
  ).get(tenant, input.deviceId, input.messageId) as MailboxRow | undefined;
  if (existing !== undefined) return mailboxMessage(existing);
  const cursor = db.prepare(
    `SELECT next_seq FROM mailbox_cursor WHERE tenant_id = ? AND device_id = ?`,
  ).get(tenant, input.deviceId) as { next_seq: number };
  const seq = Number(cursor.next_seq);
  const materialized = await input.materialize(seq);
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
  constructor(private readonly coordinator: SqliteCoordinator, private readonly clock: Clock) {}

  append(tenant: TenantId, input: MailboxAppendInput): Promise<MailboxMessage> {
    return this.coordinator.transaction((db) => appendMailbox(db, this.clock, tenant, input));
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

  async collectRetired(tenant: TenantId, input: MailboxRetentionInput): Promise<MailboxRetentionResult> {
    assertCanonicalTimestamp(input.ackedBefore, 'ackedBefore');
    assertCanonicalTimestamp(input.expireUnackedBefore, 'expireUnackedBefore');
    return this.coordinator.transaction((db) => {
      const deviceClause = input.deviceId === undefined ? '' : ' AND device_id = ?';
      const params = input.deviceId === undefined ? [tenant] : [tenant, input.deviceId];
      const acked = db.prepare(
        `SELECT byte_size FROM mailbox_message
         WHERE tenant_id = ?${deviceClause} AND state = 'acked' AND appended_at < ?`,
      ).all(...params, input.ackedBefore) as unknown as Array<{ byte_size: string }>;
      const deleted = db.prepare(
        `DELETE FROM mailbox_message
         WHERE tenant_id = ?${deviceClause} AND state = 'acked' AND appended_at < ?`,
      ).run(...params, input.ackedBefore);
      const expired = db.prepare(
        `UPDATE mailbox_message SET state = 'expired'
         WHERE tenant_id = ?${deviceClause} AND state = 'pending' AND appended_at < ?`,
      ).run(...params, input.expireUnackedBefore);
      return {
        deletedCount: Number(deleted.changes),
        expiredCount: Number(expired.changes),
        releasedBytes: acked.reduce((sum, row) => sum + BigInt(row.byte_size), 0n),
      };
    });
  }
}

export class SqliteTaskCancellationStore implements TaskCancellationStore {
  constructor(private readonly coordinator: SqliteCoordinator, private readonly clock: Clock) {}

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

      const message = await appendMailbox(db, this.clock, tenant, {
        deviceId: existing.deviceId,
        messageId: input.proposedMessageId,
        materialize: (seq) => input.materialize(seq, input.proposedMessageId),
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
  constructor(private readonly coordinator: SqliteCoordinator, private readonly clock: Clock) {}

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

/** Mixed embedded composition: exactly six durable interfaces, every other port unchanged in-memory. */
export function createSqliteEmbeddedStores(
  options: SqliteEmbeddedStoreOptions,
  dependencies: { readonly clock: Clock; readonly crypto: CloudCrypto },
): SqliteEmbeddedStores {
  const coordinator = new SqliteCoordinator(options.path);
  const objects = new SqliteObjectStore(coordinator, dependencies.clock);
  const mailbox = new SqliteMailboxStore(coordinator, dependencies.clock);
  const tasks = new SqliteTaskAttemptStore(coordinator, dependencies.clock);
  const cancellations = new SqliteTaskCancellationStore(coordinator, dependencies.clock);
  const registry = new SqliteBlobRegistry(
    coordinator,
    dependencies.clock,
    dependencies.crypto,
    options.urlTtlMs ?? DEFAULT_BLOB_URL_TTL_MS,
  );
  const blobs = new SqliteCloudBlobStore(registry);
  const blobContentProxy = new SqliteBlobContentProxy(registry);

  const inMemoryCore = createInMemoryCoreStores({ clock: dependencies.clock }).stores;
  const core: CoreStores = {
    ...inMemoryCore,
    mailbox,
    objects,
    quota: new InMemoryQuotaStore(dependencies.clock, objects),
  };
  const inMemoryCloud = createInMemoryCloudStores(
    dependencies.clock,
    dependencies.crypto,
    objects,
    mailbox,
  );
  const cloud: CloudStores = {
    ...inMemoryCloud.stores,
    tasks,
    cancellations,
    blobs,
  };
  return { core, cloud, blobContentProxy, close: () => coordinator.close() };
}
