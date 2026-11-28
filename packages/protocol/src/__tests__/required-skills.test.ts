import { describe, expect, it } from 'vitest';
import {
  AgentInputPreparationPayloadSchema,
  CONFIGURED_SKILLS_MAX_ITEMS,
  HostOfferPlainPayloadSchema,
  MESSAGE_PAYLOAD_SCHEMAS,
  RequiredSkillsSchema,
  RuntimeCapabilitiesSchema,
  SKILL_SELECTION_CAPABILITY,
  SkillIdSchema,
  TaskOfferPlainPayloadSchema,
  TaskOfferSealedPayloadSchema,
  createEnvelope,
  offerSelectionViolation,
  requiredReceiverCapabilities,
} from '../index';

const AGENT_REF = { agentId: 'agent-1', profileRevision: 'rev-1' };
const RESUME_SESSION = { mode: 'resume', sessionRef: 'session-1' } as const;
const TARGET = { lane: 'harness', harnessId: 'pi', selection: { mode: 'device-default' } } as const;
const EGRESS_POLICY = {
  policyRevision: 'policy-r1',
  activity: { delivery: 'latest-value' as const, maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 10, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
  transfers: { workspace: 'disabled' as const, transcript: 'disabled' as const, artifact: 'disabled' as const },
};

describe('requiredSkills on an Agent offer', () => {
  it('carries only logical ids on the server-to-daemon offer and gates on skill-selection', () => {
    const envelope = createEnvelope(
      'task.offer',
      {
        instruction: 'review the PR',
        agentRef: AGENT_REF,
        session: RESUME_SESSION,
        target: TARGET,
        requiredSkills: ['review', 'deploy.checklist-v2'],
      },
      { taskId: 'task-skills-1', seq: 1 },
    );

    expect(envelope.type).toBe('task.offer');
    expect(envelope.payload.requiredSkills).toEqual(['review', 'deploy.checklist-v2']);
    expect(JSON.stringify(envelope)).not.toMatch(/path|pack|content|secret/i);
    expect(requiredReceiverCapabilities('task.offer', envelope.payload)).toEqual([
      'agent-home-contract',
      SKILL_SELECTION_CAPABILITY,
    ]);
  });

  it('pins the bounded lowercase SkillId vocabulary and CONFIGURED_SKILLS_MAX_ITEMS', () => {
    expect(CONFIGURED_SKILLS_MAX_ITEMS).toBe(64);
    expect(SkillIdSchema.safeParse('a').success).toBe(true);
    expect(SkillIdSchema.safeParse('review.code_v1-a').success).toBe(true);
    expect(SkillIdSchema.safeParse('a'.repeat(128)).success).toBe(true);

    for (const invalid of ['', 'a'.repeat(129), 'Review', '../review', 'review/sub', 'review\nother', '.review', 'review-', 'a..b']) {
      expect(SkillIdSchema.safeParse(invalid).success, invalid).toBe(false);
    }
  });

  it('rejects empty, duplicate, malformed, and oversized requiredSkills sets', () => {
    expect(RequiredSkillsSchema.parse(['review'])).toEqual(['review']);
    expect(RequiredSkillsSchema.parse(Array.from({ length: 16 }, (_, i) => `skill-${i}`))).toHaveLength(16);

    expect(RequiredSkillsSchema.safeParse([]).success).toBe(false);
    expect(RequiredSkillsSchema.safeParse(['review', 'review']).success).toBe(false);
    expect(RequiredSkillsSchema.safeParse(['Review']).success).toBe(false);
    expect(RequiredSkillsSchema.safeParse(Array.from({ length: 17 }, (_, i) => `skill-${i}`)).success).toBe(false);
  });

  it('refuses unknown fields on task.offer and rejects requiredSkills on AgentInputPreparationPayloadSchema', () => {
    expect(MESSAGE_PAYLOAD_SCHEMAS['task.offer'].safeParse({
      instruction: 'x',
      agentRef: AGENT_REF,
      session: RESUME_SESSION,
      target: TARGET,
      requiredSkills: ['review'],
      skillPaths: ['/tmp/untrusted'],
    }).success).toBe(false);

    expect(AgentInputPreparationPayloadSchema.safeParse({
      agentMemory: 'none',
      requestId: '00000000-0000-4000-8000-000000000001',
      agentRef: AGENT_REF,
      profileId: 'profile-1',
      policyRevision: 'policy-1',
      source: { revision: 'rev-1', digest: 'dig-1' },
      selection: {
        providerId: 'openai',
        model: {
          id: 'gpt-5',
          name: 'GPT-5',
          api: 'openai-responses',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          reasoning: true,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 16384,
        },
        options: {},
      },
      deadlineAt: '2026-11-28T00:00:00.000Z',
      context: { kind: 'inline', content: { messages: [] } },
      requiredToolsets: [],
      requiredSkills: ['review'],
    }).success).toBe(false);
  });

  it('structurally refuses requiredSkills on a prepared offer in offerRule', () => {
    const prepared = {
      agentRef: AGENT_REF,
      session: { mode: 'fresh' as const },
      target: TARGET,
      egressPolicy: EGRESS_POLICY,
      preparation: { reference: 'prep-1', requestDigest: 'digest-1' },
      agentMemory: 'none' as const,
      requiredSkills: ['review'],
    };
    const wire = TaskOfferPlainPayloadSchema.safeParse(prepared);
    expect(wire.success).toBe(false);
    expect(wire.error?.issues).toContainEqual({
      code: 'custom',
      path: ['requiredSkills'],
      message: 'a prepared offer carries no requiredSkills',
    });

    const host = HostOfferPlainPayloadSchema.safeParse(prepared);
    expect(host.success).toBe(false);
    expect(host.error?.issues).toContainEqual({
      code: 'custom',
      path: ['requiredSkills'],
      message: 'a prepared offer carries no requiredSkills',
    });
  });

  it('forbids requiredSkills with nativeSessions via offerSelectionViolation', () => {
    const payload = {
      instruction: 'summarize recent sessions',
      agentRef: AGENT_REF,
      session: { mode: 'fresh' as const },
      target: TARGET,
      egressPolicy: EGRESS_POLICY,
      agentMemory: 'none' as const,
      nativeSessions: { fromMs: 1, toMs: 2 },
      requiredSkills: ['review'],
    };
    expect(offerSelectionViolation(payload)).toEqual({
      rule: 'native_sessions_selection_invalid',
      path: ['requiredSkills'],
      message: 'nativeSessions forbids requiredSkills',
    });
    expect(TaskOfferPlainPayloadSchema.safeParse(payload).success).toBe(true);
    const host = HostOfferPlainPayloadSchema.safeParse(payload);
    expect(host.success).toBe(false);
    expect(host.error?.issues).toEqual([{
      code: 'custom',
      path: ['requiredSkills'],
      message: 'nativeSessions forbids requiredSkills',
      params: { rule: 'native_sessions_selection_invalid' },
    }]);
  });

  it('keeps requiredSkills visible and gated on sealed offers', () => {
    const sealedOffer = {
      agentRef: AGENT_REF,
      session: RESUME_SESSION,
      target: TARGET,
      instruction: 'output-only sealed',
      requiredSkills: ['review'],
      sealing: { scopeId: 'scope-1', epoch: 1, categories: ['task-output'] as const },
    };
    expect(TaskOfferSealedPayloadSchema.parse(sealedOffer).requiredSkills).toEqual(['review']);
    expect(requiredReceiverCapabilities('task.offer', sealedOffer)).toEqual([
      'agent-home-contract',
      SKILL_SELECTION_CAPABILITY,
      'sealed-payload-v1',
    ]);
  });

  it('accepts optional boolean RuntimeCapabilitiesSchema.skills', () => {
    expect(RuntimeCapabilitiesSchema.parse({})).toEqual({});
    expect(RuntimeCapabilitiesSchema.parse({ skills: true })).toEqual({ skills: true });
    expect(RuntimeCapabilitiesSchema.parse({ skills: false })).toEqual({ skills: false });
    expect(RuntimeCapabilitiesSchema.safeParse({ skills: 'yes' }).success).toBe(false);
  });
});
