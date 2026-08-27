/**
 * Postgres authority for the optional, one-way hosted Agent-memory projection.
 *
 * The only stored body is the latest accepted redacted snapshot. Immutable
 * receipt rows retain the complete non-body replay binding and byte metering so
 * an old exact retry is still provable after the head advances or an epoch is
 * superseded. Neither table has a raw-source hash, cwd, path, or audit body.
 */
import {
  type AgentMemoryProjectionCommitInput,
  type AgentMemoryProjectionEraseResult,
  type AgentMemoryProjectionReceipt,
  type AgentMemoryProjectionStore,
  ByokCloudError,
  type CloudCrypto,
} from '@byok-sdk/cloud';
import {
  AgentMemoryProjectionMutationSchema,
  AgentMemoryProjectionEraseResultSchema,
  AgentMemoryProjectionReceiptSchema,
  AGENT_MEMORY_PROJECTION_MAX_ORDERING_VALUE,
  AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES,
} from '@byok-sdk/protocol';
import type { Clock, TenantId } from '@byok-sdk/core';
import type { Pool, PoolClient } from 'pg';

export interface PostgresAgentMemoryProjectionStoreOptions {
  readonly pool: Pool;
  readonly clock: Clock;
  /** The same Worker-safe crypto authority used by the hosting cloud composition. */
  readonly crypto: Pick<CloudCrypto, 'randomUuid' | 'sha256'>;
}

interface ProjectionHeadRow {
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly writer_epoch: number;
  readonly source_seq: number;
}
interface EraseFenceRow { readonly next_writer_epoch: number; }

interface MeteringReceiptRow {
  readonly tenant_id: string;
  readonly agent_id: string;
  readonly writer_epoch: number;
  readonly source_seq: number;
  readonly mutation_id: string;
  readonly device_id: string;
  readonly task_id: string;
  readonly agent_profile_revision: string;
  readonly session_ref: string;
  readonly runtime_id: string;
  readonly grant_ref: string;
  readonly policy_revision: string;
  readonly redacted_hash: string;
  readonly redacted_byte_count: number;
  readonly metering_receipt_id: string;
  readonly recorded_at: Date;
}

const RECEIPT_COLUMNS = [
  'tenant_id',
  'agent_id',
  'writer_epoch',
  'source_seq',
  'mutation_id',
  'device_id',
  'task_id',
  'agent_profile_revision',
  'session_ref',
  'runtime_id',
  'grant_ref',
  'policy_revision',
  'redacted_hash',
  'redacted_byte_count',
  'metering_receipt_id',
  'recorded_at',
].join(', ');

/**
 * A transaction-scoped Postgres projection store. The per-source advisory lock
 * closes the empty-head race without creating a separate lock row or making a
 * tenant-wide writer bottleneck; erase takes the identical lock.
 */
export class PostgresAgentMemoryProjectionStore implements AgentMemoryProjectionStore {
  readonly #pool: Pool;
  readonly #clock: Clock;
  readonly #crypto: Pick<CloudCrypto, 'randomUuid' | 'sha256'>;

  constructor(options: PostgresAgentMemoryProjectionStoreOptions) {
    this.#pool = options.pool;
    this.#clock = options.clock;
    this.#crypto = options.crypto;
  }

  async commit(input: AgentMemoryProjectionCommitInput): Promise<AgentMemoryProjectionReceipt> {
    const mutation = AgentMemoryProjectionMutationSchema.parse(input.mutation);
    await this.#assertRedactedSnapshot(
      input.redactedBytes,
      mutation.snapshot.redactedBytes,
      mutation.snapshot.redactedByteCount,
      mutation.snapshot.redactedHash,
    );

    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await lockAgentMutation(client, input.tenantId, mutation.agentRef.agentId);

      const receipt = await this.#readReceipt(client, input.tenantId, mutation.agentRef.agentId, mutation.writerEpoch, mutation.sourceSeq);
      if (receipt !== undefined) {
        if (!sameReceiptBinding(receipt, input, mutation)) {
          throw replayMismatch();
        }
        await client.query('COMMIT');
        return toReceipt(receipt, 'idempotent');
      }

