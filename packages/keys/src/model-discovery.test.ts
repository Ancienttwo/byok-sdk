import { describe, expect, it, vi } from 'vitest';
import { ByokKeysError, discoverProviderModels, type ModelDiscoveryConnection } from './index.js';
import { PROVIDER_RESPONSE_MAX_BYTES, PROVIDER_TIMEOUT_MS, type ProviderFetch } from './http.js';

const connection: ModelDiscoveryConnection = {
  adapter: 'openai_compatible', auth_mode: 'bearer', base_url: 'https://example.com/v1/',
};
const anthropic: ModelDiscoveryConnection = { ...connection, adapter: 'anthropic', auth_mode: 'x_api_key' };
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

  it('wraps an unreachable provider error without exposing connection details', async () => {
    const cause = new TypeError('fetch failed for https://example.com/v1 with secret');
    const fetchImpl: ProviderFetch = async () => { throw cause; };
    const error = await discoverProviderModels(connection, 'secret', fetchImpl).catch(error => error);
    expect(error).toBeInstanceOf(ByokKeysError);
    expect(error).toMatchObject({ code: 'MODEL_LIST_UNREACHABLE', message: 'Model list provider is unreachable', cause });
  });

  it('maps a transport failure while reading an HTTP 200 response and preserves its cause', async () => {
    const cause = new TypeError('terminated', { cause: new Error('socket closed') });
    const first = new TextEncoder().encode('{"data":');
    let reads = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads += 1;
        if (reads === 1) controller.enqueue(first);
        else controller.error(cause);
      },
    }, { highWaterMark: 0 });
    const fetchImpl: ProviderFetch = async () => new Response(body, { status: 200 });
    const error = await discoverProviderModels(connection, 'secret', fetchImpl).catch(error => error);
    expect(reads).toBe(2);
    expect(error).toBeInstanceOf(ByokKeysError);
    expect(error).toMatchObject({ code: 'MODEL_LIST_UNREACHABLE', message: 'Model list provider is unreachable' });
    expect(error.cause).toBe(cause);
  });

  it('preserves a TypeError from decoding instead of classifying it as transport failure', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue('not a byte chunk');
        controller.close();
      },
    });
    await expect(discoverProviderModels(connection, 'secret', async () => new Response(body)))
      .rejects.toBeInstanceOf(TypeError);
  });

  it('preserves the request timeout for a stalled successful response body', async () => {
    vi.useFakeTimers();
    const overallTimeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    try {
      const pull = vi.fn();
      const body = new ReadableStream({ pull }, { highWaterMark: 0 });
      const outcome = discoverProviderModels(connection, 'secret', async () => new Response(body)).catch(error => error);
      await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);
      expect(pull).toHaveBeenCalled();
      expect(await outcome).toMatchObject({ code: 'PROVIDER_REQUEST_TIMEOUT' });
    } finally {
      overallTimeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it('preserves the invalid JSON classification', async () => {
    await expect(discoverProviderModels(connection, 'secret', async () => new Response('{invalid')))
      .rejects.toMatchObject({ code: 'MODEL_LIST_INVALID_RESPONSE' });
  });

  it('preserves the response byte limit classification', async () => {
    const body = new Uint8Array(PROVIDER_RESPONSE_MAX_BYTES + 1);
    await expect(discoverProviderModels(connection, 'secret', async () => new Response(body)))
      .rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_TOO_LARGE' });
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
