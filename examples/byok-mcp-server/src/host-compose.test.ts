import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createDaemonWithAdapters } from '@byok-sdk/client';
import { afterEach, expect, it, vi } from 'vitest';
import { InMemoryDeviceCredentialStore } from '../../../scripts/testing/device-credentials.mjs';
import { GROK_BOT_SCOPES, grokBotEntry, startHost } from './host-compose';
import { call, cleanup, FakeRuntime } from './tools.test-support';

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('starts the Host, pairs a device, issues a Grok Bot key, serves the entry end to end, and keeps its port on restart', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'mcp-host-')); cleanup.push(() => rmSync(stateDir, { recursive: true, force: true }));
  let host = await startHost({ stateDir, statusPollMs: 20 });
  cleanup.push(() => host.close());
  expect(host.mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

  const runtime = new FakeRuntime();
  const daemon = createDaemonWithAdapters({ productId: host.productId, productName: 'Mode G smoke', localAgentRelease: { version: '0.0.0-test' },
    serverUrl: host.origin, workspaceRoot: join(stateDir, 'workspace'), storeDir: join(stateDir, 'device') },
  [runtime], { deviceCredentials: new InMemoryDeviceCredentialStore(), longPoll: { retryDelayMs: 20, idleDelayMs: 20 } });
  const { deviceId } = await daemon.pair(await host.pairingCode());
  await daemon.start(); cleanup.push(() => daemon.stop());
  expect(await host.firstDevice(undefined, 20)).toBe(deviceId);

  const { token, key } = host.issueGrokBotKey(deviceId);
  expect(key).toMatchObject({ label: 'Grok Bot', scopes: GROK_BOT_SCOPES, deviceIds: [deviceId], runtimes: ['pi'] });
  const entry = grokBotEntry(host.mcpUrl, token);
  expect(entry).toEqual({ type: 'http', url: host.mcpUrl, headers: { Authorization: `Bearer ${token}` } });

  const client = new Client({ name: 'grok-bot-shaped', version: '1' }, { capabilities: {}, supportedProtocolVersions: ['2025-11-25'] });
  await client.connect(new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } }));
  cleanup.push(() => client.close());
  await vi.waitFor(async () => expect((await call(client, 'byok_whoami')).value.devices).toEqual([expect.objectContaining({ deviceId, connected: true })]),
    { timeout: 3000, interval: 50 });
  const { taskId } = (await call(client, 'byok_task_submit', { runtime: 'pi', instruction: 'Smoke.' })).value;
  const session = await runtime.session(taskId);
  session.emit({ type: 'progress', text: 'smoke ok' }); session.emit({ type: 'turn_end' });
  await vi.waitFor(async () => expect((await call(client, 'byok_task_status', { taskId, waitSeconds: 1 })).value)
    .toMatchObject({ state: 'Complete', finalMessage: 'smoke ok' }), { timeout: 5000, interval: 50 });

  // The SDK routes share the origin; an MCP request without the bearer is refused.
  expect((await fetch(host.mcpUrl, { method: 'POST' })).status).toBe(401);
  expect(await call(client, 'byok_task_status', { taskId: 'unknown-task' })).toMatchObject({ isError: true });
  expect(host.ledger.revokeKey(key.keyId)).toBe(true);
  expect((await fetch(host.mcpUrl, { method: 'POST', headers: entry.headers })).status).toBe(401);

  // The access log correlates each MCP request with its key, status and tool, and never holds the token.
  const raw = readFileSync(host.accessLogPath, 'utf8');
  expect(statSync(host.accessLogPath).mode & 0o777).toBe(0o600);
  expect(raw).not.toContain(token);
  expect(raw).not.toContain(token.split('.').pop()!);
  expect(raw.toLowerCase()).not.toContain('bearer');
  const lines = raw.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
  const ts = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect(lines).toContainEqual({ ts, method: 'POST', path: '/mcp', status: 200, keyId: key.keyId, rpc: 'tools/call', tool: 'byok_whoami' });
  expect(lines).toContainEqual({ ts, method: 'POST', path: '/mcp', status: 200, keyId: key.keyId, rpc: 'tools/call', tool: 'byok_task_submit' });
  expect(lines).toContainEqual({ ts, method: 'POST', path: '/mcp', status: 200, keyId: key.keyId, rpc: 'tools/call', tool: 'byok_task_status', toolError: 'not_found' });
  expect(lines.filter(line => line.status === 401)).toEqual([{ ts, method: 'POST', path: '/mcp', status: 401 }, { ts, method: 'POST', path: '/mcp', status: 401 }]);
  expect(lines.every(line => Object.keys(line).every(k => ['ts', 'method', 'path', 'status', 'keyId', 'rpc', 'tool', 'toolError'].includes(k)))).toBe(true);

  const { origin } = host;
  await daemon.stop(); await client.close(); await host.close();
  host = await startHost({ stateDir });
  expect(host.origin).toBe(origin);
});
