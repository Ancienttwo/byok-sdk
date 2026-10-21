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
