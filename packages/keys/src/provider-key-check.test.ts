import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkProviderKey } from './provider-key-check';
import { OpenAiCompatibleChatClient } from './openai-client';
import type { ProviderFetch } from './http';
import { parseModelProviderProfile, type ModelProviderProfileInput } from './provider-profile';
import packageManifest from '../package.json' with { type: 'json' };

const profile = (overrides: Partial<ModelProviderProfileInput> = {}) => parseModelProviderProfile({
  adapter: 'openai_compatible', auth_mode: 'bearer',
  base_url: 'https://api.z.ai/api/coding/paas/v4', capabilities: [],
  created_at: '2026-08-05T00:00:00.000Z', updated_at: '2026-08-05T00:00:00.000Z',
  display_name: 'Probe fixture', enabled: false, kind: 'model', model: 'glm-5.3-flash',
  profile_ref: 'zai-probe', provider_kind: 'zai', ...overrides,
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
// Response metadata from #516. The reasoning text is an inert test value.
const reasoningOnly = {
  choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '', reasoning_content: 'fixture reasoning' } }],
  usage: { completion_tokens: 32, completion_tokens_details: { reasoning_tokens: 29 } },
};
const answer = {
  choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}' } }],
  usage: { completion_tokens: 213, completion_tokens_details: { reasoning_tokens: 206 } },
};

afterEach(() => vi.useRealTimers());

