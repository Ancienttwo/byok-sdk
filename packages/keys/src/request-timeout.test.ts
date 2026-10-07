import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicMessagesClient } from './anthropic-client';
import { fetchWithProviderGuards, PROVIDER_TIMEOUT_MS } from './http';
import { OpenAiCompatibleChatClient } from './openai-client';
import { checkProviderKey, PROVIDER_KEY_CHECK_TIMEOUT_MS } from './provider-key-check';
import { parseModelProviderProfile } from './provider-profile';

const url = 'https://provider.example/v1';
const profile = (anthropic: boolean) => parseModelProviderProfile({
  adapter: anthropic ? 'anthropic' : 'openai_compatible',
  auth_mode: anthropic ? 'x_api_key' : 'bearer',
  base_url: url, capabilities: [], created_at: '2026-08-05T00:00:00.000Z',
  display_name: 'Fixture', enabled: true, kind: 'model', model: 'fixture',
  profile_ref: 'fixture', provider_kind: anthropic ? 'anthropic' : 'openai',
  updated_at: '2026-08-05T00:00:00.000Z',
});
const outcome = <T>(promise: Promise<T>) => {
  let result: unknown = 'pending';
  void promise.then(value => { result = value; }, error => { result = error; });
  return () => result;
};
function stalled() {
  const cancel = vi.fn();
  let source!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { source = controller; }, cancel,
  }));
  return { cancel, response, source };
}
function start(anthropic: boolean, fetchImpl: () => Promise<Response>, requestTimeoutMs?: number, signal?: AbortSignal) {
  const options = { profile: profile(anthropic), secret: 'inert-fixture', fetchImpl, requestTimeoutMs };
  return anthropic
    ? new AnthropicMessagesClient(options).createMessage({ messages: [], max_tokens: 1 }, signal)
    : new OpenAiCompatibleChatClient(options).createChatCompletion({ messages: [] }, signal);
}
afterEach(() => vi.useRealTimers());

describe.each([false, true])('configurable provider deadline (anthropic=%s)', anthropic => {
  it('retains the 15,000 ms default', async () => {
    vi.useFakeTimers();
    const result = outcome(start(anthropic, () => new Promise(() => {})));
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS - 1);
    expect(result()).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(result()).toMatchObject({ code: 'PROVIDER_REQUEST_TIMEOUT' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('allows a valid response after the default deadline with a longer budget', async () => {
    vi.useFakeTimers();
    const result = outcome(start(anthropic, async () => {
      await new Promise(resolve => setTimeout(resolve, 20_000));
      return Response.json({ fixture: true });
    }, 60_000));
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);
    expect(result()).toBe('pending');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(result()).toEqual({ fixture: true });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses one custom budget across headers and a stalled body', async () => {
    vi.useFakeTimers();
    const body = stalled();
    const result = outcome(start(anthropic, async () => {
      await new Promise(resolve => setTimeout(resolve, 40));
      return body.response;
    }, 60));
    await vi.advanceTimersByTimeAsync(59);
    expect(result()).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(result()).toMatchObject({ code: 'PROVIDER_REQUEST_TIMEOUT' });
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps the caller abort reason and disposes once under a custom budget', async () => {
    vi.useFakeTimers();
    const body = stalled();
    const caller = new AbortController();
    const result = outcome(start(anthropic, async () => body.response, 60_000, caller.signal));
    await vi.advanceTimersByTimeAsync(0);
    const reason = new Error('fixture abort');
    caller.abort(reason);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(result()).toBe(reason);
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels late headers once when the injected fetch ignores abort', async () => {
    vi.useFakeTimers();
    const body = stalled();
    let resolve!: (response: Response) => void;
    const result = outcome(start(anthropic, () => new Promise(r => { resolve = r; }), 20));
    await vi.advanceTimersByTimeAsync(20);
    expect(result()).toMatchObject({ code: 'PROVIDER_REQUEST_TIMEOUT' });
    resolve(body.response);
    await vi.advanceTimersByTimeAsync(0);
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, 2_147_483_648, null, '60000'])
  ('rejects invalid constructor timeout %s before fetch', value => {
    const fetchImpl = vi.fn();
    const options = {
      profile: profile(anthropic), secret: 'inert-fixture', fetchImpl,
      requestTimeoutMs: value as number,
    };
    expect(() => anthropic ? new AnthropicMessagesClient(options) : new OpenAiCompatibleChatClient(options))
      .toThrow(RangeError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it.each([1, 2_147_483_647])('accepts supported timer boundary %s', requestTimeoutMs => {
    const options = { profile: profile(anthropic), secret: 'inert-fixture', requestTimeoutMs };
    expect(() => anthropic ? new AnthropicMessagesClient(options) : new OpenAiCompatibleChatClient(options))
      .not.toThrow();
  });
});

describe('guard and key-check budgets', () => {
  it('rejects an invalid direct guard timeout without starting transport or timer', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn();
    await expect(fetchWithProviderGuards(fetchImpl, url, {}, new AbortController().signal, 0))
      .rejects.toThrow(RangeError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, true])('retains the default key-check budget (anthropic=%s)', async anthropic => {
    vi.useFakeTimers();
    const body = stalled();
    const result = outcome(checkProviderKey(profile(anthropic), 'inert-fixture', {
      fetchImpl: async () => body.response,
    }));
    await vi.advanceTimersByTimeAsync(PROVIDER_KEY_CHECK_TIMEOUT_MS - 1);
    expect(result()).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(result()).toBe('timeout');
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retains the client default within an explicitly longer key-check budget', async () => {
    vi.useFakeTimers();
    const result = outcome(checkProviderKey(profile(false), 'inert-fixture', {
      timeoutMs: 60_000, fetchImpl: () => new Promise(() => {}),
    }));
    await vi.advanceTimersByTimeAsync(PROVIDER_TIMEOUT_MS);
    expect(result()).toBe('timeout');
    expect(vi.getTimerCount()).toBe(0);
  });
});
