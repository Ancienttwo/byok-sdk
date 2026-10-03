import { describe, expect, it, vi } from 'vitest';
import { CloudDoError, cloudErrorResponse, safeCloudError } from '../src/errors';
import { PLATFORM_PROFILES, platformCredentialReader, requirePlatformKey } from '../src/platform-credentials';
import { createProviderFetch } from '../src/provider-fetch';
import { createPlatformModels } from '../src/platform-provider';

const KEY = 'sk-proj-Platform_Aa0123456789+Tail/Z9';

describe('read-only platform credentials', () => {
  it('freezes the exact two approved profiles and maps each secret independently', async () => {
    expect(Object.isFrozen(PLATFORM_PROFILES)).toBe(true);
    expect(Object.keys(PLATFORM_PROFILES)).toEqual(['zai_openai', 'deepseek_direct']);
    expect(PLATFORM_PROFILES.zai_openai).toEqual({ vendor: 'zai', baseUrl: 'https://api.z.ai/api/coding/paas/v4', model: 'glm-5.3-flash', binding: 'AIPHABEE_ZAI_API_KEY', secretName: 'model-zai_openai-api-key' });
    expect(PLATFORM_PROFILES.deepseek_direct).toEqual({ vendor: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', binding: 'AIPHABEE_DEEPSEEK_API_KEY', secretName: 'model-deepseek_direct-api-key' });
    for (const profile of Object.values(PLATFORM_PROFILES)) expect(Object.isFrozen(profile)).toBe(true);
    const env = Object.freeze({ AIPHABEE_ZAI_API_KEY: KEY, AIPHABEE_DEEPSEEK_API_KEY: KEY + '_secondary' });
    const reader = platformCredentialReader(env);
    expect(Object.keys(reader)).toEqual(['get']);
    expect(await reader.get('model-zai_openai-api-key')).toBe(KEY);
    expect(await reader.get('model-deepseek_direct-api-key')).toBe(KEY + '_secondary');
    await expect(reader.get('model-openai-api-key')).rejects.toMatchObject({ code: 'CLOUD_MODEL_CREDENTIAL_UNAVAILABLE', status: 503, retryable: false });
  });

  for (const value of [undefined, null, '', 'short', 'a'.repeat(513), `${KEY}\r\nAuthorization: stolen`, `${KEY} `, `${KEY}☃`, 123, {}]) {
    it(`rejects malformed binding ${JSON.stringify(value)} without retaining its value`, async () => {
      let caught: unknown;
      try { await platformCredentialReader({ AIPHABEE_ZAI_API_KEY: value }).get('model-zai_openai-api-key'); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(CloudDoError);
      const error = caught as CloudDoError;
      expect(error).toMatchObject({ code: 'CLOUD_MODEL_CREDENTIAL_UNAVAILABLE', status: 503, retryable: false });
      expect(error.message).toBe('CLOUD_MODEL_CREDENTIAL_UNAVAILABLE');
      expect(error.stack).not.toContain(KEY);
      expect(error.cause).toBeUndefined();
      const response = cloudErrorResponse(error);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: 'CLOUD_MODEL_CREDENTIAL_UNAVAILABLE', retryable: false } });
    });
  }

  it('accepts both token length boundaries and strips upstream message, stack and cause', async () => {
    expect(requirePlatformKey('a'.repeat(16))).toBe('a'.repeat(16));
    expect(requirePlatformKey('a'.repeat(512))).toBe('a'.repeat(512));
    const upstream = new Error(KEY, { cause: new Error(KEY) });
    const safe = safeCloudError(upstream);
    expect(safe.message).toBe('CLOUD_MODEL_REQUEST_FAILED');
    expect(safe.stack).not.toContain(KEY);
    expect(safe.cause).toBeUndefined();
    expect(await cloudErrorResponse(upstream).text()).not.toContain(KEY);
  });
});

describe('pi auth error boundary', () => {
  for (const method of ['stream', 'streamSimple'] as const) {
    for (const fault of ['undefined', 'throw', 'object', 'number']) {
      it(`keeps ${method} ${fault} credential failure fixed before pi events and results`, async () => {
        const upstream = new Error(`${KEY} raw-get-cause`, { cause: new Error(KEY) });
        const reader = { get: async () => {
          if (fault === 'throw') throw upstream;
          if (fault === 'object') return { toString() { throw upstream; } } as unknown as string;
          if (fault === 'number') return 123 as unknown as string;
          return undefined;
        } };
        const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected provider call'));
        try {
          const models = createPlatformModels({ AIPHABEE_ZAI_API_KEY: KEY }, reader);
          const model = models.getModel('zai_openai', 'glm-5.3-flash')!;
          const stream = models[method](model, { messages: [{ role: 'user', content: 'Safe request.', timestamp: 1 }] });
          const events = [];
          for await (const event of stream) events.push(event);
          const result = await stream.result();
          expect(result.stopReason).toBe('error');
          expect(result.errorMessage).toBe('CLOUD_MODEL_CREDENTIAL_UNAVAILABLE');
          expect(events).toMatchObject([{ type: 'error', error: { errorMessage: 'CLOUD_MODEL_CREDENTIAL_UNAVAILABLE' } }]);
          const serialized = JSON.stringify({ events, result });
          expect(serialized).not.toContain(KEY);
          expect(serialized).not.toContain('raw-get-cause');
          expect(serialized).not.toContain('API key auth failed');
          expect(fetch).not.toHaveBeenCalled();
        } finally { fetch.mockRestore(); }
      });
    }
  }
});

