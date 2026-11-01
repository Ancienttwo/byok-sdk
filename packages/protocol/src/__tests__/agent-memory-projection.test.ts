import { describe, expect, it } from 'vitest';
import {
  AGENT_MEMORY_PROJECTION_CAPABILITY,
  AgentMemoryProjectionCommitRequestSchema,
  AgentMemoryProjectionCommitResponseSchema,
  AgentMemoryProjectionEraseResultSchema,
  AgentMemoryProjectionMutationSchema,
  BYOK_AGENT_MEMORY_PROJECTIONS_PATH,
  agentMemoryProjectionBase64UrlByteLength,
  type AgentMemoryProjectionPlainMutation,
} from '../index';

const HASH = `sha256:${'a'.repeat(64)}`;

function mutation(overrides: Partial<AgentMemoryProjectionPlainMutation> = {}): AgentMemoryProjectionPlainMutation {
  return {
    taskId: 'memory-task',
    agentRef: { agentId: 'agent-memory', profileRevision: 'profile-r1' },
    sessionRef: 'session-memory',
    runtimeId: 'codex',
    grantRef: 'opaque-grant-ref',
    writerEpoch: 1,
    sourceSeq: 1,
    mutationId: '10000000-0000-4000-8000-000000000001',
    policyRevision: 'policy-r1',
    snapshot: {
      redactedHash: HASH,
      redactedByteCount: 4,
      redactedBytes: 'c2FmZQ',
    },
    ...overrides,
  };
}

