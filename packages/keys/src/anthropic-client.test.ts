import { describe, expect, it } from 'vitest';

import {
  AnthropicMessagesClient,
  anthropicMessageText,
} from './anthropic-client';
import type { ModelProviderClientOptions } from './openai-client';
import type { ProviderFetch } from './http';
import type { ModelProviderProfileInput } from './provider-profile';

const CANARY = 'sk-ant-canary-0001';

const profile = (
  overrides: Partial<ModelProviderProfileInput> = {},
): ModelProviderProfileInput => ({
  adapter: 'anthropic',
  auth_mode: 'x_api_key',
  base_url: 'https://api.anthropic.com/v1',
  created_at: '2026-08-05T00:00:00.000Z',
  display_name: 'Anthropic',
  enabled: true,
  kind: 'model',
  model: 'claude-sonnet-4-5',
  provider_id: 'anthropic',
  updated_at: '2026-08-05T00:00:00.000Z',
  ...overrides,
});

interface Call {
  url: string;
  init: RequestInit;
}

const recorder = (response: () => Response) => {
  const calls: Call[] = [];
  const fetchImpl: ProviderFetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return response();
  };
  return { calls, fetchImpl };
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const message = (text: string) => ({
  content: [{ text, type: 'text' }],
  role: 'assistant',
});

const client = (options: Partial<ModelProviderClientOptions> = {}) =>
  new AnthropicMessagesClient({
    profile: profile(),
    secret: CANARY,
    ...options,
  });

const onlyCall = (calls: Call[]): Call => {
  expect(calls).toHaveLength(1);
  return calls[0] as Call;
};

describe('AnthropicMessagesClient', () => {
  it('POSTs to <base_url>/messages', async () => {
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse(message('{"ok":true}')),
    );
    await client({ fetchImpl }).createMessage({
      max_tokens: 64,
      messages: [{ content: 'hi', role: 'user' }],
    });
    const call = onlyCall(calls);
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
  });

  it('sends x-api-key plus anthropic-version and keeps the key out of URL and body', async () => {
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse(message('{"ok":true}')),
    );
    await client({ fetchImpl }).createMessage({
      max_tokens: 64,
      messages: [{ content: 'hi', role: 'user' }],
    });
    const call = onlyCall(calls);
    expect(call.init.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': CANARY,
    });
    expect(call.url).not.toContain(CANARY);
    expect(String(call.init.body)).not.toContain(CANARY);
  });

  it('fills model from the profile and passes system and temperature through', async () => {
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse(message('{"ok":true}')),
    );
    await client({ fetchImpl }).createMessage({
      max_tokens: 1_400,
      messages: [{ content: 'user question', role: 'user' }],
      system: 'system prompt',
      temperature: 0.15,
    });
    expect(JSON.parse(String(onlyCall(calls).init.body))).toEqual({
      max_tokens: 1_400,
      messages: [{ content: 'user question', role: 'user' }],
      model: 'claude-sonnet-4-5',
      system: 'system prompt',
      temperature: 0.15,
    });
  });

  it('passes multimodal content blocks through untouched', async () => {
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse(message('{"ok":true}')),
    );
    const content = [
      { source: { data: 'AAAA', media_type: 'image/png', type: 'base64' }, type: 'image' },
      { text: 'describe', type: 'text' },
    ];
    await client({ fetchImpl }).createMessage({
      max_tokens: 64,
      messages: [{ content, role: 'user' }],
    });
    expect(JSON.parse(String(onlyCall(calls).init.body)).messages[0].content).toEqual(
      content,
    );
  });

  it('returns the parsed payload', async () => {
    const { fetchImpl } = recorder(() => jsonResponse(message('hello')));
    const payload = await client({ fetchImpl }).createMessage({
      max_tokens: 64,
      messages: [{ content: 'hi', role: 'user' }],
    });
    expect(anthropicMessageText(payload)).toBe('hello');
  });

  it.each([
    [401, 'MODEL_PROVIDER_AUTH_FAILED'],
    [402, 'MODEL_PROVIDER_BALANCE_INSUFFICIENT'],
    [404, 'MODEL_PROVIDER_MODEL_NOT_FOUND'],
    [429, 'MODEL_PROVIDER_RATE_LIMITED'],
    [529, 'MODEL_PROVIDER_HTTP_ERROR'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { fetchImpl } = recorder(() => jsonResponse({}, status));
    await expect(
      client({ fetchImpl }).createMessage({
        max_tokens: 64,
        messages: [{ content: 'hi', role: 'user' }],
      }),
    ).rejects.toThrowError(expect.objectContaining({ code }));
  });

  it('rejects a profile whose adapter is not anthropic', () => {
    expect(() =>
      client({
        profile: profile({
          adapter: 'openai_compatible',
          auth_mode: 'bearer',
          provider_id: 'openai',
        }),
      }),
    ).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_PROFILE_INVALID' }),
    );
  });

  it('fails closed at construction when the secret is missing', () => {
    expect(() => client({ secret: undefined })).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_SECRET_MISSING' }),
    );
  });

  it('testConnection accepts a non-empty completion', async () => {
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse(message('{"ok":true}')),
    );
    await expect(client({ fetchImpl }).testConnection()).resolves.toBeUndefined();
    expect(onlyCall(calls).url).toBe('https://api.anthropic.com/v1/messages');
  });

  it('testConnection rejects an empty completion', async () => {
    const { fetchImpl } = recorder(() => jsonResponse(message('  ')));
    await expect(client({ fetchImpl }).testConnection()).rejects.toThrowError(
      expect.objectContaining({ code: 'MODEL_RESPONSE_INVALID' }),
    );
  });
});

describe('anthropicMessageText', () => {
  it('joins text blocks and drops non-text blocks', () => {
    expect(
      anthropicMessageText({
        content: [{ text: 'a', type: 'text' }, { type: 'image' }, { text: 'b' }],
      }),
    ).toBe('ab');
  });

  it('throws when content is neither a string nor an array', () => {
    expect(() => anthropicMessageText({ content: 42 })).toThrowError(
      expect.objectContaining({ code: 'MODEL_RESPONSE_INVALID' }),
    );
  });
});
