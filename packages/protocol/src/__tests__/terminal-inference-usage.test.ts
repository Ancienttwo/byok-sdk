import { describe, expect, it } from 'vitest';
import { EnvelopeValidationError, parseMessage } from '../index';

const HEADER = {
  v: 1,
  id: '00000000-0000-4000-8000-000000000201',
  ts: '2026-08-21T10:00:00.000Z',
  task_id: 'task-inference-usage',
};

const usage = {
  runtime: 'codex',
  provider: 'openai',
  model: 'gpt-5',
  promptTokens: 120,
  completionTokens: 45,
  durationMs: 2_500,
  clientVersion: '0.6.0',
  reportedAt: '2026-08-21T10:00:02.500Z',
};

function terminal(type: 'task.complete' | 'task.fail' | 'task.cancelled', terminalUsage: unknown) {
  const payload = type === 'task.complete'
    ? { summary: 'done', sessionRef: 'session-1', usage: terminalUsage }
    : type === 'task.fail'
      ? { reason: 'runtime failed', retryable: false, usage: terminalUsage }
      : { reason: 'operator cancelled', usage: terminalUsage };
  return { ...HEADER, type, payload };
}

describe('TerminalInferenceUsage terminal payload contract', () => {
  it.each(['task.complete', 'task.fail', 'task.cancelled'] as const)(
    '%s round-trips the complete bounded observation unchanged',
    (type) => {
      const parsed = parseMessage(terminal(type, usage));
      expect(parsed.payload).toMatchObject({ usage });
    },
  );

  it.each(['task.complete', 'task.fail', 'task.cancelled'] as const)(
    '%s remains valid when a legacy daemon omits usage',
    (type) => {
      const source = terminal(type, undefined) as { payload: Record<string, unknown> };
      delete source.payload.usage;
      const parsed = parseMessage(source);
      expect(Object.hasOwn(parsed.payload, 'usage')).toBe(false);
    },
  );

  it.each([
    ['negative token count', { ...usage, promptTokens: -1 }],
    ['fractional token count', { ...usage, completionTokens: 1.5 }],
    ['unsafe token count', { ...usage, promptTokens: Number.MAX_SAFE_INTEGER }],
    ['oversized token count', { ...usage, promptTokens: 1_000_000_001 }],
    ['oversized duration', { ...usage, durationMs: 604_800_001 }],
    ['oversized provider', { ...usage, provider: 'p'.repeat(161) }],
    ['oversized model', { ...usage, model: 'm'.repeat(161) }],
    ['oversized client version', { ...usage, clientVersion: 'v'.repeat(129) }],
    ['non-UTC timestamp', { ...usage, reportedAt: '2026-08-21T18:00:02.500+08:00' }],
    ['malformed timestamp', { ...usage, reportedAt: 'not-a-timestamp' }],
  ])('rejects %s on every terminal variant', (_label, invalidUsage) => {
    for (const type of ['task.complete', 'task.fail', 'task.cancelled'] as const) {
      expect(() => parseMessage(terminal(type, invalidUsage))).toThrow(EnvelopeValidationError);
    }
  });
});
