// Mode G spike: the local half of the B6 §8 checklist (docs/grok-bot.md), driven by
// a client built from the custom MCP entry a Grok Bot owner pastes into the app.
// The entry shape is Grok Bot 0.75.8's remote-server config: `type` http|sse, `url`,
// optional `headers`, `auth` (OAuth client), `tls`, `placement`, `enabledTools`.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, expect, it } from 'vitest';
import type { KeySpec } from './index';
import { call, cleanup, openDaemonHost } from './tools.test-support';

afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const scopes: KeySpec['scopes'] = ['tasks.dispatch', 'tasks.read', 'tasks.cancel'];

/** The entry for Grok Bot's add-MCP-server JSON; the static bearer goes in `headers`. */
function grokBotEntry(url: URL, token: string) {
  return { type: 'http', url: url.href, headers: { Authorization: `Bearer ${token}` } } as const;
}

async function connectAs(entry: ReturnType<typeof grokBotEntry>, version: string) {
  // No Origin header: a server-side MCP client sends none unless configured to.
  const transport = new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } });
  const client = new Client({ name: 'grok-bot-shaped', version: '0.75.8' }, { capabilities: {}, supportedProtocolVersions: [version] });
  await client.connect(transport); cleanup.push(async () => { await client.close(); });
  return { client, transport };
}

function initialize(url: URL, token: string, protocolVersion: string) {
  return fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream',
    'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion, capabilities: {}, clientInfo: { name: 'legacy', version: '1' } } }) });
}

it('serves a Grok-Bot-shaped client end to end on loopback: auth, versions, scoped tools, task loop, revocation', async () => {
  const host = await openDaemonHost();
  const key = host.ledger.issueKey({ label: 'Grok Bot', scopes, deviceIds: [host.deviceId], runtimes: ['pi'] });
  const entry = grokBotEntry(host.url, key.token);

  // Item 1, auth: no or wrong bearer gets 401 with the realm, before any MCP work.
  for (const authorization of [undefined, 'Bearer byok_wrong']) {
    const refused = await fetch(host.url, { method: 'POST', headers: authorization ? { authorization } : {} });
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toBe('Bearer realm="byok-mcp"');
  }

  // Item 1, versions: both current versions negotiate; the stdio-only 2024-11-05 does not.
  await connectAs(entry, '2025-06-18');
  const { client, transport } = await connectAs(entry, '2025-11-25');
  expect(transport.protocolVersion).toBe('2025-11-25');
  const legacy = await initialize(host.url, key.token, '2024-11-05');
  expect(legacy.status).toBe(400);

  // Item 1, no server event stream: GET on the session answers 405.
  const get = await fetch(host.url, { headers: { ...entry.headers, accept: 'text/event-stream',
    'mcp-session-id': transport.sessionId!, 'mcp-protocol-version': '2025-11-25' } });
  expect(get.status).toBe(405);
  expect(get.headers.get('allow')).toBe('POST, DELETE');

  // Item 1, tools and errors: the list follows the key's scopes; an unknown task is an isError result.
  expect((await client.listTools()).tools.map(tool => tool.name).sort())
    .toEqual(['byok_runtimes', 'byok_task_cancel', 'byok_task_list', 'byok_task_status', 'byok_task_submit', 'byok_whoami']);
  expect((await call(client, 'byok_whoami')).value).toMatchObject({ keyId: key.key.keyId, label: 'Grok Bot', scopes });
  expect(await call(client, 'byok_task_status', { taskId: 's0-owner-unknown-task', waitSeconds: 0 }))
    .toEqual({ isError: true, value: { code: 'not_found', message: 'Resource not found' } });

  // Item 3, task loop: submit returns at once; a status wait returns when the device reaches a terminal.
  const { taskId } = (await call(client, 'byok_task_submit', { runtime: 'pi', instruction: 'Answer from Mode G.' })).value;
  const session = await host.runtime.session(taskId);
  const waiting = call(client, 'byok_task_status', { taskId, waitSeconds: 50 });
  session.emit({ type: 'progress', text: 'Mode G answer' }); session.emit({ type: 'turn_end' });
  let status = (await waiting).value;
  for (let n = 0; n < 10 && status.state !== 'Complete'; n += 1) status = (await call(client, 'byok_task_status', { taskId, waitSeconds: 5 })).value;
  expect(status).toEqual({ taskId, state: 'Complete', finalMessage: 'Mode G answer', artifacts: [] });

  // Revocation: the next call with the same entry is refused.
  host.ledger.revokeKey(key.key.keyId);
  expect((await fetch(host.url, { method: 'POST', headers: entry.headers })).status).toBe(401);
});
