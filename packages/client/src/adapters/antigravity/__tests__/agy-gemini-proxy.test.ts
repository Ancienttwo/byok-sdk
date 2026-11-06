import { once } from 'node:events';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startAgyGeminiProxy, type AgyGeminiProxy } from '../agy-gemini-proxy';

const REAL_KEY = 'real-gemini-key-canary';

interface Seen { readonly method?: string; readonly url?: string; readonly headers: IncomingHttpHeaders; readonly body: string }

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

async function listen(handler: RequestListener): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function recordingUpstream(answer: RequestListener = (_, response) => { response.end('ok'); }) {
  const seen: Seen[] = [];
  const { origin } = await listen((message, response) => {
    let body = '';
    message.setEncoding('utf8').on('data', chunk => { body += chunk; }).on('end', () => {
      seen.push({ method: message.method, url: message.url, headers: message.headers, body });
      void answer(message, response);
    });
  });
  return { seen, origin };
}

async function proxyTo(upstreamOrigin: string): Promise<AgyGeminiProxy> {
  const proxy = await startAgyGeminiProxy({ apiKey: REAL_KEY, environment: {}, upstreamOrigin });
  cleanups.push(() => proxy.close());
  return proxy;
}

const call = (proxy: AgyGeminiProxy, path: string, headers: Record<string, string> = {}, body = '') =>
  new Promise<{ status?: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const { hostname, port } = new URL(proxy.url);
    const outgoing = request({ hostname, port, path, method: 'POST', headers, setHost: !('host' in headers) }, response => {
      let text = '';
      response.setEncoding('utf8').on('data', chunk => { text += chunk; }).on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: text }));
    });
    outgoing.on('error', reject).end(body);
  });

describe('agy Gemini proxy', () => {
  it('swaps the session token for the real key and relays the upstream answer unchanged', async () => {
    const quotaError = '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}';
    const { seen, origin } = await recordingUpstream((_, response) => {
      response.writeHead(429, { 'retry-after': '7' }).end(quotaError);
    });
    const proxy = await proxyTo(origin);

    const byHeader = await call(proxy, '/v1beta/models/m:streamGenerateContent?alt=sse', { 'x-goog-api-key': proxy.token, authorization: `Bearer ${proxy.token}` }, '{"contents":[]}');
    const byQuery = await call(proxy, `/v1beta/models/m:generateContent?key=${proxy.token}&alt=json`);

    expect(byHeader).toMatchObject({ status: 429, body: quotaError, headers: { 'retry-after': '7' } });
    expect(byQuery.status).toBe(429);
    expect(seen.map(({ method, url, body }) => [method, url, body])).toEqual([
      ['POST', '/v1beta/models/m:streamGenerateContent?alt=sse', '{"contents":[]}'],
      ['POST', '/v1beta/models/m:generateContent?alt=json', ''],
    ]);
    expect(seen.map(({ headers }) => headers['x-goog-api-key'])).toEqual([REAL_KEY, REAL_KEY]);
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain(proxy.token);
  });

  it('refuses a request without the session token before anything leaves the machine', async () => {
    const { seen, origin } = await recordingUpstream();
    const proxy = await proxyTo(origin);

    const answers = await Promise.all([
      call(proxy, '/v1beta/models'),
      call(proxy, '/v1beta/models', { 'x-goog-api-key': 'wrong' }),
      call(proxy, '/v1beta/models?key=wrong'),
      call(proxy, '/v1beta/models', { 'x-goog-api-key': proxy.token.slice(1) }),
    ]);

    expect(answers.map(answer => answer.status)).toEqual([401, 401, 401, 401]);
    expect(seen).toEqual([]);
  });

  it('sends every accepted request to the fixed origin, whatever the request names', async () => {
    const { seen, origin } = await recordingUpstream();
    const elsewhere = await recordingUpstream();
    const proxy = await proxyTo(origin);
    const otherHost = new URL(elsewhere.origin).host;
    const key = { 'x-goog-api-key': proxy.token };

    await call(proxy, `${elsewhere.origin}/absolute`, key);
    await call(proxy, `//${otherHost}/relative`, key);
    await call(proxy, '/host-header', { ...key, host: otherHost });

    expect(elsewhere.seen).toEqual([]);
    expect(seen.map(({ url }) => url)).toEqual(['/absolute', '/relative', '/host-header']);
    expect(new Set(seen.map(({ headers }) => headers.host))).toEqual(new Set([new URL(origin).host]));
  });

  it('streams the response as it arrives', async () => {
    let finish!: () => void;
    const released = new Promise<void>(resolve => { finish = resolve; });
    const { origin } = await recordingUpstream(async (_, response) => {
      response.write('data: first\n\n');
      await released;
      response.end('data: second\n\n');
    });
    const proxy = await proxyTo(origin);

    const { hostname, port } = new URL(proxy.url);
    const outgoing = request({ hostname, port, path: '/stream', method: 'POST', headers: { 'x-goog-api-key': proxy.token } });
    outgoing.end();
    const [response] = await once(outgoing, 'response') as [IncomingMessage];
    response.setEncoding('utf8');
    const [first] = await once(response, 'data');
    expect(first).toBe('data: first\n\n');

    finish();
    const [second] = await once(response, 'data');
    expect(second).toBe('data: second\n\n');
  });

  it('answers 502 when the upstream cannot be reached', async () => {
    const { server, origin } = await listen(() => {});
    await new Promise(resolve => server.close(resolve));
    const proxy = await proxyTo(origin);

    const answer = await call(proxy, '/v1beta/models', { 'x-goog-api-key': proxy.token });

    expect(answer.status).toBe(502);
    expect(answer.body).not.toContain(REAL_KEY);
  });

  it('reaches the Gemini origin through the proxy the task environment names, and never quotes that proxy', async () => {
    const { server, origin } = await listen((_, response) => { response.end(); });
    const tunnels: Array<string | undefined> = [];
    server.on('connect', (message, socket) => {
      tunnels.push(message.url);
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    });
    const withCredentials = `http://user:secret@${new URL(origin).host}`;
    const proxy = await startAgyGeminiProxy({ apiKey: REAL_KEY, environment: { HTTPS_PROXY: withCredentials } });
    cleanups.push(() => proxy.close());

    const answer = await call(proxy, '/v1beta/models', { 'x-goog-api-key': proxy.token });

    expect(tunnels).toEqual(['generativelanguage.googleapis.com:443']);
    expect(answer.status).toBe(502);
    expect(answer.body).not.toContain('secret');
    await expect(startAgyGeminiProxy({ apiKey: REAL_KEY, environment: { HTTPS_PROXY: 'http://user:secret@host:port' } })).rejects.toThrow(/^agy Gemini proxy: .*invalid proxy URL$/);
  });

  it('listens on loopback only, and close aborts a request still waiting upstream and frees the port', async () => {
    let upstreamReached!: () => void;
    const reached = new Promise<void>(resolve => { upstreamReached = resolve; });
    let upstreamClosed!: () => void;
    const closed = new Promise<void>(resolve => { upstreamClosed = resolve; });
    const { origin } = await listen((_, response) => {
      response.on('close', upstreamClosed);
      upstreamReached();
    });
    const proxy = await startAgyGeminiProxy({ apiKey: REAL_KEY, environment: {}, upstreamOrigin: origin });
    expect(proxy.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    void call(proxy, '/v1beta/models', { 'x-goog-api-key': proxy.token }).catch(() => {});
    await reached;
    await proxy.close();

    await closed;
    await expect(call(proxy, '/v1beta/models', { 'x-goog-api-key': proxy.token })).rejects.toThrow();
  });
});
