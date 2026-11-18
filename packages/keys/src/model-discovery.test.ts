import { describe, expect, it, vi } from 'vitest';
import { ByokKeysError } from './errors.js';
import type { ProviderFetch } from './http.js';
import { discoverProviderModels, type ModelDiscoveryConnection } from './model-discovery.js';

const connection: ModelDiscoveryConnection = {
  adapter: 'openai_compatible', authMode: 'bearer', baseUrl: 'https://example.com/v1/', providerKind: 'custom',
};
const anthropic: ModelDiscoveryConnection = { ...connection, adapter: 'anthropic', authMode: 'x_api_key' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('discoverProviderModels', () => {
  it('lists and sorts OpenAI-compatible models in one request', async () => {
    const fetchImpl = vi.fn<ProviderFetch>(async () => response({ data: [{ id: 'z', name: 'Z' }, { id: 'a' }] }));
    await expect(discoverProviderModels(connection, 'secret', fetchImpl)).resolves.toEqual([
      { id: 'a', name: 'a' }, { id: 'z', name: 'Z' },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://example.com/v1/models');
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer secret');
  });

  it('follows Anthropic pagination with encoded cursors and version header', async () => {
    const fetchImpl = vi.fn<ProviderFetch>()
      .mockResolvedValueOnce(response({ data: [{ id: 'z', display_name: 'Z' }], has_more: true, last_id: 'z +/' }))
      .mockResolvedValueOnce(response({ data: [{ id: 'a', display_name: 'A' }], has_more: false }));
    await expect(discoverProviderModels(anthropic, 'secret', fetchImpl)).resolves.toEqual([
      { id: 'a', name: 'A' }, { id: 'z', name: 'Z' },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(String(fetchImpl.mock.calls[1]?.[0])).searchParams.get('after_id')).toBe('z +/');
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.redirect).toBe('error');
      expect(new Headers(init?.headers).get('anthropic-version')).toBe('2023-06-01');
      expect(new Headers(init?.headers).get('x-api-key')).toBe('secret');
    }
  });

  it('maps HTTP 401 to the auth failure code', async () => {
    const fetchImpl: ProviderFetch = async () => response({}, 401);
    const error = await discoverProviderModels(connection, 'secret', fetchImpl).catch(error => error);
    expect(error).toBeInstanceOf(ByokKeysError);
    expect(error).toMatchObject({ code: 'MODEL_LIST_AUTH_FAILED', httpStatus: 401 });
  });

  it('rejects a repeated Anthropic cursor', async () => {
    const fetchImpl = vi.fn<ProviderFetch>(async () => response({ data: [], has_more: true, last_id: 'same' }));
    const error = await discoverProviderModels(anthropic, 'secret', fetchImpl).catch(error => error);
    expect(error).toBeInstanceOf(ByokKeysError);
    expect(error).toMatchObject({ code: 'MODEL_LIST_INVALID_PAGINATION' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
