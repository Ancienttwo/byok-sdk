/** In-memory conformance implementation for the one-way hosted memory projection ports. */
import type { Clock, TenantId } from '@byok-sdk/core';
import {
  AgentMemoryProjectionMutationSchema,
  AgentMemoryProjectionEraseResultSchema,
  AgentMemoryProjectionReceiptSchema,
  AGENT_MEMORY_PROJECTION_MAX_ORDERING_VALUE,
  type AgentMemoryProjectionEraseResult,
  type AgentMemoryProjectionMeteringReceipt,
  type AgentMemoryProjectionReceipt,
} from '@byok-sdk/protocol';
import type {
  AgentMemoryProjectionAuthorization,
  AgentMemoryProjectionAuthorizer,
  AgentMemoryProjectionAuthorizerInput,
  AgentMemoryProjectionCommitInput,
  AgentMemoryProjectionStore,
} from '../../agent-memory-projection';
import type { CloudCrypto } from '../../crypto/port';
import { ByokCloudError } from '../../errors';

function agentKey(tenantId: TenantId, agentId: string): string {
  return `${tenantId}\u0000${agentId}`;
}

function receiptKey(input: AgentMemoryProjectionCommitInput): string {
  const { mutation } = input;
  return `${agentKey(input.tenantId, mutation.agentRef.agentId)}\u0000${mutation.writerEpoch}\u0000${mutation.sourceSeq}`;
}

function sameMutationReceipt(receipt: AgentMemoryProjectionReceipt, input: AgentMemoryProjectionCommitInput): boolean {
  const { mutation } = input;
  return (
    receipt.tenantId === input.tenantId &&
    receipt.deviceId === input.deviceId &&
    receipt.taskId === mutation.taskId &&
    receipt.agentRef.agentId === mutation.agentRef.agentId &&
    receipt.agentRef.profileRevision === mutation.agentRef.profileRevision &&
    receipt.sessionRef === mutation.sessionRef &&
    receipt.runtimeId === mutation.runtimeId &&
    receipt.grantRef === mutation.grantRef &&
    receipt.writerEpoch === mutation.writerEpoch &&
    receipt.sourceSeq === mutation.sourceSeq &&
    receipt.mutationId === mutation.mutationId &&
    receipt.policyRevision === mutation.policyRevision &&
    receipt.redactedHash === mutation.snapshot.redactedHash &&
    receipt.redactedByteCount === mutation.snapshot.redactedByteCount
  );
}

interface ProjectionHead {
  readonly writerEpoch: number;
  readonly sourceSeq: number;
}

interface StoredSnapshot {
  readonly redactedBytes: Uint8Array;
  readonly redactedHash: string;
  readonly redactedByteCount: number;
}

/**
 * Reference transaction semantics: current snapshot bytes and immutable
 * metering receipt advance in the same serialized mutation. Receipts retain
 * metadata only, never a body.
 */
export class InMemoryAgentMemoryProjectionStore implements AgentMemoryProjectionStore {
  readonly #clock: Clock;
  readonly #crypto: CloudCrypto;
  readonly #heads = new Map<string, ProjectionHead>();
  readonly #snapshots = new Map<string, StoredSnapshot>();
  readonly #receipts = new Map<string, AgentMemoryProjectionReceipt>();
  /** Minimum legal future epoch after server-side erasure; contains no body. */
  readonly #eraseFences = new Map<string, number>();
  readonly #mutationTails = new Map<string, Promise<void>>();

  constructor(clock: Clock, crypto: CloudCrypto) {
    this.#clock = clock;
    this.#crypto = crypto;
  }

