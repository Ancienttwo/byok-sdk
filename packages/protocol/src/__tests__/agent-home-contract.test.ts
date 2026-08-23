import { describe, expect, it } from 'vitest';
import {
  AgentRefSchema,
  CAPABILITY_FLAGS,
  TaskOfferForAgentPayloadSchema,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
} from '../index';

const agentRef = { agentId: 'agent-1', profileRevision: 'profile-r7' } as const;
const offer = {
  instruction: 'continue the durable agent task',
  policy: { mode: 'auto' as const },
  agentRef,
};

describe('agent-home-contract protocol', () => {
  it('uses a distinct strict offer and round-trips its exact AgentRef', () => {
    const envelope = createEnvelope('task.offer_for_agent', offer, {
      taskId: 'task-agent-1',
      seq: 1,
    });
    expect(envelope.type).toBe('task.offer_for_agent');
    expect(decodeEnvelope(encodeEnvelope(envelope))).toEqual(envelope);
    expect(TaskOfferForAgentPayloadSchema.safeParse({ ...offer, workspaceHint: 'legacy' }).success).toBe(false);
  });

  it('rejects malformed, traversal-like, control, and oversized AgentRef values', () => {
    expect(AgentRefSchema.safeParse({ agentId: '', profileRevision: 'r1' }).success).toBe(false);
    expect(AgentRefSchema.safeParse({ agentId: '..', profileRevision: 'r1' }).success).toBe(false);
    expect(AgentRefSchema.safeParse({ agentId: '../escape', profileRevision: 'r1' }).success).toBe(false);
    expect(AgentRefSchema.safeParse({ agentId: 'agent\u0000', profileRevision: 'r1' }).success).toBe(false);
    expect(AgentRefSchema.safeParse({ agentId: 'agent.', profileRevision: 'r1' }).success).toBe(false);
    expect(AgentRefSchema.safeParse({ agentId: 'agent ', profileRevision: 'r1' }).success).toBe(false);
    expect(AgentRefSchema.safeParse({ agentId: 'CON', profileRevision: 'r1' }).success).toBe(false);
    expect(AgentRefSchema.safeParse({ agentId: 'nul.txt', profileRevision: 'r1' }).success).toBe(false);
    expect(AgentRefSchema.safeParse({ agentId: 'a'.repeat(161), profileRevision: 'r1' }).success).toBe(false);
    expect(AgentRefSchema.safeParse({ agentId: 'é'.repeat(100), profileRevision: 'r1' }).success).toBe(false);
    expect(AgentRefSchema.safeParse({ agentId: 'agent-1', profileRevision: 'r'.repeat(161) }).success).toBe(false);
  });

  it('keeps the capability additive so old capability advertisements omit it', () => {
    expect(CAPABILITY_FLAGS).toContain('agent-home-contract');
    expect(['steer', 'blob-upload']).not.toContain('agent-home-contract');
  });
});