describe('frozen credentialed provider transport', () => {
  const profile = PLATFORM_PROFILES.zai_openai;
  const endpoint = `${profile.baseUrl}/chat/completions`;
  it('enforces manual redirect, strips ambient auth headers and never puts a key in the URL/body', async () => {
    let captured: Request | undefined;
    const fetch = createProviderFetch(profile, KEY, async (input, init) => {
      captured = new Request(input, init);
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-provider-secret': KEY } });
    });
    const response = await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer ambient', 'x-api-key': 'ambient', cookie: 'ambient' }, body: '{}' });
    expect(captured!.redirect).toBe('manual');
    expect(captured!.url).toBe(endpoint);
    expect(await captured!.text()).toBe('{}');
    expect(Object.fromEntries(captured!.headers)).toEqual({ accept: 'text/event-stream', authorization: `Bearer ${KEY}`, 'content-type': 'application/json' });
    expect(response.headers.get('x-provider-secret')).toBeNull();
    expect(await response.text()).not.toContain(KEY);
  });
  for (let status = 300; status < 400; status++) it(`rejects every redirect status ${status} with one transport call`, async () => {
    let calls = 0;
    const fetch = createProviderFetch(profile, KEY, async () => {
      calls++;
      return new Response(null, { status, headers: { location: `${endpoint}?apiKey=${KEY}` } });
    });
    await expect(fetch(endpoint, { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'CLOUD_MODEL_REQUEST_FAILED', retryable: false });
    expect(calls).toBe(1);
  });
  for (const url of [`${endpoint}?apiKey=${KEY}`, `${profile.baseUrl}/${KEY}/chat/completions`, 'https://evil.invalid/chat/completions', `${endpoint}#secret`, `${endpoint}/extra`]) it('rejects unfrozen or credential-bearing URL before transport', async () => {
    let calls = 0;
    const fetch = createProviderFetch(profile, KEY, async () => { calls++; return new Response(null); });
    await expect(fetch(url, { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'CLOUD_REQUEST_INVALID', retryable: false });
    expect(calls).toBe(0);
  });
  it('drops thrown transport message, stack and cause without forwarding the exception', async () => {
    const upstream = new Error(KEY, { cause: new Error(KEY) });
    upstream.stack = KEY;
    const fetch = createProviderFetch(profile, KEY, async () => { throw upstream; });
    let caught: unknown;
    try { await fetch(endpoint, { method: 'POST', body: '{}' }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CloudDoError);
    const error = caught as CloudDoError;
    expect(error.message).toBe('CLOUD_MODEL_REQUEST_FAILED');
    expect(error.stack).not.toContain(KEY);
    expect(error.cause).toBeUndefined();
  });
  it('sanitizes malformed credential-bearing URL construction before any transport call', async () => {
    let calls = 0;
    const fetch = createProviderFetch(profile, KEY, async () => { calls++; return new Response(null); });
    let caught: unknown;
    try { await fetch(`https://[${KEY}`, { method: 'POST', body: '{}' }); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(CloudDoError);
    const error = caught as CloudDoError;
    expect(error.message).toBe('CLOUD_REQUEST_INVALID');
    expect(error.retryable).toBe(false);
    expect(error.stack?.includes(KEY)).toBe(false);
    expect(error.cause).toBeUndefined();
    expect(calls).toBe(0);
    expect((await cloudErrorResponse(error).text()).includes(KEY)).toBe(false);
  });
  it('decodes JSON-escaped key content when every upstream read has exactly one byte', async () => {
    const escaped = Array.from(KEY, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
    const payload = new TextEncoder().encode(`data: {"choices":[{"index":0,"delta":{"content":"${escaped}"},"finish_reason":null}]}\n\ndata: [DONE]\n\n`);
    let index = 0;
    let cancelled = false;
    const fetch = createProviderFetch(profile, KEY, async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === payload.length) controller.close();
        else controller.enqueue(payload.slice(index, ++index));
      },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const response = await fetch(endpoint, { method: 'POST', body: '{}' });
    await expect(response.text()).rejects.toMatchObject({ code: 'CLOUD_MODEL_RESPONSE_REJECTED', retryable: false });
    expect(cancelled).toBe(true);
    expect(index).toBeLessThan(payload.length);
  });
});
