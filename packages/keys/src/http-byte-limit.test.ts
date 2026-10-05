import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithProviderGuards, parseBoundedJsonResponse, PROVIDER_RESPONSE_MAX_BYTES, readModelProviderResponse } from './http';

const url = 'https://provider.example/v1';
const encoder = new TextEncoder();
const outcome = (promise: Promise<unknown>) => {
  let result: unknown = 'pending';
  void promise.then(value => { result = value; }, error => { result = error; });
  return () => result;
};
afterEach(() => vi.useRealTimers());

function oversized(headers?: Record<string, string>) {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  let pulls = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      if (pulls === 1) controller.enqueue(new Uint8Array(PROVIDER_RESPONSE_MAX_BYTES));
      else if (pulls === 2) controller.enqueue(new Uint8Array(1));
      // No EOF; pulling again is observable without unbounded allocation.
    }, cancel,
  }, { highWaterMark: 0 }), { headers });
  return { response, cancel, pulls: () => pulls };
}

describe('provider streaming response byte limit', () => {
  it.each([undefined, '1'])('stops at first crossing chunk with content-length %s and no EOF', async length => {
    vi.useFakeTimers();
    const source = oversized(length ? { 'content-length': length } : undefined);
    const result = outcome(parseBoundedJsonResponse(source.response));
    await vi.advanceTimersByTimeAsync(0);
    expect(result()).toMatchObject({ code: 'PROVIDER_RESPONSE_TOO_LARGE' });
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(source.pulls()).toBe(2);
    expect(source.response.body!.locked).toBe(false);
  });
  it('stops guarded transport read-ahead, cancels ownership and releases deadline/listener', async () => {
    vi.useFakeTimers();
    const source = oversized();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    const response = await fetchWithProviderGuards(async () => source.response, url, {}, caller.signal);
    const result = outcome(readModelProviderResponse(response));
    await vi.advanceTimersByTimeAsync(0);
    expect(result()).toMatchObject({ code: 'PROVIDER_RESPONSE_TOO_LARGE' });
    expect(source.pulls()).toBe(2);
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(source.response.body!.locked).toBe(false);
    expect(response.body!.locked).toBe(false);
  });
  it.each([-1, 0, 1])('enforces raw UTF-8 byte boundary at limit %+d', async delta => {
    const value = 'é'.repeat((PROVIDER_RESPONSE_MAX_BYTES - 2) / 2) + (delta > 0 ? 'a' : '');
    const bytes = encoder.encode(JSON.stringify(delta < 0 ? value.slice(1) + 'a' : value));
    expect(bytes.byteLength).toBe(PROVIDER_RESPONSE_MAX_BYTES + delta);
    // Split inside the first multi-byte code point to exercise incremental decoding.
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.subarray(0, 2));
      controller.enqueue(bytes.subarray(2));
      controller.close();
    } }));
    if (delta > 0) await expect(parseBoundedJsonResponse(response)).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_TOO_LARGE' });
    else await expect(parseBoundedJsonResponse(response)).resolves.toBe(delta < 0 ? value.slice(1) + 'a' : value);
    expect(response.body!.locked).toBe(false);
  });
  it('cancels an oversized declared length before any source pull', async () => {
    const source = oversized({ 'content-length': String(PROVIDER_RESPONSE_MAX_BYTES + 1) });
    await expect(parseBoundedJsonResponse(source.response)).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_TOO_LARGE' });
    expect(source.pulls()).toBe(0);
    expect(source.cancel).toHaveBeenCalledTimes(1);
    expect(source.response.body!.locked).toBe(false);
  });
  it('rejects a single oversized chunk without decoding it or waiting for cancellation', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => Promise.reject(new Error('fixture cancellation failure')));
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(PROVIDER_RESPONSE_MAX_BYTES + 1)); }, cancel,
    }));
    const decode = vi.spyOn(TextDecoder.prototype, 'decode');
    try {
      const result = outcome(parseBoundedJsonResponse(response));
      await vi.advanceTimersByTimeAsync(0);
      expect(result()).toMatchObject({ code: 'PROVIDER_RESPONSE_TOO_LARGE' });
      expect(decode).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(response.body!.locked).toBe(false);
    } finally { decode.mockRestore(); }
  });
  it('preserves BOM and split UTF-8 decoding with empty chunks', async () => {
    const bytes = encoder.encode('\uFEFF{"text":"👋é"}');
    let offset = 0;
    const response = new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      controller.enqueue(new Uint8Array());
      if (offset === bytes.length) controller.close();
      else controller.enqueue(bytes.subarray(offset, ++offset));
    } }, { highWaterMark: 0 }));
    await expect(parseBoundedJsonResponse(response)).resolves.toEqual({ text: '👋é' });
  });
  it('preserves malformed-JSON classification and releases the reader', async () => {
    const response = new Response('{');
    await expect(parseBoundedJsonResponse(response)).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
    expect(response.body!.locked).toBe(false);
    await expect(parseBoundedJsonResponse(response)).rejects.toBeInstanceOf(TypeError);
  });
  it('preserves source error identity and releases the reader', async () => {
    const error = new TypeError('fixture body read failed');
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(error); } }));
    await expect(parseBoundedJsonResponse(response)).rejects.toBe(error);
    expect(response.body!.locked).toBe(false);
  });
  it('classifies a null body as invalid JSON', async () => {
    await expect(parseBoundedJsonResponse(new Response(null, { status: 204 }))).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
  });
  it('preserves byte-limit errors on non-success HTTP responses', async () => {
    vi.useFakeTimers();
    const source = oversized();
    const response = new Response(source.response.body, { status: 401 });
    const result = outcome(readModelProviderResponse(response));
    await vi.advanceTimersByTimeAsync(0);
    expect(result()).toMatchObject({ code: 'PROVIDER_RESPONSE_TOO_LARGE' });
    expect(source.cancel).toHaveBeenCalledTimes(1);
  });

});
