import { describe, expect, it } from 'vitest';
import { mapPiContextUsage } from '../adapters/pi/events';
import { createToolUseCorrelation, mapClaudeMessageToAgentEvents } from '../adapters/claude/events';

describe('context usage is independent of provider cost', () => {
  it('Pi reports actual zero as estimate without any provider counters', () => {
    expect(mapPiContextUsage({ contextUsage: { tokens: 0, contextWindow: 1000000, percent: 0 }, tokens: { input: 999 } }))
      .toEqual({ type: 'usage', contextTokens: 0, contextWindow: 1000000, contextSource: 'estimate' });
  });
  it('Pi compaction null clears occupancy; Host window has authority', () => {
    expect(mapPiContextUsage({ contextUsage: { tokens: null, contextWindow: 1000000, percent: null } }, 200000))
      .toEqual({ type: 'usage', contextWindow: 200000, contextSource: 'estimate' });
  });
  it.each([undefined, { contextUsage: null }, { contextUsage: { tokens: -1, contextWindow: 0 } }])('unknown stays absent (%j)', data => {
    expect(mapPiContextUsage(data)).toEqual({ type: 'usage', contextSource: 'estimate' });
  });
  it('Claude reports provider window from modelUsage and preserves cost counters', () => {
    const mapped = mapClaudeMessageToAgentEvents({ type: 'result', is_error: false,
      modelUsage: { 'init-model': { contextWindow: 1000000 } }, usage: { input_tokens: 10, output_tokens: 2 } },
      createToolUseCorrelation(), { workspaceDir: '/tmp' });
    expect(mapped.events).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 2, contextWindow: 1000000, contextSource: 'provider' },
      { type: 'turn_end' },
    ]);
  });
});