describe('Agent-memory hosted projection protocol', () => {
  it('defines a bounded, tenant/device-authenticated redacted-only mutation', () => {
    const value = mutation();
    expect(AGENT_MEMORY_PROJECTION_CAPABILITY).toBe('agent.memory.projection');
    expect(BYOK_AGENT_MEMORY_PROJECTIONS_PATH).toBe('/byok/agent-memory-projections');
    expect(AgentMemoryProjectionMutationSchema.parse(value)).toEqual(value);
    expect(AgentMemoryProjectionCommitRequestSchema.parse(value)).toEqual(value);
    expect(agentMemoryProjectionBase64UrlByteLength(value.snapshot.redactedBytes)).toBe(4);
    expect(agentMemoryProjectionBase64UrlByteLength('a')).toBeUndefined();
  });

  it('rejects malformed redacted bytes, byte counts, and unportable local authority fields', () => {
    expect(
      AgentMemoryProjectionMutationSchema.safeParse(
        mutation({ snapshot: { redactedHash: HASH, redactedByteCount: 4, redactedBytes: 'not!base64url' } }),
      ).success,
    ).toBe(false);
    expect(
      AgentMemoryProjectionMutationSchema.safeParse(
        mutation({ snapshot: { redactedHash: HASH, redactedByteCount: 5, redactedBytes: 'c2FmZQ' } }),
      ).success,
    ).toBe(false);
    expect(
      AgentMemoryProjectionMutationSchema.safeParse({ ...mutation(), cwd: '/local/agent/home' }).success,
    ).toBe(false);
    expect(
      AgentMemoryProjectionMutationSchema.safeParse({ ...mutation(), rawSourceHash: HASH }).success,
    ).toBe(false);
    expect(
      AgentMemoryProjectionMutationSchema.safeParse({ ...mutation(), writerEpoch: 2_147_483_648 }).success,
    ).toBe(false);
    expect(
      AgentMemoryProjectionMutationSchema.safeParse({ ...mutation(), sourceSeq: 2_147_483_648 }).success,
    ).toBe(false);
  });

  it('keeps response/audit-safe receipt body-free while binding all replay identity', () => {
    const receipt = {
      outcome: 'accepted' as const,
      tenantId: 'tenant-a',
      deviceId: 'device-a',
      taskId: 'memory-task',
      agentRef: { agentId: 'agent-memory', profileRevision: 'profile-r1' },
      sessionRef: 'session-memory',
      runtimeId: 'codex' as const,
      grantRef: 'opaque-grant-ref',
      writerEpoch: 1,
      sourceSeq: 1,
      mutationId: '10000000-0000-4000-8000-000000000001',
      policyRevision: 'policy-r1',
      redactedHash: HASH,
      redactedByteCount: 4,
      metering: {
        meteringReceiptId: '10000000-0000-4000-8000-000000000002',
        acceptedRedactedBytes: 4,
        recordedAt: '2026-08-26T00:00:00.000Z',
      },
    };
    expect(AgentMemoryProjectionCommitResponseSchema.parse(receipt)).toEqual(receipt);
    expect(AgentMemoryProjectionCommitResponseSchema.safeParse({ ...receipt, redactedBytes: 'c2FmZQ' }).success).toBe(false);
    expect(AgentMemoryProjectionCommitResponseSchema.safeParse({ ...receipt, cwd: '/leak' }).success).toBe(false);
  });

  it('carries a sealed snapshot inline only, without its plaintext hash or byte count (#1045 C4)', () => {
    const zeros = (bytes: number) => Buffer.alloc(bytes).toString('base64url');
    const sealedMember = (paddedLength: number) => ({
      v: 1, suite: 'byok-sealed-v1.hkdf-sha256.aes-256-gcm', category: 'memory-projection',
      scope: { id: 'scope-agent-memory', epoch: 1, keyId: 'A'.repeat(22) },
      chainHead: { seq: 1, hash: HASH }, sender: 'B'.repeat(43), salt: zeros(32), nonce: zeros(12),
      paddedLength, contentMac: `hmac-sha256:${'c'.repeat(64)}`, ciphertext: zeros(paddedLength + 16),
    });
    const { snapshot: _snapshot, ...identity } = mutation();
    const sealed = { ...identity, sealed: sealedMember(256) };
    expect(AgentMemoryProjectionCommitRequestSchema.parse(sealed)).toEqual(sealed);
    expect(AgentMemoryProjectionMutationSchema.safeParse({ ...sealed, snapshot: mutation().snapshot }).success, 'both forms').toBe(false);
    expect(AgentMemoryProjectionMutationSchema.safeParse({ ...sealed, sealed: { ...sealedMember(256), category: 'task-output' } }).success, 'category').toBe(false);
    // Above the inline maximum a sealed content would name a blob; a memory projection has none.
    expect(AgentMemoryProjectionMutationSchema.safeParse({ ...sealed, sealed: sealedMember(270336) }).success, 'inline only').toBe(false);
    const { ciphertext: _ciphertext, ...outer } = sealedMember(270336);
    const blob = { blobId: 'blob-1', contentHash: HASH, size: 270352, contentType: 'application/octet-stream' };
    expect(AgentMemoryProjectionMutationSchema.safeParse({ ...sealed, sealed: { ...outer, ciphertextRef: blob } }).success, 'no blob').toBe(false);

    const receipt = {
      ...identity, outcome: 'accepted' as const, tenantId: 'tenant-a', deviceId: 'device-a',
      contentMac: sealed.sealed.contentMac, paddedLength: 256,
      metering: { meteringReceiptId: '10000000-0000-4000-8000-000000000002', acceptedPaddedBytes: 256, recordedAt: '2026-08-26T00:00:00.000Z' },
    };
    expect(AgentMemoryProjectionCommitResponseSchema.parse(receipt)).toEqual(receipt);
    expect(AgentMemoryProjectionCommitResponseSchema.safeParse({ ...receipt, redactedHash: HASH }).success, 'no plaintext hash').toBe(false);
  });

  it('makes server erase return only a strictly positive next writer epoch', () => {
    expect(AgentMemoryProjectionEraseResultSchema.parse({ nextWriterEpoch: 2 })).toEqual({ nextWriterEpoch: 2 });
    expect(AgentMemoryProjectionEraseResultSchema.safeParse({ nextWriterEpoch: 0 }).success).toBe(false);
    expect(AgentMemoryProjectionEraseResultSchema.safeParse({ nextWriterEpoch: 2, snapshot: 'forbidden' }).success).toBe(false);
  });
});