      // A mutation id is a distinct immutable identity within one epoch. Check
      // it before sequence acceptance so SQL uniqueness is never the behavior
      // oracle and a reused id cannot masquerade as a database failure.
      const existingMutation = await this.#readReceiptByMutationId(
        client,
        input.tenantId,
        mutation.agentRef.agentId,
        mutation.writerEpoch,
        mutation.mutationId,
      );
      if (existingMutation !== undefined) throw replayMismatch();

      const head = await this.#readHeadForUpdate(client, input.tenantId, mutation.agentRef.agentId);
      const fence = await this.#readEraseFenceForUpdate(client, input.tenantId, mutation.agentRef.agentId);
      assertNextMutation(head, fence, mutation.writerEpoch, mutation.sourceSeq);

      const now = this.#clock.now();
      const meteringReceiptId = this.#crypto.randomUuid();
      await client.query(
        `INSERT INTO agent_memory_projection_metering_receipt (${RECEIPT_COLUMNS})
         VALUES ($1, $2, $3, $4, $5::uuid, $6, $7, $8, $9, $10, $11, $12, $13, $14::integer, $15::uuid, $16)`,
        [
          input.tenantId,
          mutation.agentRef.agentId,
          mutation.writerEpoch,
          mutation.sourceSeq,
          mutation.mutationId,
          input.deviceId,
          mutation.taskId,
          mutation.agentRef.profileRevision,
          mutation.sessionRef,
          mutation.runtimeId,
          mutation.grantRef,
          mutation.policyRevision,
          mutation.snapshot.redactedHash,
          mutation.snapshot.redactedByteCount,
          meteringReceiptId,
          now,
        ],
      );

      await client.query(
        `INSERT INTO agent_memory_projection_head (
           tenant_id, agent_id, writer_epoch, source_seq, mutation_id,
           device_id, task_id, agent_profile_revision, session_ref, runtime_id,
           grant_ref, policy_revision, redacted_hash, redacted_snapshot,
           redacted_byte_count, committed_at
         ) VALUES (
           $1, $2, $3, $4, $5::uuid,
           $6, $7, $8, $9, $10,
           $11, $12, $13, decode($14, 'base64'),
           $15::integer, $16
         )
         ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
           writer_epoch = EXCLUDED.writer_epoch,
           source_seq = EXCLUDED.source_seq,
           mutation_id = EXCLUDED.mutation_id,
           device_id = EXCLUDED.device_id,
           task_id = EXCLUDED.task_id,
           agent_profile_revision = EXCLUDED.agent_profile_revision,
           session_ref = EXCLUDED.session_ref,
           runtime_id = EXCLUDED.runtime_id,
           grant_ref = EXCLUDED.grant_ref,
           policy_revision = EXCLUDED.policy_revision,
           redacted_hash = EXCLUDED.redacted_hash,
           redacted_snapshot = EXCLUDED.redacted_snapshot,
           redacted_byte_count = EXCLUDED.redacted_byte_count,
           committed_at = EXCLUDED.committed_at`,
        [
          input.tenantId,
          mutation.agentRef.agentId,
          mutation.writerEpoch,
          mutation.sourceSeq,
          mutation.mutationId,
          input.deviceId,
          mutation.taskId,
          mutation.agentRef.profileRevision,
          mutation.sessionRef,
          mutation.runtimeId,
          mutation.grantRef,
          mutation.policyRevision,
          mutation.snapshot.redactedHash,
          toBase64(input.redactedBytes),
          mutation.snapshot.redactedByteCount,
          now,
        ],
      );

      await client.query('COMMIT');
      return AgentMemoryProjectionReceiptSchema.parse({
        outcome: 'accepted',
        tenantId: input.tenantId,
        deviceId: input.deviceId,
        taskId: mutation.taskId,
        agentRef: mutation.agentRef,
        sessionRef: mutation.sessionRef,
        runtimeId: mutation.runtimeId,
        grantRef: mutation.grantRef,
        writerEpoch: mutation.writerEpoch,
        sourceSeq: mutation.sourceSeq,
        mutationId: mutation.mutationId,
        policyRevision: mutation.policyRevision,
        redactedHash: mutation.snapshot.redactedHash,
        redactedByteCount: mutation.snapshot.redactedByteCount,
        metering: {
          meteringReceiptId,
          acceptedRedactedBytes: mutation.snapshot.redactedByteCount,
          recordedAt: now.toISOString(),
        },
      });
    } catch (cause) {
      await rollback(client);
      throw cause;
    } finally {
      client.release();
    }
  }

  /** Delete body/receipts but retain a body-free epoch fence under one source lock. */
  async erase(input: { readonly tenantId: TenantId; readonly agentId: string }): Promise<AgentMemoryProjectionEraseResult> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await lockAgentMutation(client, input.tenantId, input.agentId);
      const head = await this.#readHeadForUpdate(client, input.tenantId, input.agentId);
      const fence = await this.#readEraseFenceForUpdate(client, input.tenantId, input.agentId);
      const nextWriterEpoch = Math.max(fence?.next_writer_epoch ?? 1, (head?.writer_epoch ?? 0) + 1);
      if (nextWriterEpoch > AGENT_MEMORY_PROJECTION_MAX_ORDERING_VALUE) {
        throw new ByokCloudError('agent_memory_projection_epoch_exhausted', 'The memory projection writerEpoch cannot advance after erase.');
      }
      await client.query(
        'DELETE FROM agent_memory_projection_metering_receipt WHERE tenant_id = $1 AND agent_id = $2',
        [input.tenantId, input.agentId],
      );
      await client.query(
        'DELETE FROM agent_memory_projection_head WHERE tenant_id = $1 AND agent_id = $2',
        [input.tenantId, input.agentId],
      );
      await client.query(
        `INSERT INTO agent_memory_projection_erase_fence (tenant_id, agent_id, next_writer_epoch, erased_at)
         VALUES ($1, $2, $3::integer, $4)
         ON CONFLICT (tenant_id, agent_id) DO UPDATE SET
           next_writer_epoch = GREATEST(agent_memory_projection_erase_fence.next_writer_epoch, EXCLUDED.next_writer_epoch),
           erased_at = EXCLUDED.erased_at`,
        [input.tenantId, input.agentId, nextWriterEpoch, this.#clock.now()],
      );
      await client.query('COMMIT');
      return AgentMemoryProjectionEraseResultSchema.parse({ nextWriterEpoch });
    } catch (cause) {
      await rollback(client);
      throw cause;
    } finally {
      client.release();
    }
  }

  async #assertRedactedSnapshot(
    bytes: Uint8Array,
    portableBody: string,
    byteCount: number,
    expectedHash: string,
  ): Promise<void> {
    if (bytes.byteLength !== byteCount || bytes.byteLength > AGENT_MEMORY_PROJECTION_MAX_REDACTED_BYTES) {
      throw hashMismatch('Decoded redacted snapshot bytes do not match redactedByteCount.');
    }
    if (portableBody !== toBase64Url(bytes)) {
      throw hashMismatch('Decoded redacted snapshot bytes do not match the portable redactedBytes body.');
    }
    if (await this.#crypto.sha256(bytes) !== expectedHash) {
      throw hashMismatch('Decoded redacted snapshot bytes do not match redactedHash.');
    }
  }

  async #readHeadForUpdate(client: PoolClient, tenant: TenantId, agentId: string): Promise<ProjectionHeadRow | undefined> {
    const result = await client.query<ProjectionHeadRow>(
      `SELECT tenant_id, agent_id, writer_epoch, source_seq
         FROM agent_memory_projection_head
        WHERE tenant_id = $1 AND agent_id = $2
        FOR UPDATE`,
      [tenant, agentId],
    );
    return result.rows[0];
  }

  async #readEraseFenceForUpdate(client: PoolClient, tenant: TenantId, agentId: string): Promise<EraseFenceRow | undefined> {
    const result = await client.query<EraseFenceRow>(
      `SELECT next_writer_epoch
         FROM agent_memory_projection_erase_fence
        WHERE tenant_id = $1 AND agent_id = $2
        FOR UPDATE`,
      [tenant, agentId],
    );
    return result.rows[0];
  }

  async #readReceipt(
    client: PoolClient,
    tenant: TenantId,
    agentId: string,
    writerEpoch: number,
    sourceSeq: number,
  ): Promise<MeteringReceiptRow | undefined> {
    const result = await client.query<MeteringReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS}
         FROM agent_memory_projection_metering_receipt
        WHERE tenant_id = $1 AND agent_id = $2 AND writer_epoch = $3 AND source_seq = $4`,
      [tenant, agentId, writerEpoch, sourceSeq],
    );
    return result.rows[0];
  }

  async #readReceiptByMutationId(
    client: PoolClient,
    tenant: TenantId,
    agentId: string,
    writerEpoch: number,
    mutationId: string,
  ): Promise<MeteringReceiptRow | undefined> {
    const result = await client.query<MeteringReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS}
         FROM agent_memory_projection_metering_receipt
        WHERE tenant_id = $1 AND agent_id = $2 AND writer_epoch = $3 AND mutation_id = $4::uuid`,
      [tenant, agentId, writerEpoch, mutationId],
    );
    return result.rows[0];
  }
}