  async commit(input: AgentMemoryProjectionCommitInput): Promise<AgentMemoryProjectionReceipt> {
    const mutation = AgentMemoryProjectionMutationSchema.parse(input.mutation);
    if (input.redactedBytes.byteLength !== mutation.snapshot.redactedByteCount) {
      throw new ByokCloudError(
        'agent_memory_projection_hash_mismatch',
        'Decoded redacted snapshot bytes do not match redactedByteCount.',
      );
    }
    const hash = await this.#crypto.sha256(input.redactedBytes);
    if (hash !== mutation.snapshot.redactedHash) {
      throw new ByokCloudError(
        'agent_memory_projection_hash_mismatch',
        'Decoded redacted snapshot bytes do not match redactedHash.',
      );
    }

    const exactInput = { ...input, mutation };
    const key = agentKey(input.tenantId, mutation.agentRef.agentId);
    return this.#mutate(key, () => {
      const prior = this.#receipts.get(receiptKey(exactInput));
      if (prior !== undefined) {
        if (!sameMutationReceipt(prior, exactInput)) {
          throw new ByokCloudError(
            'agent_memory_projection_replay_mismatch',
            'A memory projection epoch and source sequence already names a different immutable mutation.',
          );
        }
        return AgentMemoryProjectionReceiptSchema.parse({ ...prior, outcome: 'idempotent' });
      }

      const fence = this.#eraseFences.get(key);
      if (fence !== undefined && mutation.writerEpoch < fence) {
        throw new ByokCloudError('agent_memory_projection_erased_epoch', 'The memory projection writerEpoch was erased and cannot be replayed.');
      }
      const head = this.#heads.get(key);
      if (head === undefined) {
        if (mutation.sourceSeq !== 1) {
          throw new ByokCloudError(
            'agent_memory_projection_sequence_gap',
            'The first memory projection mutation must use sourceSeq 1.',
          );
        }
      } else if (mutation.writerEpoch < head.writerEpoch) {
        throw new ByokCloudError('agent_memory_projection_stale_epoch', 'The memory projection writerEpoch is stale.');
      } else if (mutation.writerEpoch > head.writerEpoch) {
        if (mutation.sourceSeq !== 1) {
          throw new ByokCloudError(
            'agent_memory_projection_sequence_gap',
            'A new memory projection writerEpoch must start at sourceSeq 1.',
          );
        }
      } else if (mutation.sourceSeq !== head.sourceSeq + 1) {
        throw new ByokCloudError(
          'agent_memory_projection_sequence_gap',
          'A memory projection mutation must advance sourceSeq exactly by one.',
        );
      }

      const recordedAt = this.#clock.now().toISOString();
      const metering: AgentMemoryProjectionMeteringReceipt = {
        meteringReceiptId: this.#crypto.randomUuid(),
        acceptedRedactedBytes: mutation.snapshot.redactedByteCount,
        recordedAt,
      };
      const receipt = AgentMemoryProjectionReceiptSchema.parse({
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
        metering,
      });

      this.#snapshots.set(key, {
        redactedBytes: input.redactedBytes.slice(),
        redactedHash: mutation.snapshot.redactedHash,
        redactedByteCount: mutation.snapshot.redactedByteCount,
      });
      this.#heads.set(key, { writerEpoch: mutation.writerEpoch, sourceSeq: mutation.sourceSeq });
      this.#receipts.set(receiptKey(exactInput), receipt);
      return receipt;
    });
  }

  async erase(input: { readonly tenantId: TenantId; readonly agentId: string }): Promise<AgentMemoryProjectionEraseResult> {
    const key = agentKey(input.tenantId, input.agentId);
    return this.#mutate(key, () => {
      const priorHeadEpoch = this.#heads.get(key)?.writerEpoch ?? 0;
      const nextWriterEpoch = Math.max(this.#eraseFences.get(key) ?? 1, priorHeadEpoch + 1);
      if (nextWriterEpoch > AGENT_MEMORY_PROJECTION_MAX_ORDERING_VALUE) {
        throw new ByokCloudError('agent_memory_projection_epoch_exhausted', 'The memory projection writerEpoch cannot advance after erase.');
      }
      this.#heads.delete(key);
      this.#snapshots.delete(key);
      const prefix = `${key}\u0000`;
      for (const receiptKeyValue of this.#receipts.keys()) {
        if (receiptKeyValue.startsWith(prefix)) this.#receipts.delete(receiptKeyValue);
      }
      this.#eraseFences.set(key, nextWriterEpoch);
      return AgentMemoryProjectionEraseResultSchema.parse({ nextWriterEpoch });
    });
  }

  async #mutate<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.#mutationTails.get(key) ?? Promise.resolve();
    const result = previous.then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#mutationTails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.#mutationTails.get(key) === tail) this.#mutationTails.delete(key);
    }
  }
}

/** Test/reference authorizer whose grant registry demonstrates revocation without model booleans. */
export class InMemoryAgentMemoryProjectionAuthorizer implements AgentMemoryProjectionAuthorizer {
  readonly #grants = new Map<string, AgentMemoryProjectionAuthorizerInput>();

  grant(input: AgentMemoryProjectionAuthorizerInput): void {
    this.#grants.set(
      `${input.tenantId}\u0000${input.grantRef}\u0000${input.writerEpoch}`,
      { ...input, agentRef: { ...input.agentRef } },
    );
  }

  async authorize(input: AgentMemoryProjectionAuthorizerInput): Promise<AgentMemoryProjectionAuthorization> {
    const grant = this.#grants.get(`${input.tenantId}\u0000${input.grantRef}\u0000${input.writerEpoch}`);
    if (
      grant === undefined ||
      grant.deviceId !== input.deviceId ||
      grant.taskId !== input.taskId ||
      grant.agentRef.agentId !== input.agentRef.agentId ||
      grant.agentRef.profileRevision !== input.agentRef.profileRevision ||
      grant.sessionRef !== input.sessionRef ||
      grant.runtimeId !== input.runtimeId ||
      grant.writerEpoch !== input.writerEpoch ||
      grant.policyRevision !== input.policyRevision
    ) return { outcome: 'denied', reasonCode: 'grant_not_authorized' };
    return { outcome: 'authorized' };
  }

  async revoke(input: { readonly tenantId: TenantId; readonly agentId: string }): Promise<void> {
    for (const [key, grant] of this.#grants) {
      if (grant.tenantId === input.tenantId && grant.agentRef.agentId === input.agentId) this.#grants.delete(key);
    }
  }
}
