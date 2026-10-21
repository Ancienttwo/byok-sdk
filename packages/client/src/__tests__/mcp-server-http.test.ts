import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpServerToolError } from '../mcp-server';
import { createMcpHttpServer, MCP_HTTP_MAX_BODY_BYTES, type McpHttpServer, type McpHttpServerOptions } from '../mcp-server/http';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const tool = { name: 'echo', inputSchema: { type: 'object' } };
const defaults = { serverInfo: { name: 'http-core-test', version: '1' }, tools: [tool],
  callTool: async ({ arguments: args }: { arguments: Readonly<Record<string, unknown>> | undefined }) =>
    ({ content: [{ type: 'text', text: JSON.stringify(args ?? {}) }] }) };

// Only converts the native HTTP socket to Web Request/Response. It implements
// no MCP behavior. All MCP messages go through the production HTTP framing.
async function host(options: Partial<McpHttpServerOptions> = {}, create = createMcpHttpServer) {
  let mcp: McpHttpServer;
  let origin: string;
  const requests: Array<{ method: string; session: string | null; status: number }> = [];
  const disconnects = new Set<string>();
  const http: Server = createServer(async (incoming, outgoing) => {
    const abort = new AbortController();
    outgoing.on('close', () => {
      abort.abort();
      const session = incoming.headers['mcp-session-id'];
      if (typeof session === 'string') disconnects.add(session);
    });
    try {
      const request = new Request(new URL(incoming.url ?? '/', origin), { method: incoming.method,
        headers: incoming.headers as Record<string, string>, signal: abort.signal,
        ...(incoming.method === 'POST' ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}),
      } as RequestInit);
      const response = await mcp.fetch(request);
      requests.push({ method: request.method, session: request.headers.get('mcp-session-id'), status: response.status });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) {
        const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
        outgoing.on('close', () => body.destroy());
        body.on('error', () => outgoing.destroy());
        body.pipe(outgoing);
      } else outgoing.end();
    } catch { outgoing.writeHead(500).end(); }
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('missing HTTP address');
  origin = `http://127.0.0.1:${address.port}`;
  mcp = create({ ...defaults, origin, ...options });
  cleanups.push(async () => { mcp.close(); http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  return { mcp, requests, disconnects, url: new URL('/mcp', origin), origin };
}

async function client(server: Awaited<ReturnType<typeof host>>, version = '2025-11-25') {
  const errors: Error[] = [];
  const transport = new StreamableHTTPClientTransport(server.url);
  const peer = new Client({ name: 'standard-http-client', version: '1' },
    { capabilities: {}, enforceStrictCapabilities: true, supportedProtocolVersions: [version] });
  peer.onerror = error => errors.push(error);
  await peer.connect(transport, { timeout: 5000 });
  cleanups.push(async () => { await peer.close(); });
  return { peer, transport, errors };
}

function post(server: Awaited<ReturnType<typeof host>>, message: unknown, session?: string, headers: Record<string, string> = {}) {
  return fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    ...(session ? { 'mcp-session-id': session } : {}), ...headers }, body: JSON.stringify(message) });
}
async function initialize(server: Awaited<ReturnType<typeof host>>) {
  const response = await post(server, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  expect(response.status).toBe(200);
  await response.json();
  return response.headers.get('mcp-session-id')!;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe('Streamable HTTP against the standard MCP client over real sockets', () => {
  it.each(['2025-11-25', '2025-06-18'])('negotiates %s, lists and calls tools without SSE', async version => {
    const server = await host();
    const { peer, transport, errors } = await client(server, version);
    expect(peer.getNegotiatedProtocolVersion()).toBe(version);
    expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(peer.getServerCapabilities()).toEqual({ tools: {} });
    expect((await peer.listTools()).tools).toEqual([tool]);
    expect(await peer.callTool({ name: 'echo', arguments: { text: 'first\nsecond' } })).toEqual({ content: [{ type: 'text', text: '{"text":"first\\nsecond"}' }] });
    await vi.waitFor(() => expect(server.requests.some(request => request.method === 'GET' && request.status === 405)).toBe(true));
    expect(server.requests.some(request => request.method === 'POST' && request.status === 202)).toBe(true);
    expect(errors).toEqual([]);
  });

  it.each(['2025-11-25', '2025-06-18'])('streams scoped progress and metadata over HTTP %s', async version => {
    const definition = { ...tool, title: 'Echo', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } };
    const server = await host({ tools: [definition], callTool: async call => {
      call.progress(0, 1, 'starting'); call.progress(1, 1, 'done');
      return { content: [], structuredContent: { ok: true } };
    } });
    const { peer, errors } = await client(server, version);
    expect((await peer.listTools()).tools).toEqual([definition]);
    const progress: unknown[] = [];
    expect(await peer.callTool({ name: 'echo' }, { onprogress: value => { progress.push(value); } })).toEqual({ content: [], structuredContent: { ok: true } });
    expect(progress).toEqual([{ progress: 0, total: 1, message: 'starting' }, { progress: 1, total: 1, message: 'done' }]);
    expect(await peer.callTool({ name: 'echo' })).toEqual({ content: [], structuredContent: { ok: true } });
    expect(progress).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('keeps progress streams isolated and suppresses cancelled and completed callbacks', async () => {
    const calls = new Map<string, { report: (value: number) => void; signal: AbortSignal; finish: () => void }>();
    const server = await host({ callTool: call => new Promise(resolve => {
      calls.set(String(call.arguments?.label), { report: call.progress, signal: call.signal, finish: () => resolve({ content: [] }) });
    }) });
    const { peer, errors } = await client(server);
    const a: unknown[] = []; const b: unknown[] = []; const abort = new AbortController();
    const first = peer.callTool({ name: 'echo', arguments: { label: 'a' } }, { signal: abort.signal, onprogress: value => { a.push(value); } }).catch(error => error);
    const second = peer.callTool({ name: 'echo', arguments: { label: 'b' } }, { onprogress: value => { b.push(value); } });
    try {
      await vi.waitFor(() => expect(calls.size).toBe(2));
      calls.get('a')!.report(1); calls.get('b')!.report(2);
      await vi.waitFor(() => { expect(a).toEqual([{ progress: 1 }]); expect(b).toEqual([{ progress: 2 }]); });
      abort.abort(); await first;
      await vi.waitFor(() => expect(calls.get('a')!.signal.aborted).toBe(true));
      calls.get('a')!.report(3); calls.get('a')!.finish(); calls.get('b')!.finish();
      expect(await second).toEqual({ content: [] });
      calls.get('b')!.report(4); await peer.ping();
      expect(a).toEqual([{ progress: 1 }]); expect(b).toEqual([{ progress: 2 }]); expect(errors).toEqual([]);
    } finally { for (const call of calls.values()) call.finish(); await Promise.allSettled([first, second]); }
  });

  it.each(['overflow', 'close'])('errors an unfinished progress stream on %s', async reason => {
    let report!: (value: number, total?: number, message?: string) => void;
    let signal!: AbortSignal; let finish!: () => void;
    const mcp = createMcpHttpServer({ ...defaults, origin: 'http://localhost', callTool: call => {
      report = call.progress; signal = call.signal; return new Promise(resolve => { finish = () => resolve({}); });
    } });
    const request = (message: unknown, session?: string) => new Request('http://localhost/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) }, body: JSON.stringify(message) });
    try {
      const initialized = await mcp.fetch(request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }));
      const response = await mcp.fetch(request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', _meta: { progressToken: 0 } } }, initialized.headers.get('mcp-session-id')!));
      await vi.waitFor(() => expect(report).toBeTypeOf('function'));
      if (reason === 'close') mcp.close();
      else for (let i = 0; i < 7; i++) {
        report(i, undefined, 'x'.repeat(800_000));
        // Drain core writes while deliberately leaving this POST unread.
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      await expect(response.text()).rejects.toThrow(/MCP stream terminated/);
      if (reason === 'overflow') {
        const ping = await mcp.fetch(request({ jsonrpc: '2.0', id: 3, method: 'ping' }, initialized.headers.get('mcp-session-id')!));
        expect(ping.status).toBe(200); expect(await ping.json()).toMatchObject({ id: 3, result: {} });
      }
    } finally { finish?.(); mcp.close(); }
  });

  it('keeps isError tool results and typed errors intact', async () => {
    const server = await host({ callTool: async call => {
      if (call.arguments?.throw) throw new McpServerToolError(-32001, 'declined', { retryable: false });
      return { isError: true, content: [{ type: 'text', text: 'refused' }] };
    } });
    const { peer } = await client(server);
    expect(await peer.callTool({ name: 'echo', arguments: {} })).toEqual({ isError: true, content: [{ type: 'text', text: 'refused' }] });
    await expect(peer.callTool({ name: 'echo', arguments: { throw: true } })).rejects.toMatchObject({ code: -32001, data: { retryable: false } });
  });

  it('preserves public typed errors through the built HTTP distribution entry', async () => {
    const { createMcpHttpServer: createBuilt } = await import('../../dist/mcp-server/http.js');
    const { McpServerToolError: PublicError } = await import('@byok-sdk/client/mcp-server');
    const server = await host({ callTool: async () => { throw new PublicError(-32001, 'declined', { retryable: false }); } }, createBuilt);
    const { peer } = await client(server);
    await expect(peer.callTool({ name: 'echo' })).rejects.toMatchObject({ code: -32001, data: { retryable: false } });
  });

  it('delivers list_changed on the opt-in GET SSE stream and releases the subscription', async () => {
    const listeners = new Set<() => void>();
    const server = await host({ toolsListChanged: { onToolsListChanged(notify) { listeners.add(notify); return () => { listeners.delete(notify); }; } } });
    const { peer, transport, errors } = await client(server);
    const notifications: unknown[] = [];
    peer.setNotificationHandler('notifications/tools/list_changed', notification => { notifications.push(notification); });
    expect(peer.getServerCapabilities()).toEqual({ tools: { listChanged: true } });
    await vi.waitFor(() => expect(server.requests.some(request => request.method === 'GET' && request.status === 200)).toBe(true));
    for (const notify of listeners) notify();
    await vi.waitFor(() => expect(notifications).toHaveLength(1));
    await transport.terminateSession();
    expect(listeners.size).toBe(0);
    expect(errors).toEqual([]);
  });

  it('isolates equal request IDs and cancellation between independent clients', async () => {
    const calls = new Map<string, AbortSignal>();
    const release = deferred<Record<string, unknown>>();
    const server = await host({ callTool: async call => { calls.set(String(call.arguments?.client), call.signal); return release.promise; } });
    const a = await client(server); const b = await client(server);
    const abort = new AbortController();
    const first = a.peer.callTool({ name: 'echo', arguments: { client: 'a' } }, { signal: abort.signal }).catch(error => error);
    const second = b.peer.callTool({ name: 'echo', arguments: { client: 'b' } });
    await vi.waitFor(() => expect(calls.size).toBe(2));
    abort.abort(); await first;
    await vi.waitFor(() => expect(calls.get('a')!.aborted).toBe(true));
    expect(calls.get('b')!.aborted).toBe(false);
    release.resolve({ content: [{ type: 'text', text: 'done' }] });
    expect(await second).toEqual({ content: [{ type: 'text', text: 'done' }] });
    expect(a.errors).toEqual([]); expect(b.errors).toEqual([]);
  });
});

describe('HTTP admission, bounds and cleanup', () => {
  it('checks Origin on POST, GET and DELETE without trusting the Host header', async () => {
    const server = await host(); const session = await initialize(server);
    for (const method of ['POST', 'GET', 'DELETE']) {
      for (const origin of ['https://attacker.example', 'null', `${server.origin}/`, 'http://localhost:9']) {
        const response = await fetch(server.url, { method, headers: { origin, host: 'attacker.example', 'mcp-session-id': session } });
        expect(response.status).toBe(403);
      }
    }
    expect((await post(server, { jsonrpc: '2.0', id: 1, method: 'ping' }, session, { origin: server.origin })).status).toBe(200);
  });

  it('accepts only exact configured allowedOrigins in addition to origin', async () => {
    const browser = 'http://localhost:5173';
    const server = await host({ allowedOrigins: [browser] }); const session = await initialize(server);
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    for (const origin of [browser, server.origin]) expect((await post(server, ping, session, { origin })).status).toBe(200);
    for (const origin of [`${browser}/`, 'http://localhost:5174', 'null']) expect((await post(server, ping, session, { origin })).status).toBe(403);
  });

  it('rejects remote cleartext and invalid resource bounds at construction', () => {
    for (const origin of ['http://remote.example', 'https://user:secret@example.test', 'https://example.test/path', 'null']) {
      expect(() => createMcpHttpServer({ ...defaults, origin })).toThrow();
      expect(() => createMcpHttpServer({ ...defaults, origin: 'https://example.test', allowedOrigins: [origin] })).toThrow();
    }
    for (const limits of [{ maxBodyBytes: 0 }, { maxBodyBytes: MCP_HTTP_MAX_BODY_BYTES + 1 }, { maxSessions: Infinity }, { idleTimeoutMs: -1 }, { maxInFlight: 0 }]) {
      expect(() => createMcpHttpServer({ ...defaults, origin: 'https://example.test', ...limits })).toThrow();
    }
  });

  it('enforces content type, Accept, method and protocol headers', async () => {
    const server = await host(); const session = await initialize(server);
    const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
    expect((await post(server, ping, session, { accept: 'application/json' })).status).toBe(406);
    expect((await post(server, ping, session, { accept: 'application/json;q=0, text/event-stream' })).status).toBe(406);
    expect((await post(server, ping, session, { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await post(server, ping, session, { 'mcp-protocol-version': '2025-03-26' })).status).toBe(400);
    expect((await post(server, ping, session, { 'mcp-protocol-version': '2025-06-18' })).status).toBe(400);
    expect((await fetch(server.url, { method: 'PUT' })).status).toBe(405);
    expect((await post(server, ping)).status).toBe(400);
    expect((await post(server, ping, 'unknown')).status).toBe(404);
    const removed = await fetch(server.url, { method: 'DELETE', headers: { 'mcp-session-id': session } });
    expect(removed.status).toBe(204);
    expect((await post(server, ping, session)).status).toBe(404);
  });

  it('rejects malformed input and retains the core request validation', async () => {
    const callTool = vi.fn(defaults.callTool);
    const server = await host({ callTool }); const session = await initialize(server);
    const response = await post(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: null } }, session);
    expect(await response.json()).toMatchObject({ error: { code: -32602 } });
    const duplicate = await post(server, { jsonrpc: '2.0', id: 1, method: 'ping' }, session);
    expect(await duplicate.json()).toMatchObject({ error: { code: -32600 } });
    expect((await post(server, [], session)).status).toBe(400);
    const invalid = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': session }, body: '{' });
    expect(invalid.status).toBe(400);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('caps declared and chunked bodies at 4 MiB before dispatch', async () => {
    const callTool = vi.fn(defaults.callTool);
    const server = await host({ callTool });
    const oversized = 'x'.repeat(MCP_HTTP_MAX_BODY_BYTES + 1);
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    expect((await fetch(server.url, { method: 'POST', headers, body: oversized })).status).toBe(413);
    let cancelled = false;
    const response = await server.mcp.fetch(new Request(server.url, { method: 'POST', headers,
      body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(oversized)); }, cancel() { cancelled = true; } }), duplex: 'half' } as RequestInit));
    expect(response.status).toBe(413); expect(cancelled).toBe(true);
    expect(callTool).not.toHaveBeenCalled();
  });

  it('closes the session instead of sending a partial oversized response', async () => {
    const server = await host({ maxOutboundFrameBytes: 1024,
      callTool: async () => ({ content: [{ type: 'text', text: 'x'.repeat(2048) }] }) });
    const session = await initialize(server);
    const response = await post(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } }, session);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('MCP session closed');
    expect((await post(server, { jsonrpc: '2.0', id: 2, method: 'ping' }, session)).status).toBe(404);
  });

  it('keeps an in-flight response bound to its original call on duplicate IDs', async () => {
    const entered = deferred<void>(); const release = deferred<Record<string, unknown>>();
    const server = await host({ callTool: async () => { entered.resolve(); return release.promise; } });
    const session = await initialize(server);
    const first = post(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } }, session);
    await entered.promise;
    expect((await post(server, { jsonrpc: '2.0', id: 1, method: 'ping' }, session)).status).toBe(400);
    release.resolve({ content: [{ type: 'text', text: 'original' }] });
    expect(await (await first).json()).toMatchObject({ result: { content: [{ type: 'text', text: 'original' }] } });
  });

  it('bounds sessions and closes active calls without accepting new work', async () => {
    const entered = deferred<AbortSignal>(); const release = deferred<Record<string, unknown>>();
    const server = await host({ maxSessions: 1, callTool: async call => { entered.resolve(call.signal); return release.promise; } });
    const session = await initialize(server);
    const response = post(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } }, session);
    const signal = await entered.promise;
    expect((await post(server, { jsonrpc: '2.0', id: 0, method: 'initialize' })).status).toBe(503);
    server.mcp.close(); server.mcp.close();
    expect((await response).status).toBe(503); expect(signal.aborted).toBe(true);
    expect((await post(server, { jsonrpc: '2.0', id: 2, method: 'ping' }, session)).status).toBe(503);
    release.resolve({});
  });

  it('evicts the oldest idle session at admission after standard clients close', async () => {
    const server = await host({ maxSessions: 2 });
    const a = await client(server); const aId = a.transport.sessionId!;
    await vi.waitFor(() => expect(server.requests.some(request => request.session === aId && request.method === 'GET' && request.status === 405)).toBe(true));
    await a.peer.close();
    const b = await client(server); const bId = b.transport.sessionId!;
    await vi.waitFor(() => expect(server.requests.some(request => request.session === bId && request.method === 'GET' && request.status === 405)).toBe(true));
    await b.peer.close();
    const c = await client(server);
    expect((await c.peer.listTools()).tools).toEqual([tool]);
    expect((await post(server, { jsonrpc: '2.0', id: 9, method: 'ping' }, aId)).status).toBe(404);
    expect((await post(server, { jsonrpc: '2.0', id: 9, method: 'ping' }, bId)).status).toBe(200);
  });

  it('returns 413 for an expanded canonical frame without closing the session', async () => {
    const callTool = vi.fn(defaults.callTool);
    const server = await host({ maxBodyBytes: 1024, callTool }); const session = await initialize(server);
    const raw = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"values":[${Array(150).fill('9e20').join(',')}]}}}`;
    expect(Buffer.byteLength(raw)).toBeLessThan(1024);
    expect(Buffer.byteLength(JSON.stringify(JSON.parse(raw)))).toBeGreaterThan(1024);
    const response = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-session-id': session }, body: raw });
    expect(response.status).toBe(413); expect(callTool).not.toHaveBeenCalled();
    expect((await post(server, { jsonrpc: '2.0', id: 2, method: 'ping' }, session)).status).toBe(200);
  });

  it('expires idle sessions and releases their emitter subscriptions', async () => {
    const unsubscribe = vi.fn();
    const server = await host({ idleTimeoutMs: 20, toolsListChanged: { onToolsListChanged: () => unsubscribe } });
    const session = await initialize(server);
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
    expect((await post(server, { jsonrpc: '2.0', id: 1, method: 'ping' }, session)).status).toBe(404);
  });

  it('does not treat a disconnected POST as task or MCP cancellation', async () => {
    const entered = deferred<AbortSignal>(); const release = deferred<Record<string, unknown>>();
    const server = await host({ callTool: async call => { entered.resolve(call.signal); return release.promise; } });
    const session = await initialize(server);
    const abort = new AbortController();
    const request = fetch(server.url, { method: 'POST', signal: abort.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': session },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } }),
    }).catch(error => error);
    const signal = await entered.promise;
    abort.abort(); await request;
    await vi.waitFor(() => expect(server.disconnects.has(session)).toBe(true));
    expect(signal.aborted).toBe(false);
    const cancellation = await post(server, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }, session);
    expect(cancellation.status).toBe(202);
    expect(signal.aborted).toBe(true);
    release.resolve({});
  });

  it('counts uncooperative cancelled handlers across sessions until they settle', async () => {
    const entered = deferred<AbortSignal>(); const release = deferred<Record<string, unknown>>();
    const callTool = vi.fn(async (call: { signal: AbortSignal }) => { entered.resolve(call.signal); return release.promise; });
    const server = await host({ maxInFlight: 1, callTool });
    const a = await client(server); const b = await client(server);
    const abort = new AbortController();
    const pending = a.peer.callTool({ name: 'echo' }, { signal: abort.signal }).catch(error => error);
    const signal = await entered.promise;
    abort.abort(); await pending;
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    await expect(b.peer.callTool({ name: 'echo' })).rejects.toMatchObject({ code: -32000 });
    expect(callTool).toHaveBeenCalledTimes(1);
    release.resolve({ content: [{ type: 'text', text: 'settled' }] });
    await vi.waitFor(async () => expect(await b.peer.callTool({ name: 'echo' })).toEqual({ content: [{ type: 'text', text: 'settled' }] }));
  });

  it('bounds one SSE stream per session and allows replacement after overflow', async () => {
    const listeners = new Set<() => void>();
    const server = await host({ toolsListChanged: { onToolsListChanged(notify) { listeners.add(notify); return () => { listeners.delete(notify); }; } } });
    const session = await initialize(server);
    const request = () => new Request(server.url, { headers: { accept: 'text/event-stream', 'mcp-session-id': session } });
    const first = await server.mcp.fetch(request());
    expect(first.status).toBe(200);
    expect((await server.mcp.fetch(request())).status).toBe(409);
    // No consumer reads the first stream. The emitter must not grow its queue
    // without a bound. Filling 4 MiB closes it and permits a replacement.
    for (let batch = 0; batch < 700; batch++) {
      for (let i = 0; i < 100; i++) for (const notify of listeners) notify();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const replacement = await server.mcp.fetch(request());
    expect(replacement.status).toBe(200);
    await first.body?.cancel(); await replacement.body?.cancel();
  });

  it('closes the session on a synchronous burst above the core pending-frame cap', async () => {
    const listeners = new Set<() => void>();
    const entered = deferred<AbortSignal>(); const release = deferred<Record<string, unknown>>();
    const server = await host({ toolsListChanged: { onToolsListChanged(notify) { listeners.add(notify); return () => { listeners.delete(notify); }; } },
      callTool: async call => { entered.resolve(call.signal); return release.promise; } });
    const session = await initialize(server);
    const response = post(server, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } }, session);
    const signal = await entered.promise;
    for (let i = 0; i < 300; i++) for (const notify of listeners) notify();
    expect((await response).status).toBe(503); expect(signal.aborted).toBe(true);
    expect(listeners.size).toBe(0);
    expect((await post(server, { jsonrpc: '2.0', id: 2, method: 'ping' }, session)).status).toBe(404);
    release.resolve({});
  });

  it('shutdown cancels an unfinished request body and releases its fetch', async () => {
    const server = await host();
    const started = deferred<void>();
    let cancelled = false;
    const request = new Request(server.url, { method: 'POST',
      headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
      body: new ReadableStream({ pull() { started.resolve(); }, cancel() { cancelled = true; } }), duplex: 'half',
    } as RequestInit);
    const pending = server.mcp.fetch(request);
    await started.promise;
    server.mcp.close();
    expect((await pending).status).toBe(503); expect(cancelled).toBe(true);
  });
});


describe('HTTP request-scoped tools mode', () => {
  it('keeps default sessions local to their owning instance', async () => {
    const a = await host(); const b = await host();
    const session = await initialize(a);
    expect((await post(b, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, session)).status).toBe(404);
  });

  it('initializes on A and lists/calls on B without session affinity', async () => {
    const mode = { sessionMode: 'stateless' } as const;
    const a = await host(mode); const b = await host(mode);
    const initial = await post(a, { jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    expect(initial.status).toBe(200);
    expect(initial.headers.get('mcp-session-id')).toBeNull();
    const headers = { 'mcp-protocol-version': '2025-11-25' };
    const listed = await post(b, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, undefined, headers);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ result: { tools: [tool] } });
    const call = await post(b, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { fresh: true } } }, undefined, headers);
    expect(call.status).toBe(200);
    expect(call.headers.get('mcp-session-id')).toBeNull();
    expect(await call.json()).toMatchObject({ result: { content: [{ text: '{"fresh":true}' }] } });
  });
});

describe('stateless HTTP validation and lifecycle', () => {
  it.each(['2025-11-25', '2025-06-18'])('works with the standard client using %s', async version => {
    const server = await host({ sessionMode: 'stateless' });
    const { peer, transport, errors } = await client(server, version);
    expect(transport.sessionId).toBeUndefined();
    expect((await peer.listTools()).tools).toEqual([tool]);
    expect(await peer.callTool({ name: 'echo' })).toEqual({ content: [{ type: 'text', text: '{}' }] });
    expect(errors).toEqual([]);
  });

  it('requires validated protocol/origin/envelopes and rejects session-only features', async () => {
    const callTool = vi.fn(defaults.callTool);
    const server = await host({ sessionMode: 'stateless', callTool });
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } };
    const headers = { 'mcp-protocol-version': '2025-11-25' };
    expect((await post(server, message)).status).toBe(400);
    expect((await post(server, message, undefined, { 'mcp-protocol-version': '2025-03-26' })).status).toBe(400);
    expect((await post(server, message, undefined, { ...headers, origin: 'https://evil.example' })).status).toBe(403);
    expect((await post(server, message, 'untrusted', headers)).status).toBe(400);
    expect((await post(server, [message], undefined, headers)).status).toBe(400);
    for (const progressToken of ['progress-1', 0]) {
      const rejected = await post(server, { ...message, params: { ...message.params, _meta: { progressToken } } }, undefined, headers);
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toBe('Stateless MCP does not support progress streams');
      expect(rejected.headers.get('mcp-session-id')).toBeNull();
    }
    expect((await post(server, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }, undefined, headers)).status).toBe(400);
    for (const method of ['GET', 'DELETE', 'PUT']) {
      const rejected = await fetch(server.url, { method });
      expect(rejected.status).toBe(405);
      expect(rejected.headers.get('allow')).toBe('POST');
    }
    expect(callTool).not.toHaveBeenCalled();
    expect(() => createMcpHttpServer({ ...defaults, origin: server.origin, sessionMode: 'stateless', toolsListChanged: { onToolsListChanged: () => () => {} } })).toThrow('toolsListChanged');
  });

  it('does not retain request ids, respects bounds and aborts active calls on close', async () => {
    const entered = deferred<AbortSignal>(); const release = deferred<Record<string, unknown>>();
    const server = await host({ sessionMode: 'stateless', maxInFlight: 1,
      callTool: async call => { entered.resolve(call.signal); return release.promise; } });
    const headers = { 'mcp-protocol-version': '2025-11-25' };
    const pending = post(server, { jsonrpc: '2.0', id: '__http_initialize', method: 'tools/call', params: { name: 'echo' } }, undefined, headers);
    const signal = await entered.promise;
    expect((await post(server, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, undefined, headers)).status).toBe(503);
    server.mcp.close();
    expect((await pending).status).toBe(503);
    expect(signal.aborted).toBe(true);
    release.resolve({});
  });
});

it('stateless mode rejects malformed JSON and byte limits before invoking tools', async () => {
  const callTool = vi.fn(defaults.callTool);
  const server = await host({ sessionMode: 'stateless', maxBodyBytes: 128, callTool });
  const headers = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' };
  expect((await fetch(server.url, { method: 'POST', headers, body: '{' })).status).toBe(400);
  expect((await fetch(server.url, { method: 'POST', headers, body: ' '.repeat(129) })).status).toBe(413);
  // Trusted internal negotiation must not prevent a valid small external frame.
  const response = await post(server, { jsonrpc: '2.0', id: '__http_initialize_2', method: 'tools/list' }, undefined, headers);
  expect(response.status).toBe(200);
  expect(callTool).not.toHaveBeenCalled();
});
