import { describe, expect, it } from 'vitest';

import { ByokKeysError } from './errors';
import {
  OpenAiCompatibleChatClient,
  chatCompletionText,
  type ModelProviderClientOptions,
} from './openai-client';
import type { ProviderFetch } from './http';
import type { ModelProviderProfileInput } from './provider-profile';

const CANARY = 'sk-canary-openai-0001';

const profile = (
  overrides: Partial<ModelProviderProfileInput> = {},
): ModelProviderProfileInput => ({
  adapter: 'openai_compatible',
  auth_mode: 'bearer',
  base_url: 'https://api.openai.com/v1',
  created_at: '2026-08-05T00:00:00.000Z',
  display_name: 'OpenAI',
  enabled: true,
  kind: 'model',
  model: 'gpt-4o-mini',
  provider_id: 'openai',
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

const completion = (text: string) => ({
  choices: [{ message: { content: text, role: 'assistant' } }],
});

const client = (options: Partial<ModelProviderClientOptions> = {}) =>
  new OpenAiCompatibleChatClient({
    profile: profile(),
    secret: CANARY,
    ...options,
  });

const onlyCall = (calls: Call[]): Call => {
  expect(calls).toHaveLength(1);
  return calls[0] as Call;
};

describe('OpenAiCompatibleChatClient', () => {
  it('POSTs to <base_url>/chat/completions', async () => {
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse(completion('{"ok":true}')),
    );
    await client({ fetchImpl }).createChatCompletion({
      messages: [{ content: 'hi', role: 'user' }],
    });
    const call = onlyCall(calls);
    expect(call.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(call.init.method).toBe('POST');
    expect(call.init.redirect).toBe('error');
  });

  it('does not duplicate the suffix when the base URL already ends with it', async () => {
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse(completion('{"ok":true}')),
    );
    await client({
      fetchImpl,
      profile: profile({ base_url: 'https://api.openai.com/v1/chat/completions' }),
    }).createChatCompletion({ messages: [{ content: 'hi', role: 'user' }] });
    expect(onlyCall(calls).url).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
  });

  it('sends the bearer canary in the authorization header only', async () => {
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse(completion('{"ok":true}')),
    );
    await client({ fetchImpl }).createChatCompletion({
      messages: [{ content: 'hi', role: 'user' }],
    });
    const call = onlyCall(calls);
    expect(call.init.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${CANARY}`,
    });
    expect(call.url).not.toContain(CANARY);
    expect(String(call.init.body)).not.toContain(CANARY);
  });

  it('fills model from the profile and passes the caller request through', async () => {
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse(completion('{"ok":true}')),
    );
    await client({ fetchImpl }).createChatCompletion({
      max_tokens: 128,
      messages: [
        { content: 'system prompt', role: 'system' },
        { content: 'user question', role: 'user' },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    });
    expect(JSON.parse(String(onlyCall(calls).init.body))).toEqual({
      max_tokens: 128,
      messages: [
        { content: 'system prompt', role: 'system' },
        { content: 'user question', role: 'user' },
      ],
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      temperature: 0.2,
    });
  });

  it('sends no auth header when auth_mode is none', async () => {
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse(completion('{"ok":true}')),
    );
    await client({
      fetchImpl,
      profile: profile({
        auth_mode: 'none',
        base_url: 'http://localhost:11434/v1',
        provider_id: 'custom',
      }),
      secret: undefined,
    }).createChatCompletion({ messages: [{ content: 'hi', role: 'user' }] });
    expect(onlyCall(calls).init.headers).toEqual({
      accept: 'application/json',
      'content-type': 'application/json',
    });
  });

  it('returns the parsed payload', async () => {
    const { fetchImpl } = recorder(() => jsonResponse(completion('hello')));
    const payload = await client({ fetchImpl }).createChatCompletion({
      messages: [{ content: 'hi', role: 'user' }],
    });
    expect(chatCompletionText(payload)).toBe('hello');
  });

  it.each([
    [401, {}, 'MODEL_PROVIDER_AUTH_FAILED'],
    [403, {}, 'MODEL_PROVIDER_AUTH_FAILED'],
    [402, {}, 'MODEL_PROVIDER_BALANCE_INSUFFICIENT'],
    [404, {}, 'MODEL_PROVIDER_MODEL_NOT_FOUND'],
    [429, {}, 'MODEL_PROVIDER_RATE_LIMITED'],
    [500, {}, 'MODEL_PROVIDER_HTTP_ERROR'],
    [400, { error: { message: 'insufficient_quota' } }, 'MODEL_PROVIDER_BALANCE_INSUFFICIENT'],
    [400, { error: { message: 'invalid_api_key' } }, 'MODEL_PROVIDER_AUTH_FAILED'],
    [400, { error: { message: 'model_not_found' } }, 'MODEL_PROVIDER_MODEL_NOT_FOUND'],
  ])('maps HTTP %i to %s', async (status, body, code) => {
    const { fetchImpl } = recorder(() => jsonResponse(body, status));
    await expect(
      client({ fetchImpl }).createChatCompletion({
        messages: [{ content: 'hi', role: 'user' }],
      }),
    ).rejects.toThrowError(expect.objectContaining({ code }));
  });

  it('maps a non-JSON error body to the classified HTTP error', async () => {
    const { fetchImpl } = recorder(
      () => new Response('<html>gateway timeout</html>', { status: 504 }),
    );
    await expect(
      client({ fetchImpl }).createChatCompletion({
        messages: [{ content: 'hi', role: 'user' }],
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'MODEL_PROVIDER_HTTP_ERROR' }),
    );
  });

  it('rejects invalid JSON on a 200 response', async () => {
    const { fetchImpl } = recorder(() => new Response('not json', { status: 200 }));
    await expect(
      client({ fetchImpl }).createChatCompletion({
        messages: [{ content: 'hi', role: 'user' }],
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'PROVIDER_RESPONSE_INVALID' }),
    );
  });

  it('rejects an oversized response by content-length without reading the body', async () => {
    const { fetchImpl } = recorder(
      () =>
        new Response('{}', {
          status: 200,
          headers: { 'content-length': String(8 * 1024 * 1024) },
        }),
    );
    await expect(
      client({ fetchImpl }).createChatCompletion({
        messages: [{ content: 'hi', role: 'user' }],
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'PROVIDER_RESPONSE_TOO_LARGE' }),
    );
  });

  it('fails closed at construction when the secret is missing', () => {
    expect(() => client({ secret: undefined })).toThrowError(
      expect.objectContaining({ code: 'PROVIDER_SECRET_MISSING' }),
    );
  });

  it('rejects an invalid profile at construction', () => {
    let thrown: unknown;
    try {
      client({ profile: profile({ base_url: 'http://api.openai.com/v1' }) });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ByokKeysError);
    expect((thrown as ByokKeysError).code).toBe('PROVIDER_URL_INVALID');
  });

  it('reports remoteDataTransfer false only for loopback providers', () => {
    expect(client().remoteDataTransfer).toBe(true);
    expect(
      client({
        profile: profile({
          auth_mode: 'none',
          base_url: 'http://localhost:11434/v1',
          provider_id: 'custom',
        }),
        secret: undefined,
      }).remoteDataTransfer,
    ).toBe(false);
  });

  it('testConnection accepts a non-empty completion', async () => {
    const { calls, fetchImpl } = recorder(() =>
      jsonResponse(completion('{"ok":true}')),
    );
    await expect(client({ fetchImpl }).testConnection()).resolves.toBeUndefined();
    expect(onlyCall(calls).url).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
  });

  it('testConnection rejects an empty completion', async () => {
    const { fetchImpl } = recorder(() => jsonResponse(completion('   ')));
    await expect(client({ fetchImpl }).testConnection()).rejects.toThrowError(
      expect.objectContaining({ code: 'MODEL_RESPONSE_INVALID' }),
    );
  });

  it('propagates a caller abort', async () => {
    const controller = new AbortController();
    const fetchImpl: ProviderFetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      });
    const pending = client({ fetchImpl }).createChatCompletion(
      { messages: [{ content: 'hi', role: 'user' }] },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrowError('aborted');
  });
});

describe('chatCompletionText', () => {
  it('joins text blocks from an array content field', () => {
    expect(
      chatCompletionText({
        choices: [
          { message: { content: [{ text: 'a', type: 'text' }, { text: 'b' }] } },
        ],
      }),
    ).toBe('ab');
  });

  it('throws when there is no text at all', () => {
    expect(() => chatCompletionText({ choices: [] })).toThrowError(
      expect.objectContaining({ code: 'MODEL_RESPONSE_INVALID' }),
    );
  });
});