describe('checkProviderKey reasoning probe', () => {
  it('identifies the keys package version in OpenCode Go checks', async () => {
    const fetchImpl = vi.fn<ProviderFetch>(async () => response(answer));
    await checkProviderKey(profile({ provider_kind: 'opencode-go' }), 'inert-fixture', { fetchImpl });
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('user-agent')).toBe(`@byok-sdk/keys/${packageManifest.version}`);
  });
  it('sends a fresh OpenCode session header for each explicit opencode-go check', async () => {
    const openCode = profile({ provider_kind: 'opencode-go' });
    const fetchImpl = vi.fn<ProviderFetch>(async () => response(answer));
    await expect(checkProviderKey(openCode, 'inert-fixture', { fetchImpl })).resolves.toBe('ok');
    await expect(checkProviderKey(openCode, 'inert-fixture', { fetchImpl })).resolves.toBe('ok');
    const sessions = fetchImpl.mock.calls.map(call => new Headers(call[1]?.headers).get('x-opencode-session'));
    expect(sessions[0]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(sessions[1]).toMatch(/^[0-9a-f-]{36}$/u);
    expect(sessions[0]).not.toBe(sessions[1]);
  });
  it.each(['zai', 'opencode-go'] as const)('keeps one check session across the reasoning-only retry for %s and requires a final answer', async (provider_kind) => {
    const fetchImpl = vi.fn<ProviderFetch>()
      .mockImplementationOnce(async () => response(reasoningOnly))
      .mockImplementationOnce(async () => response(answer));
    await expect(checkProviderKey(profile({ provider_kind }), 'inert-fixture', { fetchImpl })).resolves.toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [first, second] = fetchImpl.mock.calls.map(call => call[1]);
    expect(JSON.parse(String(first?.body)).max_tokens).toBe(32);
    expect(JSON.parse(String(second?.body))).toEqual({ ...JSON.parse(String(first?.body)), max_tokens: 2048 });
    for (const call of fetchImpl.mock.calls) {
      expect(String(call[0])).toBe('https://api.z.ai/api/coding/paas/v4/chat/completions');
      expect(call[1]).toMatchObject({ method: 'POST', redirect: 'error' });
      expect(new Headers(call[1]?.headers).get('authorization')).toBe('Bearer inert-fixture');
    }
    const sessions = fetchImpl.mock.calls.map(call => new Headers(call[1]?.headers).get('x-opencode-session'));
    if (provider_kind === 'opencode-go') expect(sessions).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/u), sessions[0]]);
    else expect(sessions).toEqual([null, null]);
  });

  it.each(['', null, undefined])('uses reasoning-token metadata when content is %s', async content => {
    const fetchImpl = vi.fn<ProviderFetch>()
      .mockImplementationOnce(async () => response({ ...reasoningOnly,
        choices: [{ finish_reason: 'length', message: { role: 'assistant', content } }],
      }))
      .mockImplementationOnce(async () => response(answer));
    await expect(checkProviderKey(profile(), 'inert-fixture', { fetchImpl })).resolves.toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('uses reasoning text when the provider omits usage', async () => {
    const fetchImpl = vi.fn<ProviderFetch>()
      .mockImplementationOnce(async () => response({ choices: reasoningOnly.choices }))
      .mockImplementationOnce(async () => response(answer));
    await expect(checkProviderKey(profile(), 'inert-fixture', { fetchImpl })).resolves.toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([reasoningOnly, {}, { choices: [{ message: { content: '   ' } }] }])(
    'rejects a second response without answer text and never sends a third request', async second => {
      const fetchImpl = vi.fn<ProviderFetch>()
        .mockImplementationOnce(async () => response(reasoningOnly))
        .mockImplementation(async () => response(second));
      await expect(checkProviderKey(profile(), 'inert-fixture', { fetchImpl })).resolves.toBe('provider_error');
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    {},
    { choices: [{ finish_reason: 'length', message: { content: '' } }] },
    { choices: [{ finish_reason: 'stop', message: reasoningOnly.choices[0]!.message }] },
  ])('rejects HTTP 200 without a retry unless it proves reasoning was cut short', async body => {
    const fetchImpl = vi.fn<ProviderFetch>(async () => response(body));
    await expect(checkProviderKey(profile(), 'inert-fixture', { fetchImpl })).resolves.toBe('provider_error');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([[false, 'zai'], [true, 'zai'], [false, 'opencode-go'], [true, 'opencode-go']] as const)('keeps HTTP failure outcomes (on retry=%s, kind=%s)', async (onRetry, provider_kind) => {
    for (const [status, expected] of [[401, 'credential_rejected'], [403, 'model_not_permitted'],
      [429, 'rate_limited'], [500, 'provider_error']] as const) {
      const fetchImpl = vi.fn<ProviderFetch>(async () => response({}, status));
      if (onRetry) fetchImpl.mockImplementationOnce(async () => response(reasoningOnly));
      await expect(checkProviderKey(profile({ provider_kind }), 'inert-fixture', { fetchImpl })).resolves.toBe(expected);
      expect(fetchImpl).toHaveBeenCalledTimes(onRetry ? 2 : 1);
    }
  });

  it.each([
    { provider_kind: 'openai', model: 'gpt-4o-mini' },
    { provider_kind: 'custom', model: 'glm-5.3-flash' },
    { provider_kind: 'custom', model: 'deepseek-v4.1-flash', base_url: 'https://opencode.ai/inference/go/openai/v1' },
    { provider_kind: 'zai', model: 'glm-4' },
  ] as const)('keeps the first probe unchanged for %s', async overrides => {
    const fetchImpl = vi.fn<ProviderFetch>(async () => response(answer));
    await expect(checkProviderKey(profile(overrides), 'inert-fixture', { fetchImpl })).resolves.toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('x-opencode-session')).toBeNull();
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      max_tokens: 32, model: overrides.model,
      messages: [{ content: 'Return one JSON object with exactly this shape: {"ok":true}.', role: 'user' }],
      response_format: { type: 'json_object' }, temperature: 0,
    });
  });

  it('does not retry a length response that already has answer text', async () => {
    const fetchImpl = vi.fn<ProviderFetch>(async () => response({ ...reasoningOnly,
      choices: [{ finish_reason: 'length', message: { ...reasoningOnly.choices[0]!.message, content: 'ok' } }],
    }));
    await expect(checkProviderKey(profile(), 'inert-fixture', { fetchImpl })).resolves.toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the 10-second key-check deadline across both requests', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<ProviderFetch>()
      .mockImplementationOnce(async () => {
        await new Promise(resolve => setTimeout(resolve, 8_000));
        return response(reasoningOnly);
      })
      .mockImplementation(() => new Promise(() => {}));
    const pending = checkProviderKey(profile(), 'inert-fixture', { fetchImpl });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(pending).resolves.toBe('timeout');
    expect(fetchImpl.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the direct-client deadline across both requests', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<ProviderFetch>()
      .mockImplementationOnce(async () => {
        await new Promise(resolve => setTimeout(resolve, 80));
        return response(reasoningOnly);
      })
      .mockImplementation(() => new Promise(() => {}));
    const client = new OpenAiCompatibleChatClient({ profile: profile(), secret: 'inert-fixture', fetchImpl, requestTimeoutMs: 100 });
    const result = client.testConnection().catch(error => error);
    await vi.advanceTimersByTimeAsync(80);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(20);
    await expect(result).resolves.toMatchObject({ code: 'PROVIDER_REQUEST_TIMEOUT' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honors caller cancellation during the retry and clears timers', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<ProviderFetch>()
      .mockImplementationOnce(async () => response(reasoningOnly))
      .mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const client = new OpenAiCompatibleChatClient({ profile: profile(), secret: 'inert-fixture', fetchImpl });
    const result = client.testConnection(controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    controller.abort();
    await expect(result).resolves.toBe(controller.signal.reason);
    expect(vi.getTimerCount()).toBe(0);
  });
});