/** Build the runtime-safe Postgres implementation of the optional cloud port. */
export function createPostgresAgentMemoryProjectionStore(
  options: PostgresAgentMemoryProjectionStoreOptions,
): AgentMemoryProjectionStore {
  return new PostgresAgentMemoryProjectionStore(options);
}

function assertNextMutation(
  head: ProjectionHeadRow | undefined,
  fence: EraseFenceRow | undefined,
  writerEpoch: number,
  sourceSeq: number,
): void {
  if (fence !== undefined && writerEpoch < fence.next_writer_epoch) {
    throw erasedEpoch();
  }
  if (head === undefined) {
    if (sourceSeq !== 1) throw sequenceGap('The first memory projection mutation must use sourceSeq 1.');
    return;
  }
  if (writerEpoch < head.writer_epoch) {
    throw new ByokCloudError('agent_memory_projection_stale_epoch', 'The memory projection writerEpoch is stale.');
  }
  if (writerEpoch > head.writer_epoch) {
    if (sourceSeq !== 1) throw sequenceGap('A new memory projection writerEpoch must start at sourceSeq 1.');
    return;
  }
  if (sourceSeq !== head.source_seq + 1) {
    throw sequenceGap('A memory projection mutation must advance sourceSeq exactly by one.');
  }
}

