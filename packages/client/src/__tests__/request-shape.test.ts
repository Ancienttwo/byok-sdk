import { describe, expect, it } from 'vitest';
import {
  assertRequestShape,
  classifyRequestShape,
  CONTENT_REQUEST_KEYS,
  OPENAI_COMPLETIONS_REQUEST_KEYS,
  RequestShapeDriftError,
} from '../adapters/pi/request-shape';

/** The keys a real `openai-completions` request carried when this was measured. */
const OBSERVED_REQUEST = {
  model: 'probe-model',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
  store: false,
  max_completion_tokens: 1024,
  stream_options: { include_usage: true },
  tools: [{ type: 'function' }],
};

describe('request shape classification', () => {
  it('accepts the request the provider actually builds today', () => {
    const report = assertRequestShape('openai-completions', OBSERVED_REQUEST);
    expect(report.unknown).toEqual([]);
    expect(report.classes.messages).toBe('content');
    expect(report.classes.max_completion_tokens).toBe('framing');
    expect(report.classes.store).toBe('transport');
  });

  it('refuses a key it cannot account for instead of counting approximately', () => {
    const drifted = { ...OBSERVED_REQUEST, brand_new_key: 1 };
    expect(() => assertRequestShape('openai-completions', drifted)).toThrow(RequestShapeDriftError);
    try {
      assertRequestShape('openai-completions', drifted);
    } catch (error) {
      expect((error as RequestShapeDriftError).unknownKeys).toEqual(['brand_new_key']);
      expect((error as RequestShapeDriftError).code).toBe('request_shape_drift');
    }
  });

  it('treats an unknown provider api as drift too', () => {
    const report = classifyRequestShape('some-future-api', OBSERVED_REQUEST);
    expect(report.unknown).toEqual(Object.keys(OBSERVED_REQUEST).sort());
    expect(() => assertRequestShape('some-future-api', OBSERVED_REQUEST)).toThrow(RequestShapeDriftError);
  });

  it('reports absent known keys without refusing, because keys are conditional', () => {
    const report = assertRequestShape('openai-completions', { model: 'x', messages: [], stream: true });
    expect(report.absent).toContain('store');
    expect(report.unknown).toEqual([]);
  });

  it('exposes exactly the content keys the counter must measure', () => {
    expect(CONTENT_REQUEST_KEYS).toEqual(['messages', 'model', 'tools']);
    expect(CONTENT_REQUEST_KEYS.every((key) => OPENAI_COMPLETIONS_REQUEST_KEYS[key] === 'content')).toBe(true);
  });
});
