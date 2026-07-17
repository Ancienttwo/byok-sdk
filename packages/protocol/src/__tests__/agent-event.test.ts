import { describe, expect, it } from 'vitest';
import {
  AgentEventOrUnknownSchema,
  AgentEventSchema,
  TaskProgressPayloadSchema,
  UnknownAgentEventSchema,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  isKnownAgentEvent,
  parseMessage,
  partitionAgentEvents,
  type AgentEventOrUnknown,
} from '../index';

// ---------------------------------------------------------------------------
// Unknown AgentEvent variant tolerance — the pre-freeze blocker fix.
// ---------------------------------------------------------------------------

describe('unknown AgentEvent variant tolerance', () => {
  it('TaskProgressPayloadSchema parses a batch with one known + one unknown-type event, without throwing', () => {
    const payload = {
      seq: 1,
      events: [
        { type: 'progress', text: 'reading files' },
        { type: 'plan_update', step: 3, of: 7, nested: { detail: 'ok' } },
      ],
    };

    const result = TaskProgressPayloadSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('retains the unknown event as a passthrough placeholder — every original field survives verbatim', () => {
    const unknownEvent = { type: 'plan_update', step: 3, of: 7, nested: { detail: 'ok' } };
    const result = TaskProgressPayloadSchema.safeParse({ seq: 1, events: [unknownEvent] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.events[0]).toEqual(unknownEvent);
    }
  });

  it('a full task.progress envelope with an unknown event type parses via parseMessage without throwing', () => {
    const raw = {
      v: 1,
      id: '11111111-1111-4111-8111-111111111111',
      ts: new Date().toISOString(),
      type: 'task.progress',
      task_id: 'task-1',
      payload: {
        seq: 1,
        events: [
          { type: 'progress', text: 'hi' },
          { type: 'some_future_event_v2', foo: 42 },
        ],
      },
    };

    expect(() => parseMessage(raw)).not.toThrow();
    const parsed = parseMessage(raw);
    expect(parsed.type).toBe('task.progress');
    if (parsed.type === 'task.progress') {
      expect(parsed.payload.events).toEqual([
        { type: 'progress', text: 'hi' },
        { type: 'some_future_event_v2', foo: 42 },
      ]);
    }
  });

  it('AgentEventOrUnknownSchema accepts a single unknown-type event directly', () => {
    const result = AgentEventOrUnknownSchema.safeParse({ type: 'brand_new_kind', x: 1 });
    expect(result.success).toBe(true);
  });

  it('UnknownAgentEventSchema alone rejects a known type literal (the refine guard)', () => {
    // Even though shape-wise this satisfies `{ type: string }`.passthrough(),
    // 'progress' is a KNOWN type, so UnknownAgentEventSchema must not accept
    // it on its own — AgentEventSchema is the only schema allowed to accept
    // a 'progress' event, and only when it's well-formed.
    const result = UnknownAgentEventSchema.safeParse({ type: 'progress', text: 'well formed' });
    expect(result.success).toBe(false);
  });

  it('a malformed KNOWN variant (progress missing text) still fails — tolerance is only for unknown TYPES', () => {
    const result = TaskProgressPayloadSchema.safeParse({
      seq: 1,
      events: [{ type: 'progress' /* missing required text */ }],
    });
    expect(result.success).toBe(false);
  });

  it('a malformed KNOWN variant fails the whole batch even alongside otherwise-valid events', () => {
    const result = TaskProgressPayloadSchema.safeParse({
      seq: 1,
      events: [
        { type: 'progress', text: 'this one is fine' },
        { type: 'tool_use' /* missing required tool */ },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('AgentEventOrUnknownSchema rejects a malformed known variant directly (does not fall back to unknown-tolerance)', () => {
    const result = AgentEventOrUnknownSchema.safeParse({ type: 'artifact', name: 'missing-content-type' });
    expect(result.success).toBe(false);
  });

  describe('isKnownAgentEvent / partitionAgentEvents', () => {
    const known1: AgentEventOrUnknown = { type: 'progress', text: 'step 1' };
    const known2: AgentEventOrUnknown = { type: 'turn_end' };
    const unknown1: AgentEventOrUnknown = { type: 'plan_update', step: 1 };
    const unknown2: AgentEventOrUnknown = { type: 'thinking', text: 'reasoning trace' };

    it('isKnownAgentEvent distinguishes known from unknown', () => {
      expect(isKnownAgentEvent(known1)).toBe(true);
      expect(isKnownAgentEvent(known2)).toBe(true);
      expect(isKnownAgentEvent(unknown1)).toBe(false);
      expect(isKnownAgentEvent(unknown2)).toBe(false);
    });

    it('partitionAgentEvents cleanly separates known from unknown, preserving order and content', () => {
      const { known, unknown } = partitionAgentEvents([known1, unknown1, known2, unknown2]);
      expect(known).toEqual([known1, known2]);
      expect(unknown).toEqual([unknown1, unknown2]);
    });

    it('partitionAgentEvents on an all-known array yields an empty unknown list', () => {
      const { known, unknown } = partitionAgentEvents([known1, known2]);
      expect(known).toEqual([known1, known2]);
      expect(unknown).toEqual([]);
    });

    it('a parsed mixed batch can be partitioned so consumers skip unknowns instead of choking on them', () => {
      const result = TaskProgressPayloadSchema.safeParse({
        seq: 1,
        events: [known1, unknown1, known2],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        const { known, unknown } = partitionAgentEvents(result.data.events);
        expect(known).toEqual([known1, known2]);
        expect(unknown).toEqual([unknown1]);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// `usage` AgentEvent variant (additive)
// ---------------------------------------------------------------------------

describe('usage AgentEvent variant', () => {
  it('accepts a usage event with every field set', () => {
    const event = {
      type: 'usage',
      inputTokens: 1200,
      cachedInputTokens: 400,
      outputTokens: 300,
      reasoningTokens: 50,
      totalTokens: 1550,
    };
    const result = AgentEventSchema.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(event);
  });

  it('accepts a usage event with no optional fields set (all optional)', () => {
    const result = AgentEventSchema.safeParse({ type: 'usage' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ type: 'usage' });
  });

  it.each([
    { inputTokens: 100 },
    { outputTokens: 50, totalTokens: 50 },
    { cachedInputTokens: 0 },
    { reasoningTokens: 25 },
    { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  ])('accepts various optional-field subsets: %j', (subset) => {
    const event = { type: 'usage', ...subset };
    const result = AgentEventSchema.safeParse(event);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(event);
  });

  it('rejects a negative token count', () => {
    const result = AgentEventSchema.safeParse({ type: 'usage', inputTokens: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-integer token count', () => {
    const result = AgentEventSchema.safeParse({ type: 'usage', outputTokens: 12.5 });
    expect(result.success).toBe(false);
  });

  it('round-trips through encode/decode inside a task.progress envelope, various subsets', () => {
    const subsets = [
      {},
      { inputTokens: 500 },
      { inputTokens: 500, cachedInputTokens: 200, outputTokens: 75, reasoningTokens: 10, totalTokens: 575 },
    ];

    for (const subset of subsets) {
      const envelope = createEnvelope(
        'task.progress',
        { seq: 1, events: [{ type: 'usage', ...subset }] },
        { taskId: 'task-1', seq: 1 },
      );
      const encoded = encodeEnvelope(envelope);
      const decoded = decodeEnvelope(encoded);
      expect(decoded).toEqual(envelope);

      const reparsed = parseMessage(JSON.parse(encoded));
      expect(reparsed).toEqual(envelope);
    }
  });
});
