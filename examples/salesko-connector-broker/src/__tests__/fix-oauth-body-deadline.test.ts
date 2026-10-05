import { PassThrough } from 'node:stream';
import { GmailConnectorBroker } from '../broker';
import { GMAIL_SEARCH_TOOL_NAME, serveConnectorMcp } from '../mcp-server';
import { InMemorySecretStore } from '@byok-sdk/keys';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GOOGLE_GMAIL_READONLY_SCOPE, GOOGLE_TOKEN_ENDPOINT,
  GoogleOAuthAccessTokenSource, configureGoogleOAuthClient,
  exchangeGoogleAuthorizationCode, googleOAuthRefreshSecretName,
  type GoogleFetch,
} from '../google-oauth';

const CLIENT = { clientId: '123456789012-fixture.apps.googleusercontent.com', clientSecret: 'inert-client-secret' };
const TOKEN = { access_token: 'inert-access-token', expires_in: 3600, token_type: 'Bearer', scope: GOOGLE_GMAIL_READONLY_SCOPE };
const AUTHORIZATION = { code: 'inert-code', codeVerifier: 'A'.repeat(64), redirectUri: 'http://127.0.0.1:49152/oauth/callback' };
const json = (value: unknown) => new Response(JSON.stringify(value));

async function source(fetchImpl: GoogleFetch) {
  const store = new InMemorySecretStore<string>();
  await configureGoogleOAuthClient(store, 'default', CLIENT);
  await store.set(googleOAuthRefreshSecretName('default'), JSON.stringify({
    refreshToken: 'inert-refresh-token', accountEmail: 'fixture@example.com',
    grantedScopes: [GOOGLE_GMAIL_READONLY_SCOPE], connectedAt: '2026-08-13T12:00:00.000Z',
  }));
  return new GoogleOAuthAccessTokenSource(store, { fetchImpl });
}

function streamFixture() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel }));
  return { response, cancel, controller };
}

afterEach(() => vi.useRealTimers());

describe('S20-F1 OAuth body deadline', () => {
  it('aborts a stalled refresh body, releases its reader, and permits the next request', async () => {
    vi.useFakeTimers();
    const body = streamFixture();
    let signal: AbortSignal | null | undefined;
    const fetchImpl = vi.fn<GoogleFetch>().mockImplementationOnce(async (_url, init) => {
      signal = init?.signal;
      return body.response;
    }).mockImplementation(async () => json(TOKEN));
    const tokens = await source(fetchImpl);
    const use = vi.fn(async () => 'used');
    let failure: unknown;
    const pending = tokens.withAccessToken('default', use).catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(signal?.aborted).toBe(true);
    expect(failure).toMatchObject({ code: 'PROVIDER_FAILED', message: 'Google OAuth request failed' });
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(body.response.body?.locked).toBe(false);
    expect(use).not.toHaveBeenCalled();
    await pending;
    await expect(tokens.withAccessToken('default', use)).resolves.toBe('used');
    expect(use).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the account-profile body inside its deadline', async () => {
    vi.useFakeTimers();
    const body = streamFixture();
    let signal: AbortSignal | null | undefined;
    let failure: unknown;
    const pending = exchangeGoogleAuthorizationCode({ client: CLIENT, authorization: AUTHORIZATION,
      fetchImpl: async (url, init) => {
        if (String(url) === GOOGLE_TOKEN_ENDPOINT) return json({ ...TOKEN, refresh_token: 'inert-refresh-token' });
        signal = init?.signal;
        return body.response;
      },
    }).catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(signal?.aborted).toBe(true);
    expect(failure).toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(body.response.body?.locked).toBe(false);
    await pending;
  });

  it('does not reset the absolute deadline when body bytes arrive', async () => {
    vi.useFakeTimers();
    const body = streamFixture();
    const tokens = await source(async () => body.response);
    let failure: unknown;
    const pending = tokens.withAccessToken('default', async () => 'unused').catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(10_000);
    body.controller.enqueue(new TextEncoder().encode('{'));
    await vi.advanceTimersByTimeAsync(5_001);
    expect(failure).toMatchObject({ code: 'PROVIDER_FAILED' });
    await pending;
  });

  it('accepts a slowly streamed valid response before the deadline and clears the timer', async () => {
    vi.useFakeTimers();
    const body = streamFixture();
    let signal: AbortSignal | null | undefined;
    const tokens = await source(async (_url, init) => { signal = init?.signal; return body.response; });
    const pending = tokens.withAccessToken('default', async token => token);
    await vi.advanceTimersByTimeAsync(5_000);
    const encoded = new TextEncoder().encode(JSON.stringify(TOKEN));
    body.controller.enqueue(encoded.slice(0, 10));
    await vi.advanceTimersByTimeAsync(5_000);
    body.controller.enqueue(encoded.slice(10));
    body.controller.close();
    await expect(pending).resolves.toBe(TOKEN.access_token);
    expect(body.response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(signal?.aborted).toBe(false);
  });

  it('unblocks the sequential MCP transport after a stalled refresh', async () => {
    vi.useFakeTimers();
    const body = streamFixture();
    const searchCorrespondence = vi.fn(async () => []);
    const broker = new GmailConnectorBroker({
      profileId: 'default',
      policy: { allowedDomains: ['example.com'], maxResults: 5, maxAgeDays: 30 },
      tokenSource: await source(async () => body.response),
      provider: { searchCorrespondence },
    });
    const input = new PassThrough();
    const output = new PassThrough();
    let bytes = '';
    output.setEncoding('utf8');
    output.on('data', (chunk: string) => { bytes += chunk; });
    const serving = serveConnectorMcp(broker, { input, output });
    input.end([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: GMAIL_SEARCH_TOOL_NAME,
        arguments: { domains: ['example.com'], limit: 2, newerThanDays: 7 },
      } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ].map(request => JSON.stringify(request) + '\n').join(''));
    await vi.advanceTimersByTimeAsync(15_001);
    const responses = bytes.trim().split('\n').map(line => JSON.parse(line));
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({ id: 1, error: { data: { brokerCode: 'PROVIDER_FAILED' } } });
    expect(responses[1]).toMatchObject({ id: 2, result: { tools: expect.any(Array) } });
    expect(searchCorrespondence).not.toHaveBeenCalled();
    await serving;
  });

  it.each(['declared', 'streamed'])('cancels a %s oversized body without leaking a reader or timer', async kind => {
    vi.useFakeTimers();
    const body = streamFixture();
    if (kind === 'declared') body.response.headers.set('content-length', String(65_537));
    else body.controller.enqueue(new Uint8Array(65_537));
    const tokens = await source(async () => body.response);
    await expect(tokens.withAccessToken('default', async () => 'unused')).rejects.toMatchObject({ code: 'PROVIDER_RESPONSE_INVALID' });
    expect(body.cancel).toHaveBeenCalledTimes(1);
    expect(body.response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });


  it('shares one deadline across delayed headers and a stalled body', async () => {
    vi.useFakeTimers();
    const body = streamFixture();
    const tokens = await source(async () => {
      await new Promise(resolve => setTimeout(resolve, 10_000));
      return body.response;
    });
    let failure: unknown;
    const pending = tokens.withAccessToken('default', async () => 'unused').catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(failure).toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(body.cancel).toHaveBeenCalledTimes(1);
    await pending;
  });

  it('does not wait indefinitely for the body source cancellation promise', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
    const tokens = await source(async () => response);
    let failure: unknown;
    const pending = tokens.withAccessToken('default', async () => 'unused').catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(failure).toMatchObject({ code: 'PROVIDER_FAILED' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await pending;
  });

});
