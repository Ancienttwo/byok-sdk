import { describe, expect, it } from 'vitest';
import {
  AGENT_CONTENT_ARTIFACT_READ_CAPABILITY,
  AGENT_CONTENT_TRANSCRIPT_READ_CAPABILITY,
  AGENT_CONTENT_WORKSPACE_READ_CAPABILITY,
  AGENT_EGRESS_POLICY_CAPABILITY,
  AGENT_EGRESS_RELIABLE_ACK_CAPABILITY,
  AgentEgressPolicySchema,
  AgentContentReadDenialReasonSchema,
  CAPABILITY_FLAGS,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  parseMessage,
} from '..';

const AGENT_REF = { agentId: 'agent-protocol', profileRevision: 'profile-protocol' } as const;
const CONTENT_HASH = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POLICY = {
  policyRevision: 'protocol-policy-r1',
  activity: { mode: 'metadata-status' as const, delivery: 'latest-value' as const },
  reliable: {
    maxPendingEventsPerAgent: 10,
    maxPendingBytesPerAgent: 4096,
    maxPendingBytesPerTenant: 8192,
  },
  transfers: {
    workspace: { maxBytes: 1024, allowedMimeTypes: ['text/plain'] },
    transcript: 'disabled' as const,
    artifact: 'disabled' as const,
  },
};

describe('Agent egress typed wire contract', () => {
  it('declares every independently admitted capability and rejects partial policy shapes', () => {
    expect(CAPABILITY_FLAGS).toEqual(
      expect.arrayContaining([
        AGENT_EGRESS_POLICY_CAPABILITY,
        AGENT_EGRESS_RELIABLE_ACK_CAPABILITY,
        AGENT_CONTENT_WORKSPACE_READ_CAPABILITY,
        AGENT_CONTENT_TRANSCRIPT_READ_CAPABILITY,
        AGENT_CONTENT_ARTIFACT_READ_CAPABILITY,
      ]),
    );
    expect(AgentEgressPolicySchema.parse(POLICY)).toEqual(POLICY);
    expect(
      AgentEgressPolicySchema.safeParse({
        ...POLICY,
        transfers: { workspace: { maxBytes: 1024, allowedMimeTypes: ['text/plain'] } },
      }).success,
    ).toBe(false);
  });

  it('round-trips exact reliable acknowledgement identity and rejects unknown payload fields', () => {
    const acknowledgement = createEnvelope(
      'agent.egress.ack',
      {
        agentRef: AGENT_REF,
        sessionRef: 'session-protocol',
        policyRevision: POLICY.policyRevision,
        eventId: '10000000-0000-4000-8000-000000000050',
        cursor: 23,
        receiptId: '10000000-0000-4000-8000-000000000051',
      },
      { seq: 31 },
    );
    expect(decodeEnvelope(encodeEnvelope(acknowledgement))).toEqual(acknowledgement);

    const malformed = {
      ...acknowledgement,
      payload: { ...acknowledgement.payload, invented: 'fallback' },
    };
    expect(() => parseMessage(malformed)).toThrow(/failed validation/u);
  });

  it('requires policy consumption on the separate Agent offer and keeps reliable payload content opaque', () => {
    const offer = createEnvelope(
      'task.offer_for_agent_with_egress',
      {
        instruction: 'strict Agent egress offer',
        policy: { mode: 'auto' },
        agentRef: AGENT_REF,
        sessionRef: 'session-protocol',
        egressPolicy: POLICY,
      },
      { taskId: 'task-egress-protocol', seq: 32 },
    );
    expect(offer.payload).toMatchObject({ agentRef: AGENT_REF, sessionRef: 'session-protocol', egressPolicy: POLICY });
    expect(() =>
      createEnvelope('agent.egress.reliable', {
        agentRef: AGENT_REF,
        sessionRef: 'session-protocol',
        policyRevision: POLICY.policyRevision,
        eventId: '10000000-0000-4000-8000-000000000052',
        cursor: 24,
        payload: { safe: true },
        contentHash: CONTENT_HASH,
        byteCount: 5,
        extra: 'not permitted',
      } as never),
    ).toThrow(/invalid envelope/u);
  });

  it('requires product actor, caller MIME, and explicit decode mode without normalizing local denial reasons', () => {
    expect(AgentContentReadDenialReasonSchema.parse('text-decode-failed')).toBe('text-decode-failed');
    expect(() =>
      createEnvelope(
        'agent.content.read',
        {
          requestId: '10000000-0000-4000-8000-000000000053',
          surface: 'workspace',
          agentRef: AGENT_REF,
          sessionRef: 'session-protocol',
          runtime: 'codex',
          cwd: '/workspace',
          policyRevision: POLICY.policyRevision,
          target: 'README.md',
          policy: { maxBytes: 1024, allowedMimeTypes: ['text/plain'] },
        } as never,
        { seq: 33 },
      ),
    ).toThrow(/invalid envelope/u);
  });
});
