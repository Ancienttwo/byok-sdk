import { request } from 'node:http';
import { createMcpHttpServer } from '@byok-sdk/client/mcp-server/http';
import { listenLoopback } from '@byok-sdk/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it, vi } from 'vitest';

it('mounts MCP using the actual bound origin and refuses invalid requests before the authenticated core', async () => {
  let assigned: number | null = null;
  let mcp: ReturnType<typeof createMcpHttpServer> | undefined;
  const dispatch = vi.fn();
  const listener = await listenLoopback({
    portStore: { read: async () => assigned, claim: async candidate => assigned ??= candidate },
    maxBodyBytes: 1024,
    createHandler: origin => {
      mcp = createMcpHttpServer({ origin, serverInfo: { name: 'loopback-test', version: '1' },
        tools: [{ name: 'probe', inputSchema: { type: 'object' } }],
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });
      return request => {
        // Authentication remains Host-owned; listener filtering grants no authority.
        if (request.headers.get('authorization') !== 'Bearer synthetic-test-key') return new Response(null, { status: 401 });
        dispatch();
        return mcp!.fetch(request);
      };
    },
  });
  const client = new Client({ name: 'native-loopback-test', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2025-11-25'] });
  const url = new URL('/mcp', listener.serverUrl);
  try {
    expect((await fetch(url)).status).toBe(401);
    const auth = { authorization: 'Bearer synthetic-test-key' };
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      const outgoing = request(url, { headers: { ...auth, host: 'attacker.example' } }, response => {
        response.resume(); resolve(response.statusCode);
      });
      outgoing.on('error', reject); outgoing.end();
    });
    expect(wrongHost).toBe(403);
    expect((await fetch(url, { headers: { ...auth, origin: 'https://browser.example' } })).status).toBe(403);
    expect((await fetch(url, { method: 'POST', headers: auth, body: 'x'.repeat(1025) })).status).toBe(413);
    expect(dispatch).not.toHaveBeenCalled();
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: auth } }));
    expect((await client.listTools()).tools[0]?.name).toBe('probe');
    expect((await client.callTool({ name: 'probe' })).content).toEqual([{ type: 'text', text: 'ok' }]);
  } finally {
    await client.close();
    mcp?.close();
    await listener.close();
  }
});

function send(url: URL, method: string, headers: Record<string, string>): Promise<{ status?: number; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { method, headers }, response => {
      response.resume(); resolve({ status: response.statusCode, headers: response.headers });
    });
    outgoing.on('error', reject); outgoing.end();
  });
}

it('serves a browser MCP client from an allowed loopback origin through CORS preflight', async () => {
  const browser = 'http://localhost:5173';
  let assigned: number | null = null;
  let mcp: ReturnType<typeof createMcpHttpServer> | undefined;
  const dispatch = vi.fn();
  const listener = await listenLoopback({
    portStore: { read: async () => assigned, claim: async candidate => assigned ??= candidate },
    allowedOrigins: [browser],
    createHandler: origin => {
      mcp = createMcpHttpServer({ origin, allowedOrigins: [browser], serverInfo: { name: 'loopback-test', version: '1' },
        tools: [{ name: 'probe', inputSchema: { type: 'object' } }],
        callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });
      return request => {
        if (request.headers.get('authorization') !== 'Bearer synthetic-test-key') return new Response(null, { status: 401 });
        dispatch();
        return mcp!.fetch(request);
      };
    },
  });
  const url = new URL('/mcp', listener.serverUrl);
  // Header shape of a browser fetch from http://localhost:5173 to the 127.0.0.1 listener.
  const metadata = { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'empty' };
  const preflight = { origin: browser, 'sec-fetch-mode': 'cors', ...metadata, 'access-control-request-method': 'POST',
    'access-control-request-headers': 'authorization,content-type,mcp-protocol-version,mcp-session-id' };
  const client = new Client({ name: 'browser-loopback-test', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2025-11-25'] });
  const exposed: Array<string | null> = [];
  try {
    const allowed = await send(url, 'OPTIONS', preflight);
    expect(allowed.status).toBe(204);
    expect(allowed.headers).toMatchObject({ 'access-control-allow-origin': browser, vary: 'Origin' });
    expect(String(allowed.headers['access-control-allow-methods']).split(', ')).toContain('POST');
    for (const name of ['authorization', 'content-type', 'mcp-protocol-version', 'mcp-session-id']) {
      expect(String(allowed.headers['access-control-allow-headers']).split(', ')).toContain(name);
    }
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined();
    const refused = await send(url, 'OPTIONS', { ...preflight, origin: 'http://localhost:5174' });
    expect(refused.status).toBe(403);
    expect(refused.headers['access-control-allow-origin']).toBeUndefined();
    // Navigations and cookies from an allowed page stay refused.
    expect((await send(url, 'POST', { origin: browser, 'sec-fetch-mode': 'navigate', ...metadata })).status).toBe(403);
    expect((await send(url, 'POST', { origin: browser, 'sec-fetch-mode': 'cors', ...metadata, cookie: 'a=b' })).status).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
    // Native fetch adds Sec-Fetch-Mode: cors; the request is otherwise browser-shaped.
    await client.connect(new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: 'Bearer synthetic-test-key', origin: browser, ...metadata } },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        expect(response.headers.get('access-control-allow-origin')).toBe(browser);
        exposed.push(response.headers.get('access-control-expose-headers'));
        return response;
      },
    }));
    expect((await client.callTool({ name: 'probe' })).content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(exposed.length).toBeGreaterThan(0);
    expect(exposed.every(value => value === 'Mcp-Session-Id')).toBe(true);
  } finally {
    await client.close();
    mcp?.close();
    await listener.close();
  }
});