function sameReceiptBinding(
  receipt: MeteringReceiptRow,
  input: AgentMemoryProjectionCommitInput,
  mutation: ReturnType<typeof AgentMemoryProjectionMutationSchema.parse>,
): boolean {
  return (
    receipt.tenant_id === input.tenantId &&
    receipt.agent_id === mutation.agentRef.agentId &&
    receipt.device_id === input.deviceId &&
    receipt.task_id === mutation.taskId &&
    receipt.agent_profile_revision === mutation.agentRef.profileRevision &&
    receipt.session_ref === mutation.sessionRef &&
    receipt.runtime_id === mutation.runtimeId &&
    receipt.grant_ref === mutation.grantRef &&
    receipt.writer_epoch === mutation.writerEpoch &&
    receipt.source_seq === mutation.sourceSeq &&
    receipt.mutation_id === mutation.mutationId &&
    receipt.policy_revision === mutation.policyRevision &&
    receipt.redacted_hash === mutation.snapshot.redactedHash &&
    receipt.redacted_byte_count === mutation.snapshot.redactedByteCount
  );
}

function toReceipt(row: MeteringReceiptRow, outcome: 'accepted' | 'idempotent'): AgentMemoryProjectionReceipt {
  return AgentMemoryProjectionReceiptSchema.parse({
    outcome,
    tenantId: row.tenant_id,
    deviceId: row.device_id,
    taskId: row.task_id,
    agentRef: { agentId: row.agent_id, profileRevision: row.agent_profile_revision },
    sessionRef: row.session_ref,
    runtimeId: row.runtime_id,
    grantRef: row.grant_ref,
    writerEpoch: row.writer_epoch,
    sourceSeq: row.source_seq,
    mutationId: row.mutation_id,
    policyRevision: row.policy_revision,
    redactedHash: row.redacted_hash,
    redactedByteCount: row.redacted_byte_count,
    metering: {
      meteringReceiptId: row.metering_receipt_id,
      acceptedRedactedBytes: row.redacted_byte_count,
      recordedAt: row.recorded_at.toISOString(),
    },
  });
}

async function lockAgentMutation(client: PoolClient, tenant: TenantId, agentId: string): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended(length($1)::text || ':' || $1 || length($2)::text || ':' || $2, 0)
     )`,
    [tenant, agentId],
  );
}

function hashMismatch(message: string): ByokCloudError {
  return new ByokCloudError('agent_memory_projection_hash_mismatch', message);
}

function sequenceGap(message: string): ByokCloudError {
  return new ByokCloudError('agent_memory_projection_sequence_gap', message);
}

function erasedEpoch(): ByokCloudError {
  return new ByokCloudError('agent_memory_projection_erased_epoch', 'The memory projection writerEpoch was erased and cannot be replayed.');
}

function replayMismatch(): ByokCloudError {
  return new ByokCloudError(
    'agent_memory_projection_replay_mismatch',
    'A memory projection epoch and source sequence already names a different immutable mutation.',
  );
}

function toBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024)));
  }
  return btoa(chunks.join(''));
}

function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {}
}
