import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it } from 'vitest';
import { BetaLedger, createBetaMcpServer, type KeySpec, type TaskArguments, type ScopedTool } from './index';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const grant: KeySpec = { label: 'Bot A', scopes: ['tasks.dispatch', 'tasks.read'], deviceIds: ['dev-a'], runtimes: ['pi'],
  agentRef: { agentId: 'main', profileRevision: '1' } };
function json(value: unknown): Record<string, unknown> { return { content: [{ type: 'text', text: JSON.stringify(value) }] }; }

async function host(extra: ScopedTool[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'b2-http-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const ledger = new BetaLedger(join(root, 'ledger.sqlite'), 'tenant-http'); cleanup.push(() => ledger.close());
  let mcp: ReturnType<typeof createBetaMcpServer>;
  const http = serve({ hostname: '127.0.0.1', port: 0, fetch: request => mcp.fetch(request) });
  if (!http.listening) await new Promise<void>(resolve => http.once('listening', resolve));
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  const origin = `http://127.0.0.1:${address.port}`;
  const tools: ScopedTool[] = [
    { definition: { name: 'byok_identity_probe', inputSchema: { type: 'object' } }, scope: 'authenticated',
      call: async caller => json({ keyId: caller.keyId, tenant: caller.tenant, label: caller.label }) },
    { definition: { name: 'byok_admission_probe', inputSchema: { type: 'object' } }, scope: 'tasks.dispatch',
      call: async (caller, args) => json(ledger.reserveTask(caller, args as unknown as TaskArguments, 'dev-a')) },
    { definition: { name: 'byok_owner_probe', inputSchema: { type: 'object' } }, scope: 'tasks.read',
      call: async (caller, args) => json(ledger.requireTask(caller, String(args?.taskId))) },
    { definition: { name: 'byok_status_probe', inputSchema: { type: 'object' } }, scope: 'tasks.read',
      call: async (caller, args) => { ledger.consumeStatusRead(caller, String(args?.taskId)); return json({ accepted: true }); } },
    ...extra,
  ];
  mcp = createBetaMcpServer({ ledger, origin, serverInfo: { name: 'B2 local protocol tests', version: '1' }, tools });
  cleanup.push(async () => { mcp.close(); if ('closeAllConnections' in http) http.closeAllConnections(); await new Promise<void>(resolve => http.close(() => resolve())); });
  return { ledger, mcp, origin, url: new URL('/mcp', origin) };
}
async function connect(server: Awaited<ReturnType<typeof host>>, token: string) {
  const transport = new StreamableHTTPClientTransport(server.url, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'standard-b2-client', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2025-11-25'] });
  await client.connect(transport); cleanup.push(async () => { await client.close(); });
  return { client, transport };
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const block = result.content[0];
  if (!block || block.type !== 'text') throw new Error('Expected JSON text');
  return { result, value: JSON.parse(block.text) };
}

it('returns the same HTTP 401 for missing, invalid, unknown and revoked keys', async () => {
  const server = await host(); const key = server.ledger.issueKey(grant);
  server.ledger.revokeKey(key.key.keyId);
  const tokens = [undefined, 'Basic secret', `Bearer byok_bot_${'0'.repeat(32)}.${'x'.repeat(43)}`, `Bearer ${key.token}`];
  const responses: Array<{ status: number; body: string; auth: string | null }> = [];
  for (const authorization of tokens) {
    const response = await fetch(server.url, { headers: authorization ? { authorization } : {} });
    responses.push({ status: response.status, body: await response.text(), auth: response.headers.get('www-authenticate') });
  }
  expect(responses.every(response => JSON.stringify(response) === JSON.stringify(responses[0]))).toBe(true);
  expect(responses[0]).toEqual({ status: 401, body: 'Invalid byok bot key', auth: 'Bearer realm="byok-mcp"' });
  for (const method of ['GET', 'POST', 'DELETE']) {
    expect((await fetch(server.url, { method, headers: { origin: 'https://attacker.example' } })).status).toBe(403);
  }
});

it('uses the authenticated key, filters scope and isolates sessions and task ownership', async () => {
  const server = await host();
  const aKey = server.ledger.issueKey(grant);
  const bKey = server.ledger.issueKey({ ...grant, label: 'Bot B', scopes: ['tasks.read'] });
  const a = await connect(server, aKey.token); const b = await connect(server, bKey.token);
  expect((await call(b.client, 'byok_identity_probe', { keyId: aKey.key.keyId, tenant: 'forged' })).value).toEqual({ keyId: bKey.key.keyId, tenant: 'tenant-http', label: 'Bot B' });
  expect((await b.client.listTools()).tools.map(tool => tool.name)).not.toContain('byok_admission_probe');
  const denied = await call(b.client, 'byok_admission_probe', { runtime: 'pi', instruction: 'denied' });
  expect(denied.result.isError).toBe(true); expect(denied.value.code).toBe('forbidden');
  const input = { runtime: 'pi', instruction: 'admit real ledger work', clientRequestId: 'wire-1' };
  const first = await call(a.client, 'byok_admission_probe', input);
  const retry = await call(a.client, 'byok_admission_probe', input);
  expect(first.value.deduplicated).toBe(false);
  expect(retry.value).toEqual({ ...first.value, deduplicated: true });
  const foreign = await call(b.client, 'byok_owner_probe', { taskId: first.value.taskId });
  const unknown = await call(b.client, 'byok_owner_probe', { taskId: 'missing' });
  expect(foreign.result.isError).toBe(true); expect(foreign.value).toEqual(unknown.value);
  expect(foreign.value.code).toBe('not_found');
  const hijack = await fetch(server.url, { headers: { authorization: `Bearer ${bKey.token}`, 'mcp-session-id': a.transport.sessionId! } });
  expect(hijack.status).toBe(404);
});

it('returns quota/rate refusals through the actual MCP client without repeating admission', async () => {
  const server = await host(); const key = server.ledger.issueKey({ ...grant, quota: { runningTasks: 1, statusPerMinute: 1 } });
  const peer = await connect(server, key.token);
  const first = await call(peer.client, 'byok_admission_probe', { runtime: 'pi', instruction: 'first', clientRequestId: 'first' });
  const refusal = await call(peer.client, 'byok_admission_probe', { runtime: 'pi', instruction: 'second', clientRequestId: 'second' });
  expect(refusal.result.isError).toBe(true); expect(refusal.value).toMatchObject({ code: 'quota_exceeded', retryAfterSeconds: 1 });
  expect((await call(peer.client, 'byok_status_probe', { taskId: first.value.taskId })).value).toEqual({ accepted: true });
  const rate = await call(peer.client, 'byok_status_probe', { taskId: first.value.taskId });
  expect(rate.result.isError).toBe(true); expect(rate.value).toMatchObject({ code: 'rate_limited', retryAfterSeconds: expect.any(Number) });
  expect(server.ledger.quota(server.ledger.authenticate(`Bearer ${key.token}`))).toMatchObject({ runningTasks: 1, remainingSubmits: 59 });
});

it('revokes an existing session on the next request and leaves another key active', async () => {
  const server = await host(); const key = server.ledger.issueKey(grant); const other = server.ledger.issueKey(grant);
  const a = await connect(server, key.token); const b = await connect(server, other.token);
  expect((await a.client.listTools()).tools.length).toBeGreaterThan(0);
  server.ledger.revokeKey(key.key.keyId);
  const response = await fetch(server.url, { headers: { authorization: `Bearer ${key.token}`, 'mcp-session-id': a.transport.sessionId! } });
  expect(response.status).toBe(401);
  expect((await call(b.client, 'byok_identity_probe')).value.keyId).toBe(other.key.keyId);
  server.mcp.close();
  expect((await fetch(server.url, { headers: { authorization: `Bearer ${other.token}` } })).status).toBe(503);
});

it('closes the revoked key transport and aborts a pending MCP wait', async () => {
  let entered!: (signal: AbortSignal) => void;
  const started = new Promise<AbortSignal>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const server = await host([{ definition: { name: 'byok_hold_probe', inputSchema: { type: 'object' } }, scope: 'authenticated',
    call: async (_caller, _args, signal) => { entered(signal); await gate; return json({ done: true }); } }]);
  const key = server.ledger.issueKey(grant); const peer = await connect(server, key.token);
  const pending = peer.client.callTool({ name: 'byok_hold_probe' }).then(value => value, error => error);
  try {
    const signal = await started;
    expect(signal.aborted).toBe(false);
    server.ledger.revokeKey(key.key.keyId);
    expect(signal.aborted).toBe(true);
    expect(await pending).toBeInstanceOf(Error);
    expect(server.ledger.getKey(key.key.keyId)?.revokedAt).toBeTypeOf('number');
  } finally { release(); }
});
