/**
 * Optional hosted Agent-memory projection ports and reference store.
 *
 * Local `MEMORY.md` and `notes/` remain the sole authoring authority. This
 * module only accepts a redacted full snapshot after a host-owned authorizer
 * grants the exact authenticated task identity; it never offers a read,
 * import, merge, history, RAG, or product-fact surface.
 */
import type { TenantId } from '@byok-sdk/core';
import {
  type AgentMemoryProjectionMeteringReceipt,
  type AgentMemoryProjectionMutation,
  type AgentMemoryProjectionPlainMutation,
  type AgentMemoryProjectionReceipt,
  type AgentMemoryProjectionSealedMutation,
  type AgentMemoryProjectionEraseResult,
} from '@byok-sdk/protocol';

export type {
  AgentMemoryProjectionMeteringReceipt,
  AgentMemoryProjectionMutation,
  AgentMemoryProjectionReceipt,
  AgentMemoryProjectionEraseResult,
} from '@byok-sdk/protocol';

export interface AgentMemoryProjectionAuthorizerInput {
  readonly tenantId: TenantId;
  readonly deviceId: string;
  readonly taskId: string;
  readonly agentRef: AgentMemoryProjectionMutation['agentRef'];
  readonly sessionRef: AgentMemoryProjectionMutation['sessionRef'];
  readonly runtimeId: AgentMemoryProjectionMutation['runtimeId'];
  readonly grantRef: AgentMemoryProjectionMutation['grantRef'];
  /** Server-granted active writer epoch; a client may not upgrade it unilaterally. */
  readonly writerEpoch: AgentMemoryProjectionMutation['writerEpoch'];
  readonly policyRevision: AgentMemoryProjectionMutation['policyRevision'];
}

/** The Agent memory scope a grant seals its snapshots under (#1045 C4). */
export interface AgentMemoryProjectionSealing {
  readonly scopeId: string;
  readonly epoch: number;
}

/**
 * An authorized result carries the `sealing` of the grant the Host issued:
 * the authorizer is the authority for which form the snapshot must take.
 */
export type AgentMemoryProjectionAuthorization =
  | { readonly outcome: 'authorized'; readonly sealing?: AgentMemoryProjectionSealing }
  | { readonly outcome: 'denied'; readonly reasonCode: string };

/**
 * Embedder-owned consent and grant authority. A model never provides a
 * consent flag: it presents only an opaque grantRef, which this port binds to
 * the authenticated tenant/device/task/AgentRef/session/runtime/grant/policy
 * identity. The host must retain an exact historical permit until its
 * mutation is accepted, explicitly revoked, or superseded by a higher writer
 * epoch; reaching task terminal state alone must not implicitly delete it.
 */
export interface AgentMemoryProjectionAuthorizer {
  authorize(input: AgentMemoryProjectionAuthorizerInput): Promise<AgentMemoryProjectionAuthorization>;
  /** Revoke hosted-projection authorization before the server asks the store to erase. */
  revoke(input: { readonly tenantId: TenantId; readonly agentId: string }): Promise<void>;
}

/**
 * Input to the durable projection store. A plaintext snapshot carries
 * `redactedBytes`, already decoded from the portable base64url body. A sealed
 * snapshot carries only its sealed member, stored as received: the Host never
 * holds its plaintext or a plaintext hash.
 */
export type AgentMemoryProjectionCommitInput =
  | {
    readonly tenantId: TenantId;
    readonly deviceId: string;
    readonly mutation: AgentMemoryProjectionPlainMutation;
    readonly redactedBytes: Uint8Array;
  }
  | {
    readonly tenantId: TenantId;
    readonly deviceId: string;
    readonly mutation: AgentMemoryProjectionSealedMutation;
    readonly redactedBytes?: never;
  };

/**
 * Durable hosted snapshot and immutable metering receipt authority.
 *
 * For a plaintext snapshot, `commit` must hash the supplied bytes and compare
 * them with the portable redacted hash before every write; a sealed snapshot
 * is stored and metered by its padded length. An exact replay compares the
 * sealed member's `contentMac` and `paddedLength`. It accepts a new epoch only at sourceSeq
 * one, accepts same-epoch writes only gap-free, returns `idempotent` for an
 * exact replay, and rejects stale/gap/binding/hash mismatches. The accepted
 * snapshot and its metering receipt share one transaction boundary.
 */
export interface AgentMemoryProjectionStore {
  commit(input: AgentMemoryProjectionCommitInput): Promise<AgentMemoryProjectionReceipt>;
  /**
   * Server-side deletion leaves a body-free epoch fence. The host must mint a
   * later writer grant from `nextWriterEpoch`; no device/runtime is required.
   */
  erase(input: { readonly tenantId: TenantId; readonly agentId: string }): Promise<AgentMemoryProjectionEraseResult>;
}
