import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithProviderGuards, PROVIDER_TIMEOUT_MS, readModelProviderResponse } from './http';
import { OpenAiCompatibleChatClient } from './openai-client';
import { AnthropicMessagesClient } from './anthropic-client';
import { checkProviderKey } from './provider-key-check';
import { parseModelProviderProfile } from './provider-profile';

const url = 'https://provider.example/v1';
const profile = (anthropic = false) => parseModelProviderProfile({
  adapter: anthropic ? 'anthropic' : 'openai_compatible', auth_mode: anthropic ? 'x_api_key' : 'bearer',
  base_url: url, capabilities: [], created_at: '2026-08-05T00:00:00.000Z',
  display_name: 'Fixture', enabled: true, kind: 'model', model: 'fixture', profile_ref: 'fixture',
  provider_kind: anthropic ? 'anthropic' : 'openai', updated_at: '2026-08-05T00:00:00.000Z',
});
function stalled() {
  const cancel = vi.fn();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(c) { source = c; }, cancel }));
  return { response, cancel, source };
}
const outcome = <T>(promise: Promise<T>) => {
  let result: unknown = 'pending';
  void promise.then(value => { result = value; }, error => { result = error; });
  return () => result;
};
afterEach(() => vi.useRealTimers());

describe('provider total round-trip deadline', () => {
  it('bounds stalled headers even when the injected transport ignores abort', async () => {
    vi.useFakeTimers();
    const result = outcome(fetchWithProviderGuards(() => new Promise(() => {}), url, {}, new AbortController().signal));
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);
    expect(result()).toMatchObject({ code: 'PROVIDER_REQUEST_TIMEOUT' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses the original deadline for a stalled body and cancels its owned reader', async () => {
    vi.useFakeTimers();
    const body = stalled();
    const result = outcome(fetchWithProviderGuards(async () => {
      await new Promise(resolve => setTimeout(resolve, 10_000));
      return body.response;
    }, url, {}, new AbortController().signal).then(readModelProviderResponse));
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);
    expect(result()).toMatchObject({ code: 'PROVIDER_REQUEST_TIMEOUT' });
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, true])('aborts after headers through client (anthropic=%s)', async anthropic => {
    vi.useFakeTimers();
    const body = stalled();
    const caller = new AbortController();
    let transportSignal: AbortSignal | null | undefined;
    const options = { profile: profile(anthropic), secret: 'inert-fixture', fetchImpl: async (_input: string | URL | Request, init?: RequestInit) => {
      transportSignal = init?.signal;
      return body.response;
    } };
    const operation = anthropic
      ? new AnthropicMessagesClient(options).createMessage({ messages: [], max_tokens: 1 }, caller.signal)
      : new OpenAiCompatibleChatClient(options).createChatCompletion({ messages: [] }, caller.signal);
    const result = outcome(operation);
    await vi.advanceTimersByTimeAsync(0);
    const reason = new DOMException('fixture abort', 'AbortError');
    caller.abort(reason);
    await vi.advanceTimersByTimeAsync(0);
    expect(result()).toBe(reason);
    expect(transportSignal?.aborted).toBe(true);
    expect(transportSignal?.reason).toBe(reason);
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, true])('honors a client requestTimeoutMs longer than the default (anthropic=%s)', async anthropic => {
    vi.useFakeTimers();
    const body = stalled();
    const requestTimeoutMs = 60_000;
    const options = { profile: profile(anthropic), secret: 'inert-fixture', requestTimeoutMs, fetchImpl: async () => body.response };
    const operation = anthropic
      ? new AnthropicMessagesClient(options).createMessage({ messages: [], max_tokens: 1 })
      : new OpenAiCompatibleChatClient(options).createChatCompletion({ messages: [] });
    const result = outcome(operation);
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);
    expect(result()).toBe('pending');
    expect(body.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(requestTimeoutMs - PROVIDER_TIMEOUT_MS);
    expect(result()).toMatchObject({ code: 'PROVIDER_REQUEST_TIMEOUT' });
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])('rejects requestTimeoutMs %s at construction', requestTimeoutMs => {
    const options = { profile: profile(), secret: 'inert-fixture', requestTimeoutMs };
    expect(() => new OpenAiCompatibleChatClient(options)).toThrow(RangeError);
    expect(() => new AnthropicMessagesClient({ ...options, profile: profile(true) })).toThrow(RangeError);
  });
  it('key check expires while reading and never accepts a late valid body', async () => {
    vi.useFakeTimers();
    const body = stalled();
    const result = outcome(checkProviderKey(profile(), 'inert-fixture', { timeoutMs: 20, fetchImpl: async () => body.response }));
    await vi.advanceTimersByTimeAsync(20);
    expect(result()).toBe('timeout');
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(() => body.source.enqueue(new TextEncoder().encode('{"choices":[{"message":{"content":"ok"}}]}'))).toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels a response that arrives after the header deadline', async () => {
    vi.useFakeTimers();
    const body = stalled();
    let resolve!: (response: Response) => void;
    const result = outcome(fetchWithProviderGuards(() => new Promise(r => { resolve = r; }), url, {}, new AbortController().signal));
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);
    expect(result()).toMatchObject({ code: 'PROVIDER_REQUEST_TIMEOUT' });
    resolve(body.response);
    await vi.advanceTimersByTimeAsync(0);
    expect(body.cancel).toHaveBeenCalledTimes(1);
  });
  it('does not call fetch for a pre-aborted caller', async () => {
    const caller = new AbortController();
    caller.abort();
    const fetchImpl = vi.fn();
    await expect(fetchWithProviderGuards(fetchImpl, url, {}, caller.signal)).rejects.toBe(caller.signal.reason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('keeps direct response consumption guarded without waiting for a stuck cancel hook', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = await fetchWithProviderGuards(async () => new Response(new ReadableStream({ cancel })), url, {}, new AbortController().signal);
    const result = outcome(response.text());
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);
    expect(result()).toMatchObject({ code: 'PROVIDER_REQUEST_TIMEOUT' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('releases the timer and caller listener after success', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    const response = await fetchWithProviderGuards(async () => new Response('{"ok":true}'), url, {}, caller.signal);
    await expect(readModelProviderResponse(response)).resolves.toEqual({ ok: true });
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    caller.abort();
  });
  it('cancels ownership and clears the deadline when a caller discards the body', async () => {
    vi.useFakeTimers();
    const body = stalled();
    const response = await fetchWithProviderGuards(async () => body.response, url, {}, new AbortController().signal);
    await response.body!.cancel('discard');
    expect(body.cancel).toHaveBeenCalledWith('discard');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cleans up an early content-length rejection without implementing a streaming byte ceiling', async () => {
    vi.useFakeTimers();
    const body = stalled();
    body.response.headers.set('content-length', '9999999');
    const response = await fetchWithProviderGuards(async () => body.response, url, {}, new AbortController().signal);
    await expect(readModelProviderResponse(response)).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_TOO_LARGE' });
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves body errors and releases the deadline', async () => {
    vi.useFakeTimers();
    const body = stalled();
    const response = await fetchWithProviderGuards(async () => body.response, url, {}, new AbortController().signal);
    const error = new TypeError('fixture disconnect');
    body.source.error(error);
    await expect(readModelProviderResponse(response)).rejects.toBe(error);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([401, 429, 500])('preserves HTTP error mapping for status %s', async status => {
    vi.useFakeTimers();
    const response = await fetchWithProviderGuards(async () => new Response('invalid JSON', { status }), url, {}, new AbortController().signal);
    await expect(readModelProviderResponse(response)).rejects.toMatchObject({
      code: status === 401 ? 'MODEL_PROVIDER_AUTH_FAILED' : status === 429 ? 'MODEL_PROVIDER_RATE_LIMITED' : 'MODEL_PROVIDER_HTTP_ERROR', httpStatus: status,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves response metadata and successful delayed JSON under the original deadline', async () => {
    vi.useFakeTimers();
    const body = stalled();
    Object.defineProperty(body.response, 'url', { value: `${url}/models` });
    const caller = new AbortController();
    const response = await fetchWithProviderGuards(async () => body.response, url, {}, caller.signal);
    expect(response.url).toBe(`${url}/models`);
    expect(response.status).toBe(200);
    expect(response.type).toBe(body.response.type);
    const result = outcome(readModelProviderResponse(response));
    await vi.advanceTimersByTimeAsync(100);
    body.source.enqueue(new TextEncoder().encode('{"ok":true}'));
    body.source.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(result()).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['handoff', 'late-fetch', 'active-body'] as const)(
    'disposes exactly once for a microtask abort during %s, even if cancellation never settles',
    async phase => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const remove = vi.spyOn(caller.signal, 'removeEventListener');
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
      let resolve!: (response: Response) => void;
      const pending = new Promise<Response>(r => { resolve = r; });
      const reason = new Error('handoff abort');
      const operation = fetchWithProviderGuards(() => pending, url, {}, caller.signal);
      const result = outcome(operation.then(readModelProviderResponse));
      if (phase === 'handoff') {
        // Runs after the helper's late-response observer, but before its
        // Promise.race await continuation acquires the body's reader.
        void pending.then(() => caller.abort(reason));
        resolve(response);
      } else if (phase === 'late-fetch') {
        caller.abort(reason);
        await vi.advanceTimersByTimeAsync(0);
        resolve(response);
      } else {
        resolve(response);
        await vi.advanceTimersByTimeAsync(0);
        expect(response.body!.locked).toBe(true);
        caller.abort(reason);
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(result()).toBe(reason);
      expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
      expect(response.body!.locked).toBe(false);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledTimes(1);
    },
  );

});
