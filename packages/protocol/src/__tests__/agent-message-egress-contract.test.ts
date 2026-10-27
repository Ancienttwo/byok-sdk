import { describe, expect, test } from 'vitest';
import {
  AGENT_MESSAGE_EGRESS_CAPABILITY,
  AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES,
  AgentMessageDraftPayloadSchema,
  TERMINAL_PROJECTION_SELECTION_CAPABILITY,
  AgentMessageDispositionPayloadSchema,
  AgentMessagePublishPayloadSchema,
  AgentMessageServerContextSchema,
  TaskOfferPayloadSchema,
} from '../index';

const agentRef = { agentId: '11111111-1111-4111-8111-111111111111', profileRevision: '7' } as const;
const egressPolicy = {
  policyRevision: 'p1',
  activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 8, maxPendingBytesPerAgent: 262144, maxPendingBytesPerTenant: 524288 },
  transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
} as const;
const FRESH = { mode: 'fresh' } as const;
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
      agentRef,
      runtime: 'codex',
      egressPolicy,
      messageEgress,
      terminalProjection: { mode: 'none' },
    } as const;
    expect(TaskOfferPayloadSchema.safeParse({ ...shared, session: FRESH }).success).toBe(true);
    expect(TaskOfferPayloadSchema.safeParse({ ...shared, session: { mode: 'resume', sessionRef: 'native-session-1' } }).success).toBe(true);
  });

  test('treats required-message offers as message-only unless a second terminal projection is explicit', () => {
    expect(TERMINAL_PROJECTION_SELECTION_CAPABILITY).toBe('terminal-projection-selection');
    const shared = {
      instruction: 'send one message',
      agentRef,
      runtime: 'codex',
      egressPolicy,
      messageEgress,
      session: FRESH,
    } as const;
    expect(TaskOfferPayloadSchema.safeParse(shared).success).toBe(true);
    expect(TaskOfferPayloadSchema.safeParse({
      ...shared,
      terminalProjection: { mode: 'none' },
    }).success).toBe(true);
    expect(TaskOfferPayloadSchema.safeParse({
      ...shared,
      terminalProjection: {
        mode: 'result-document',
        contract: 'example.research.v1',
        schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
      },
    }).success).toBe(true);
    // Wire v3: the result-document arm carries its frozen outcome schema.
    expect(TaskOfferPayloadSchema.safeParse({
      ...shared,
      terminalProjection: { mode: 'result-document', contract: 'example.research.v1' },
    }).success).toBe(false);
  });

  test('keeps model-authored routing and unknown message contracts out of the strict declaration', () => {
    const base = { mode: 'required', contract: 'chat.v1', contentType: 'text/plain', maxBytes: 1000 } as const;
    expect(TaskOfferPayloadSchema.safeParse({
      instruction: 'send', agentRef, egressPolicy, session: FRESH,
      messageEgress: { ...base, target: 'conversation-1' },
    }).success).toBe(false);
    expect(TaskOfferPayloadSchema.safeParse({
      instruction: 'send', agentRef, egressPolicy, session: FRESH,
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


describe('Agent message draft frame', () => {
  const frame = { agentRef, revision: 1, offset: 0, text: '' };
  test('accepts empty frames and the UTF-8 byte limit', () => {
    expect(AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES).toBe(16 * 1024);
    expect(AgentMessageDraftPayloadSchema.parse(frame)).toEqual(frame);
    expect(AgentMessageDraftPayloadSchema.safeParse({ ...frame, text: 'é'.repeat(8192), overflow: true }).success).toBe(true);
    expect(AgentMessageDraftPayloadSchema.safeParse({ ...frame, text: 'é'.repeat(8192) + 'x' }).success).toBe(false);
  });
  test.each([{ revision: 0 }, { revision: 1.5 }, { offset: -1 }, { offset: 0.5 }, { overflow: false }, { extra: true }])('rejects invalid strict fields: %o', change => {
    expect(AgentMessageDraftPayloadSchema.safeParse({ ...frame, ...change }).success).toBe(false);
  });
});
