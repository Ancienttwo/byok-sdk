/** In-memory conformance implementation for the one-way hosted memory projection ports. */
import type { Clock, TenantId } from '@byok-sdk/core';
import {
  AgentMemoryProjectionMutationSchema,
  AgentMemoryProjectionEraseResultSchema,
  AgentMemoryProjectionReceiptSchema,
  AGENT_MEMORY_PROJECTION_MAX_ORDERING_VALUE,
  type AgentMemoryProjectionEraseResult,
  type AgentMemoryProjectionMutation,
  type AgentMemoryProjectionReceipt,
  type AgentMemoryProjectionSealedMutation,
} from '@byok-sdk/protocol';
import type {
  AgentMemoryProjectionAuthorization,
  AgentMemoryProjectionAuthorizer,
  AgentMemoryProjectionAuthorizerInput,
  AgentMemoryProjectionCommitInput,
  AgentMemoryProjectionSealing,
  AgentMemoryProjectionStore,
} from '../../agent-memory-projection';
import type { CloudCrypto } from '../../crypto/port';
import { ByokCloudError } from '../../errors';

function agentKey(tenantId: TenantId, agentId: string): string {
  return `${tenantId}\u0000${agentId}`;
}

function permitKey(input: AgentMemoryProjectionAuthorizerInput): string {
  // Keep every authenticated/granted identity component in the permit key.
  // In particular, task/session permits sharing a grantRef and writerEpoch
  // are distinct historical authorities and must coexist.
  return JSON.stringify([
    input.tenantId,
    input.deviceId,
    input.taskId,
    input.agentRef.agentId,
    input.agentRef.profileRevision,
    input.sessionRef,
    input.runtimeId,
    input.grantRef,
    input.writerEpoch,
    input.policyRevision,
  ]);
}

function receiptKey(tenantId: TenantId, mutation: AgentMemoryProjectionMutation): string {
  return `${agentKey(tenantId, mutation.agentRef.agentId)}\u0000${mutation.writerEpoch}\u0000${mutation.sourceSeq}`;
}

/** The content fields of a receipt: the redacted hash and size, or the sealed member's `contentMac` and padded length. */
function contentFields(mutation: AgentMemoryProjectionMutation): Readonly<Record<string, string | number>> {
  return mutation.sealed === undefined
    ? { redactedHash: mutation.snapshot.redactedHash, redactedByteCount: mutation.snapshot.redactedByteCount }
    : { contentMac: mutation.sealed.contentMac, paddedLength: mutation.sealed.paddedLength };
}

function sameMutationReceipt(
  receipt: AgentMemoryProjectionReceipt,
  tenantId: TenantId,
  deviceId: string,
  mutation: AgentMemoryProjectionMutation,
): boolean {
  const fields = receipt as unknown as Readonly<Record<string, unknown>>;
  return (
    receipt.tenantId === tenantId &&
    receipt.deviceId === deviceId &&
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
    Object.entries(contentFields(mutation)).every(([key, value]) => fields[key] === value)
  );
}

interface ProjectionHead {
  readonly writerEpoch: number;
  readonly sourceSeq: number;
}

/** The one stored body: the redacted bytes, or the sealed member as received. */
type StoredSnapshot =
  | { readonly redactedBytes: Uint8Array }
  | { readonly sealed: AgentMemoryProjectionSealedMutation['sealed'] };

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
    let snapshot: StoredSnapshot;
    if (mutation.sealed !== undefined) {
      snapshot = { sealed: mutation.sealed };
    } else {
      const redactedBytes = input.redactedBytes;
      if (redactedBytes === undefined || redactedBytes.byteLength !== mutation.snapshot.redactedByteCount) {
        throw new ByokCloudError(
          'agent_memory_projection_hash_mismatch',
          'Decoded redacted snapshot bytes do not match redactedByteCount.',
        );
      }
      if (await this.#crypto.sha256(redactedBytes) !== mutation.snapshot.redactedHash) {
        throw new ByokCloudError(
          'agent_memory_projection_hash_mismatch',
          'Decoded redacted snapshot bytes do not match redactedHash.',
        );
      }
      snapshot = { redactedBytes: redactedBytes.slice() };
    }

    const key = agentKey(input.tenantId, mutation.agentRef.agentId);
    return this.#mutate(key, () => {
      const prior = this.#receipts.get(receiptKey(input.tenantId, mutation));
      if (prior !== undefined) {
        if (!sameMutationReceipt(prior, input.tenantId, input.deviceId, mutation)) {
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

      const meteringReceiptId = this.#crypto.randomUuid();
      const recordedAt = this.#clock.now().toISOString();
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
        ...contentFields(mutation),
        metering: mutation.sealed === undefined
          ? { meteringReceiptId, acceptedRedactedBytes: mutation.snapshot.redactedByteCount, recordedAt }
          : { meteringReceiptId, acceptedPaddedBytes: mutation.sealed.paddedLength, recordedAt },
      });

      this.#snapshots.set(key, snapshot);
      this.#heads.set(key, { writerEpoch: mutation.writerEpoch, sourceSeq: mutation.sourceSeq });
      this.#receipts.set(receiptKey(input.tenantId, mutation), receipt);
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
  readonly #grants = new Map<string, AgentMemoryProjectionAuthorizerInput & { readonly sealing?: AgentMemoryProjectionSealing }>();
  /** Highest host-issued epoch observed for each tenant/Agent authority. */
  readonly #highestEpochs = new Map<string, number>();

  /** `sealing` names the Agent memory scope this grant's snapshots are sealed under (#1045 C4). */
  grant(input: AgentMemoryProjectionAuthorizerInput & { readonly sealing?: AgentMemoryProjectionSealing }): void {
    const key = agentKey(input.tenantId, input.agentRef.agentId);
    const highestEpoch = this.#highestEpochs.get(key);
    if (highestEpoch !== undefined && input.writerEpoch < highestEpoch) return;

    if (highestEpoch === undefined || input.writerEpoch > highestEpoch) {
      // An explicit writer handoff retires every older permit for this
      // tenant/Agent, including permits issued to another device or task.
      for (const [grantKey, grant] of this.#grants) {
        if (
          grant.tenantId === input.tenantId &&
          grant.agentRef.agentId === input.agentRef.agentId &&
          grant.writerEpoch < input.writerEpoch
        ) this.#grants.delete(grantKey);
      }
      this.#highestEpochs.set(key, input.writerEpoch);
    }

    // Equal-epoch permits are intentionally additive: historical task/session
    // replays retain their own exact authorization until accepted/revoked.
    this.#grants.set(permitKey(input), { ...input, agentRef: { ...input.agentRef } });
  }

  async authorize(input: AgentMemoryProjectionAuthorizerInput): Promise<AgentMemoryProjectionAuthorization> {
    const grant = this.#grants.get(permitKey(input));
    if (grant === undefined) return { outcome: 'denied', reasonCode: 'grant_not_authorized' };
    return grant.sealing === undefined ? { outcome: 'authorized' } : { outcome: 'authorized', sealing: grant.sealing };
  }

  async revoke(input: { readonly tenantId: TenantId; readonly agentId: string }): Promise<void> {
    for (const [key, grant] of this.#grants) {
      if (grant.tenantId === input.tenantId && grant.agentRef.agentId === input.agentId) this.#grants.delete(key);
    }
  }
}
