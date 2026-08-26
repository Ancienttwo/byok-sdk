import { describe, expect, it } from 'vitest';
import {
  AGENT_MEMORY_PROJECTION_CAPABILITY,
  AgentMemoryProjectionCommitRequestSchema,
  AgentMemoryProjectionCommitResponseSchema,
  AgentMemoryProjectionEraseResultSchema,
  AgentMemoryProjectionMutationSchema,
  BYOK_AGENT_MEMORY_PROJECTIONS_PATH,
  agentMemoryProjectionBase64UrlByteLength,
  type AgentMemoryProjectionMutation,
} from '../index';

const HASH = `sha256:${'a'.repeat(64)}`;

function mutation(overrides: Partial<AgentMemoryProjectionMutation> = {}): AgentMemoryProjectionMutation {
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

  it('makes server erase return only a strictly positive next writer epoch', () => {
    expect(AgentMemoryProjectionEraseResultSchema.parse({ nextWriterEpoch: 2 })).toEqual({ nextWriterEpoch: 2 });
    expect(AgentMemoryProjectionEraseResultSchema.safeParse({ nextWriterEpoch: 0 }).success).toBe(false);
    expect(AgentMemoryProjectionEraseResultSchema.safeParse({ nextWriterEpoch: 2, snapshot: 'forbidden' }).success).toBe(false);
  });
});
