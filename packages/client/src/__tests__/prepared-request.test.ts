import { describe, expect, it } from 'vitest';
import {
  compilePreparedRequest,
  PreparedRequestDriftError,
  requestDigest,
  verifyPreparedRequest,
} from '../adapters/pi/prepared-request';

const model = {
  id: 'probe-model',
  name: 'probe model',
  api: 'openai-completions',
  provider: 'byok-probe',
  baseUrl: 'http://127.0.0.1:9/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 4096,
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
};

const context = {
  systemPrompt: 'SYSTEM_MARKER',
  messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
  tools: [],
};

const options = { apiKey: 'synthetic-probe-key', model, sessionId: 'session-probe' };

describe('prepared request compile and verify', () => {
  it('produces the frozen bytes without contacting anything', async () => {
    const prepared = await compilePreparedRequest({ api: 'openai-completions', model, context, options });
    expect(prepared.body.length).toBeGreaterThan(0);
    expect(prepared.digest).toBe(requestDigest(prepared.body));
    expect(JSON.parse(prepared.body).model).toBe('probe-model');
  });

  it('is deterministic for the same explicit inputs', async () => {
    const first = await compilePreparedRequest({ api: 'openai-completions', model, context, options });
    const second = await compilePreparedRequest({ api: 'openai-completions', model, context, options });
    expect(second.digest).toBe(first.digest);
  });

  it('certifies coverage and records key classes', async () => {
    const prepared = await compilePreparedRequest({ api: 'openai-completions', model, context, options });
    expect(prepared.shape.unknown).toEqual([]);
    expect(prepared.shape.classes.messages).toBe('content');
    expect(prepared.shape.classes.model).toBe('content');
  });

  it('refuses to compile for a provider with no recorded shape', async () => {
    await expect(
      compilePreparedRequest({ api: 'some-future-api', model: { ...model, api: 'some-future-api' }, context, options }),
    ).rejects.toThrow(/cannot account for/);
  });

  it('accepts the frozen body and rejects any other', async () => {
    const prepared = await compilePreparedRequest({ api: 'openai-completions', model, context, options });
    expect(() => verifyPreparedRequest(prepared, prepared.body)).not.toThrow();
    expect(() => verifyPreparedRequest(prepared, `${prepared.body} `)).toThrow(PreparedRequestDriftError);
    try {
      verifyPreparedRequest(prepared, '{"model":"other"}');
    } catch (error) {
      expect((error as PreparedRequestDriftError).code).toBe('prepared_request_drift');
      expect((error as PreparedRequestDriftError).expectedDigest).toBe(prepared.digest);
    }
  });
});
