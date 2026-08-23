import { describe, expect, it } from 'vitest';
import {
  AGENT_HOME_PROJECTION_CAPABILITY,
  AGENT_HOME_PROJECTION_MAX_BYTES,
  AgentHomeProjectionAgentRefSchema,
  AgentHomeProjectionCompletionRequestSchema,
  AgentHomeProjectionOutcomeSchema,
  AgentHomeProjectionPayloadSchema,
  AgentHomeProjectionProfileRevisionSchema,
  AgentHomeProjectionReadbackSchema,
  AgentHomeProjectionValueSchema,
  BYOK_AGENT_HOME_PROJECTION_COMPLETION_ROUTE,
  BYOK_AGENT_HOME_PROJECTIONS_PATH,
  byokAgentHomeProjectionCompletionPath,
  CAPABILITY_FLAGS,
  EnvelopeSchema,
  createEnvelope,
  decodeEnvelope,
  type AgentHomeProjectionPayload,
} from '../index';

const REQUEST_ID = '10000000-0000-4000-8000-000000000001';
const AGENT_REF = {
  agentId: '10000000-0000-4000-8000-000000000002',
  profileRevision: '9007199254740992',
} as const;
const PROJECTION_HASH = `sha256:${'a'.repeat(64)}`;

function payload(overrides: Partial<AgentHomeProjectionPayload> = {}): AgentHomeProjectionPayload {
  return {
    requestId: REQUEST_ID,
    agentRef: AGENT_REF,
    projectionHash: PROJECTION_HASH,
    projection: {
      schemaVersion: 'opaque.product.projection.v1',
      name: 'Research Agent',
      runtimePreference: 'pi_provider_key',
    },
    ...overrides,
  };
}

describe('task-free Agent-home projection protocol', () => {
  it('advertises the additive capability and validates an opaque projection', () => {
    expect(CAPABILITY_FLAGS).toContain(AGENT_HOME_PROJECTION_CAPABILITY);
    expect(AgentHomeProjectionPayloadSchema.parse(payload())).toEqual(payload());
    expect(
      AgentHomeProjectionValueSchema.parse({
        productSpecificField: { value: ['opaque', null, true] },
        schemaVersion: 'product.v1',
      }),
    ).toEqual({
      productSpecificField: { value: ['opaque', null, true] },
      schemaVersion: 'product.v1',
    });
  });

  it('keeps the projection revision canonical, positive, decimal, and BIGINT-bounded', () => {
    for (const value of ['1', '9007199254740991', '9007199254740992', '9223372036854775807']) {
      expect(AgentHomeProjectionProfileRevisionSchema.safeParse(value).success, value).toBe(true);
      expect(AgentHomeProjectionAgentRefSchema.safeParse({ ...AGENT_REF, profileRevision: value }).success, value).toBe(true);
    }
    for (const value of ['', '0', '01', '+1', '-1', '1.0', ' 1', '9223372036854775808', '9999999999999999999']) {
      expect(AgentHomeProjectionProfileRevisionSchema.safeParse(value).success, value).toBe(false);
      expect(AgentHomeProjectionPayloadSchema.safeParse(payload({ agentRef: { ...AGENT_REF, profileRevision: value } })).success).toBe(false);
    }
    expect(AgentHomeProjectionProfileRevisionSchema.safeParse(1).success).toBe(false);
  });

  it('rejects malformed control identity and hash values', () => {
    expect(AgentHomeProjectionPayloadSchema.safeParse(payload({ requestId: 'not-a-uuid' })).success).toBe(false);
    expect(AgentHomeProjectionPayloadSchema.safeParse(payload({ projectionHash: 'sha256:ABC' })).success).toBe(false);
    expect(
      AgentHomeProjectionPayloadSchema.safeParse({
        ...payload(),
        agentRef: { ...AGENT_REF, profileRevision: '1' },
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('rejects JSON projections over 64 KiB while leaving product fields opaque', () => {
    const oversized = 'x'.repeat(AGENT_HOME_PROJECTION_MAX_BYTES);
    expect(AgentHomeProjectionValueSchema.safeParse(oversized).success).toBe(false);
    expect(
      AgentHomeProjectionValueSchema.safeParse({
        arbitraryProductField: oversized,
      }).success,
    ).toBe(false);
  });

  it('requires seq and forbids task_id on the distinct server-to-daemon envelope', () => {
    const envelope = createEnvelope('agent.home.projection', payload(), { seq: 42 });
    expect(envelope).not.toHaveProperty('task_id');
    expect(EnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(decodeEnvelope(`${JSON.stringify(envelope)}\n`)).toEqual(envelope);

    const withoutSeq = { ...envelope } as Record<string, unknown>;
    delete withoutSeq.seq;
    expect(EnvelopeSchema.safeParse(withoutSeq).success).toBe(false);

    const withTaskId = { ...envelope, task_id: 'must-not-route-as-task' };
    expect(EnvelopeSchema.safeParse(withTaskId).success).toBe(false);
  });

  it('binds completion identity and terminal outcomes through the HTTP completion/readback schemas', () => {
    for (const outcome of ['applied', 'idempotent', 'stale', 'conflict'] as const) {
      const completion = AgentHomeProjectionCompletionRequestSchema.parse({
        requestId: REQUEST_ID,
        agentRef: AGENT_REF,
        projectionHash: PROJECTION_HASH,
        outcome,
      });
      expect(AgentHomeProjectionOutcomeSchema.parse(completion.outcome)).toBe(outcome);
      expect(
        AgentHomeProjectionReadbackSchema.parse({
          tenantId: 'tenant-1',
          deviceId: 'device-1',
          requestId: completion.requestId,
          agentRef: completion.agentRef,
          projectionHash: completion.projectionHash,
          status: outcome,
          completedAt: '2026-08-24T00:00:00.000Z',
        }),
      ).toMatchObject({
        requestId: completion.requestId,
        agentRef: completion.agentRef,
        projectionHash: completion.projectionHash,
        status: outcome,
      });
    }

    expect(
      AgentHomeProjectionCompletionRequestSchema.safeParse({
        requestId: REQUEST_ID,
        agentRef: AGENT_REF,
        projectionHash: `sha256:${'b'.repeat(64)}`,
        outcome: 'applied',
      }).success,
    ).toBe(true);
    expect(
      AgentHomeProjectionCompletionRequestSchema.safeParse({
        requestId: REQUEST_ID,
        agentRef: AGENT_REF,
        projectionHash: PROJECTION_HASH,
        outcome: 'pending',
      }).success,
    ).toBe(false);
    expect(
      AgentHomeProjectionReadbackSchema.safeParse({
        tenantId: 'tenant-1',
        deviceId: 'device-1',
        requestId: REQUEST_ID,
        agentRef: AGENT_REF,
        projectionHash: PROJECTION_HASH,
        status: 'applied',
        unexpected: true,
      }).success,
    ).toBe(false);

    expect(BYOK_AGENT_HOME_PROJECTIONS_PATH).toBe('/byok/agent-home-projections');
    expect(BYOK_AGENT_HOME_PROJECTION_COMPLETION_ROUTE).toBe('/byok/agent-home-projections/:requestId/completion');
    expect(byokAgentHomeProjectionCompletionPath(REQUEST_ID)).toBe(
      '/byok/agent-home-projections/10000000-0000-4000-8000-000000000001/completion',
    );
  });
});
