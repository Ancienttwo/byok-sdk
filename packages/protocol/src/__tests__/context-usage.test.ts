import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentEventSchema } from '../agent-event';

describe('additive context usage', () => {
  it('preserves new observations while an old consumer ignores them', () => {
    const event = { type: 'usage', inputTokens: 123, contextTokens: 0, contextWindow: 1000000, contextSource: 'estimate' };
    expect(AgentEventSchema.parse(event)).toEqual(event);
    // Pre-addition v1 usage variant: Zod objects ignore unknown additive fields.
    const old = z.object({ type: z.literal('usage'), inputTokens: z.number().int().nonnegative().optional(),
      cachedInputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(),
      reasoningTokens: z.number().int().nonnegative().optional(), totalTokens: z.number().int().nonnegative().optional() });
    expect(old.parse(event)).toEqual({ type: 'usage', inputTokens: 123 });
    expect(AgentEventSchema.parse({ type: 'usage', inputTokens: 123 })).toEqual({ type: 'usage', inputTokens: 123 });
  });
  it.each([{ contextTokens: null }, { contextTokens: -1 }, { contextTokens: 0.5 }, { contextWindow: 0 },
    { contextWindow: null }, { contextSource: 'local' }])('rejects invalid context fields (%j)', fields => {
    expect(AgentEventSchema.safeParse({ type: 'usage', ...fields }).success).toBe(false);
  });
});
