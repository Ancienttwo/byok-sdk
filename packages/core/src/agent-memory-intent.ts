/**
 * Host-approved Agent memory intent — the identity digest.
 *
 * One `operationDigest` binds an intent to the tenant and device it was
 * approved for and to its exact operation. A Host computes it at approval; a
 * device recomputes it with its OWN enrolled tenant and device ids, so an
 * intent released to another tenant or device, or with any identity or
 * operation field changed, can never match. The digest never covers content:
 * `targetRevision` (the body digest) binds the body instead.
 *
 * Canonicalization is the shared RFC 8785 canonicalizer ({@link canonicalizeJsonBytes});
 * hashing is WebCrypto SHA-256, as for every other core digest.
 */
import { canonicalizeJsonBytes, type JsonObject } from './attestation';
import { webCryptoSubtle } from './webcrypto';

/** Domain tag inside every agent memory intent operation digest. */
export const AGENT_MEMORY_INTENT_DIGEST_VERSION = 'byok-agent-memory-intent-v1' as const;

/** Every field the operation digest covers. `targetRevision` is `null` exactly for `delete`. */
export interface AgentMemoryIntentDigestInput {
  readonly tenantId: string;
  readonly deviceId: string;
  readonly intentId: string;
  readonly agentRef: { readonly agentId: string; readonly profileRevision: string };
  readonly path: string;
  readonly operation: 'replace' | 'delete';
  readonly baseRevision: string;
  readonly targetRevision: string | null;
  readonly approvalRef: string;
}

/**
 * `sha256:<hex>` over
 * `canonicalizeJson({v, tenantId, deviceId, intentId, agentRef, path, operation, baseRevision, targetRevision, approvalRef})`.
 *
 * Only the listed fields are read (an extra property on `input` never changes
 * the digest); a missing field is `undefined`, which the canonicalizer refuses.
 */
export async function agentMemoryIntentOperationDigest(input: AgentMemoryIntentDigestInput): Promise<string> {
  const canonical: JsonObject = {
    v: AGENT_MEMORY_INTENT_DIGEST_VERSION,
    tenantId: input.tenantId,
    deviceId: input.deviceId,
    intentId: input.intentId,
    agentRef: { agentId: input.agentRef.agentId, profileRevision: input.agentRef.profileRevision },
    path: input.path,
    operation: input.operation,
    baseRevision: input.baseRevision,
    targetRevision: input.targetRevision,
    approvalRef: input.approvalRef,
  };
  const digest = new Uint8Array(
    await webCryptoSubtle().digest('SHA-256', new Uint8Array(canonicalizeJsonBytes(canonical))),
  );
  let hex = '';
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0');
  return `sha256:${hex}`;
}
