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
  type AgentMemoryProjectionReceipt,
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

export type AgentMemoryProjectionAuthorization =
  | { readonly outcome: 'authorized' }
  | { readonly outcome: 'denied'; readonly reasonCode: string };

/**
 * Embedder-owned consent and grant authority. A model never provides a
 * consent flag: it presents only an opaque grantRef, which this port binds to
 * the authenticated tenant/device/task/session/runtime/writer-epoch identity.
 */
export interface AgentMemoryProjectionAuthorizer {
  authorize(input: AgentMemoryProjectionAuthorizerInput): Promise<AgentMemoryProjectionAuthorization>;
  /** Revoke hosted-projection authorization before the server asks the store to erase. */
  revoke(input: { readonly tenantId: TenantId; readonly agentId: string }): Promise<void>;
}

/** Input to the durable projection store. `redactedBytes` has already been decoded from the portable base64url body. */
export interface AgentMemoryProjectionCommitInput {
  readonly tenantId: TenantId;
  readonly deviceId: string;
  readonly mutation: AgentMemoryProjectionMutation;
  readonly redactedBytes: Uint8Array;
}

/**
 * Durable hosted snapshot and immutable metering receipt authority.
 *
 * `commit` must hash the supplied bytes and compare them with the portable
 * redacted hash before every write. It accepts a new epoch only at sourceSeq
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
