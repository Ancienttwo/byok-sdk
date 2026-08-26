import { describe, expect, test } from 'vitest';
import {
  AGENT_MESSAGE_EGRESS_CAPABILITY,
  TERMINAL_PROJECTION_SELECTION_CAPABILITY,
  AgentMessageDispositionPayloadSchema,
  AgentMessagePublishPayloadSchema,
  AgentMessageServerContextSchema,
  TaskOfferForAgentWithEgressFreshPayloadSchema,
  TaskOfferForAgentWithEgressPayloadSchema,
} from '../index';

const agentRef = { agentId: '11111111-1111-4111-8111-111111111111', profileRevision: '7' } as const;
const egressPolicy = {
  policyRevision: 'p1',
  activity: { mode: 'metadata-status', delivery: 'latest-value' },
  reliable: { maxPendingEventsPerAgent: 8, maxPendingBytesPerAgent: 262144, maxPendingBytesPerTenant: 524288 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
} as const;
const messageEgress = {
  mode: 'required',
  contract: 'salesko.private_agent_chat_message.v1',
  contentType: 'text/markdown',
  maxBytes: 100_000,
} as const;

describe('Agent-initiated message egress protocol', () => {
  test('admits the frozen fresh and resume consumer shape under a distinct capability', () => {
    expect(AGENT_MESSAGE_EGRESS_CAPABILITY).toBe('agent-message-egress');
    const shared = {
      instruction: 'send one message',
      policy: { mode: 'readonly', allowTools: [] },
      agentRef,
      runtime: 'codex',
      egressPolicy,
      messageEgress,
      terminalProjection: { mode: 'none' },
    } as const;
    expect(TaskOfferForAgentWithEgressFreshPayloadSchema.safeParse(shared).success).toBe(true);
    expect(TaskOfferForAgentWithEgressPayloadSchema.safeParse({ ...shared, sessionRef: 'native-session-1' }).success).toBe(true);
  });

  test('treats required-message offers as message-only unless a second terminal projection is explicit', () => {
    expect(TERMINAL_PROJECTION_SELECTION_CAPABILITY).toBe('terminal-projection-selection');
    const shared = {
      instruction: 'send one message',
      policy: { mode: 'readonly', allowTools: [] },
      agentRef,
      runtime: 'codex',
      egressPolicy,
      messageEgress,
    } as const;
    expect(TaskOfferForAgentWithEgressFreshPayloadSchema.safeParse(shared).success).toBe(true);
    expect(TaskOfferForAgentWithEgressFreshPayloadSchema.safeParse({
      ...shared,
      terminalProjection: { mode: 'none' },
    }).success).toBe(true);
    expect(TaskOfferForAgentWithEgressFreshPayloadSchema.safeParse({
      ...shared,
      terminalProjection: { mode: 'result-document', contract: 'example.research.v1' },
    }).success).toBe(true);
  });

  test('keeps model-authored routing and unknown message contracts out of the strict declaration', () => {
    const base = { mode: 'required', contract: 'chat.v1', contentType: 'text/plain', maxBytes: 1000 } as const;
    expect(TaskOfferForAgentWithEgressFreshPayloadSchema.safeParse({
      instruction: 'send', policy: { mode: 'readonly', allowTools: [] }, agentRef, egressPolicy,
      messageEgress: { ...base, target: 'conversation-1' },
    }).success).toBe(false);
    expect(TaskOfferForAgentWithEgressFreshPayloadSchema.safeParse({
      instruction: 'send', policy: { mode: 'readonly', allowTools: [] }, agentRef, egressPolicy,
      messageEgress: { ...base, maxBytes: 262145 },
    }).success).toBe(false);
  });

  test('types and bounds the host-only destination context without adding it to offer payloads', () => {
    expect(AgentMessageServerContextSchema.safeParse({ destinationBinding: 'conversation/42/turn/7', freshnessCursor: 'turn-seq:7' }).success).toBe(true);
    expect(AgentMessageServerContextSchema.safeParse({ destinationBinding: 'x'.repeat(2049) }).success).toBe(false);
    expect(AgentMessageServerContextSchema.safeParse({ destinationBinding: 'conversation/42', target: 'model-authored' }).success).toBe(false);
  });

  test('bounds message bytes and requires exact disposition identity', () => {
    const body = 'hello';
    const publish = {
      agentRef,
      sessionRef: 'session-1',
      contract: 'chat.v1',
      messageId: '11111111-1111-4111-8111-111111111112',
      cursor: 1,
      contentType: 'text/plain',
      body,
      contentHash: `sha256:${'a'.repeat(64)}`,
      byteCount: 5,
    };
    expect(AgentMessagePublishPayloadSchema.safeParse(publish).success).toBe(true);
    expect(AgentMessagePublishPayloadSchema.safeParse({ ...publish, byteCount: 4 }).success).toBe(false);
    expect(AgentMessageDispositionPayloadSchema.safeParse({
      agentRef,
      sessionRef: 'session-1',
      contract: 'chat.v1',
      messageId: publish.messageId,
      cursor: 1,
      contentHash: publish.contentHash,
      outcome: 'accepted',
      receiptId: '11111111-1111-4111-8111-111111111113',
    }).success).toBe(true);
  });
});
