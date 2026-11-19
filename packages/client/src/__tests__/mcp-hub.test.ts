import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { build } from 'esbuild';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { readMcpHubCatalog, type McpHubCatalogBinding } from '../mcp/hub/index.js';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}.mjs`, import.meta.url));
let hubBundleDir: string;
let hubBundle: string;
const inner = fixture('mcp-hub-inner');
const inputSchema = {
  type: 'object', required: ['text'], properties: { text: { $ref: '#/$defs/text' } },
  additionalProperties: false, $defs: { text: { type: 'string' } },
};
const echo = {
  name: 'echo', description: 'Return the input. 查询发票', inputSchema,
  outputSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
};
const closed: Array<() => Promise<void>> = [];
const dirs: string[] = [];

beforeAll(async () => {
  hubBundleDir = await mkdtemp(join(tmpdir(), 'byok-mcp-hub-fixture-'));
  hubBundle = join(hubBundleDir, 'hub.mjs');
  await build({ entryPoints: [fixture('mcp-hub-stdio')], outfile: hubBundle, bundle: true, platform: 'node', format: 'esm' });
});

afterAll(async () => {
  if (hubBundleDir !== undefined) await rm(hubBundleDir, { recursive: true, force: true });
});

afterEach(async () => {
  await Promise.all(closed.splice(0).map((close) => close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Receipt {
  readonly method: string;
  readonly pid: number;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly params?: Record<string, unknown>;
}

async function fixtureContext(serverNames = ['alpha']) {
  const dir = await mkdtemp(join(tmpdir(), 'byok-mcp-hub-'));
  dirs.push(dir);
  const proofPath = join(dir, 'proof');
  await writeFile(proofPath, 'active');
  const configPath = (name: string) => join(dir, `${name}.json`);
  const receiptPath = (name: string) => join(dir, `${name}.jsonl`);
  const binding: McpHubCatalogBinding = {
    catalogPath: join(dir, 'catalog.json'), attemptId: 'attempt-1', launchCwd: dir,
    mcpEnv: { HUB_FILTERED: 'measured' },
    mcpServers: Object.fromEntries(serverNames.map((name) => [name, {
      command: process.execPath, args: [inner, configPath(name), receiptPath(name)], env: { HUB_CONTEXT: name },
    }])),
  };
  async function configure(name: string, config: Record<string, unknown> = {}): Promise<void> {
    await writeFile(configPath(name), JSON.stringify({ pages: [[echo]], ...config }));
  }
  async function receipts(name: string, method: string): Promise<Receipt[]> {
    const raw = await readFile(receiptPath(name), 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return '';
      throw error;
    });
    return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Receipt)
      .filter((entry) => entry.method === method);
  }
  async function connect(options: { noProof?: boolean; denyServer?: string; toolCallTimeoutMs?: number } = {}) {
    const file = join(dir, `hub-${crypto.randomUUID()}.json`);
    await writeFile(file, JSON.stringify({ binding, proofPath: options.noProof ? undefined : proofPath, ...options }), { mode: 0o600 });
    const transport = new StdioClientTransport({
      command: process.execPath, args: [hubBundle, file], stderr: 'pipe',
      env: { HUB_PARENT_ONLY: 'must not reach the inner child' },
    });
    const client = new Client({ name: 'hub-test', version: '1' }, { enforceStrictCapabilities: true });
    const close = () => client.close();
    closed.push(close);
    await client.connect(transport, { timeout: 8_000 });
    return {
      client, close,
      search: (query: string, signal?: AbortSignal) =>
        client.callTool({ name: 'tool_search', arguments: { query } }, { signal, timeout: 15_000 }),
      call: (server = 'alpha', args: Record<string, unknown> = { text: 'hello' }, signal?: AbortSignal) =>
        client.callTool({ name: 'call_tool', arguments: { server, tool: 'echo', arguments: args } }, { signal, timeout: 8_000 }),
    };
  }
  await Promise.all(serverNames.map((name) => configure(name)));
  const setProof = (active: boolean) => writeFile(proofPath, active ? 'active' : 'revoked');
  return { binding, configure, receipts, connect, setProof };
}

type ToolResult = Awaited<ReturnType<Client['callTool']>>;

function text(result: ToolResult): string {
  const block = result.content?.[0];
  if (block?.type !== 'text') throw new Error('Expected text result');
  return block.text;
}

function searchHits(result: ToolResult): Array<{ server: string; tool: string; inputSchema: unknown }> {
  expect(result.isError).not.toBe(true);
  return JSON.parse(text(result));
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

it('lists only the hub tools and shares a cold paginated discovery across concurrent searches', async () => {
  const f = await fixtureContext(['zeta', 'alpha']);
  await f.configure('alpha', { pages: [[{ ...echo, name: 'other' }], [echo]] });
  const hub = await f.connect();
  expect(hub.client.getServerVersion()?.name).toBe('byoktools');
  const { tools } = await hub.client.listTools();
  expect(tools.map((tool) => tool.name)).toEqual(['tool_search', 'call_tool']);
  expect(tools[0]?.description).toContain('English keywords');
  expect(tools[1]?.annotations?.readOnlyHint).toBeUndefined();
  expect(text(await hub.call())).toMatch(/Run tool_search/u);
  expect(await f.receipts('alpha', 'start')).toEqual([]);

  const [a, b] = await Promise.all([hub.search('ＥＣＨＯ'), hub.search('查询')]);
  for (const result of [a, b]) {
    expect(searchHits(result).filter(({ tool }) => tool === 'echo')).toEqual([
      { server: 'alpha', tool: 'echo', inputSchema, description: echo.description },
      { server: 'zeta', tool: 'echo', inputSchema, description: echo.description },
    ]);
  }
  expect(await f.receipts('alpha', 'initialize')).toHaveLength(1);
  expect((await f.receipts('alpha', 'tools/list')).map(({ params }) => params?.cursor)).toEqual([undefined, '1']);
  expect(await f.receipts('alpha', 'tools/call')).toEqual([]);
  const discoveryChild = (await f.receipts('alpha', 'start'))[0]!;
  expect(alive(discoveryChild.pid)).toBe(false);
  expect(discoveryChild.cwd).toBe(await realpath(f.binding.launchCwd));
  expect(discoveryChild.env?.HUB_FILTERED).toBe('measured');
  expect(discoveryChild.env?.HUB_CONTEXT).toBe('alpha');
  expect(discoveryChild.env?.HUB_PARENT_ONLY).toBeUndefined();
  if (process.platform !== 'win32') expect((await stat(f.binding.catalogPath)).mode & 0o777).toBe(0o600);

  const calls = await Promise.all([hub.call('alpha'), hub.call('alpha', { text: 'again' }), hub.call('zeta')]);
  expect(calls.map((result) => result.structuredContent)).toEqual([{ text: 'hello' }, { text: 'again' }, { text: 'hello' }]);
  expect(await f.receipts('alpha', 'initialize')).toHaveLength(2);
  expect(await f.receipts('alpha', 'tools/call')).toHaveLength(2);
  expect(await f.receipts('zeta', 'tools/call')).toHaveLength(1);
  const child = (await f.receipts('alpha', 'start'))[1]!;
  await hub.close();
  await expect.poll(() => alive(child.pid)).toBe(false);
}, 15_000);

it('ranks exact names, name words and description words and drops a whole oversized row', async () => {
  const f = await fixtureContext();
  const names = ['otherA', 'otherB', 'otherC', 'otherD', 'otherE'];
  await f.configure('alpha', { pages: [[
    ...names.map((name) => ({ ...echo, name, description: 'find leads' })),
    { ...echo, name: 'findLeadsV2' }, { ...echo, name: 'find_leads' },
    { ...echo, name: 'find-leads', description: 'x'.repeat(270_000) },
  ]] });
  const hub = await f.connect();
  expect(searchHits(await hub.search('ＦＩＮＤ leads')).map(({ tool }) => tool)).toEqual([
    'find_leads', 'findLeadsV2', 'otherA', 'otherB', 'otherC',
  ]);
  expect(searchHits(await hub.search('毫无匹配'))).toEqual([]);
});

it('publishes no partial catalog after discovery fails and retries on the next search', async () => {
  const f = await fixtureContext(['alpha', 'zeta']);
  await f.configure('zeta', { badList: [echo, echo] });
  const hub = await f.connect();
  expect(text(await hub.search('echo'))).toMatch(/discover.*zeta/u);
  expect(await readMcpHubCatalog(f.binding)).toBeUndefined();
  await f.configure('zeta');
  expect(searchHits(await hub.search('echo'))).toHaveLength(2);
  expect(await f.receipts('zeta', 'start')).toHaveLength(2);
});

it('allows no more than eight simultaneous discoveries on the same Attempt', async () => {
  const servers = Array.from({ length: 9 }, (_, index) => `server${index}`);
  const f = await fixtureContext(servers);
  const release = join(f.binding.launchCwd, 'release');
  await Promise.all(servers.map((name) => f.configure(name, { waitForList: release })));
  const hub = await f.connect();
  const pending = hub.search('echo');
  await expect.poll(async () => (await Promise.all(servers.slice(0, 8).map((name) => f.receipts(name, 'tools/list')))).flat().length)
    .toBe(8);
  expect(await f.receipts('server8', 'start')).toEqual([]);
  await writeFile(release, '');
  expect(searchHits(await pending)).toHaveLength(5);
  expect((await readMcpHubCatalog(f.binding))?.size).toBe(9);
}, 15_000);

it('uses the winner’s catalog when overlapping hub processes discover different tools', async () => {
  const f = await fixtureContext();
  const release = join(f.binding.launchCwd, 'release');
  await f.configure('alpha', { pages: [[{ ...echo, name: 'losing_echo' }]], waitForList: release });
  const loser = await f.connect();
  const pending = loser.search('echo');
  void pending.catch(() => undefined);
  await expect.poll(async () => (await f.receipts('alpha', 'list-wait')).length).toBe(1);
  await f.configure('alpha');
  const winner = await f.connect();
  const winningResult = await winner.search('echo');
  expect(searchHits(winningResult).map(({ tool }) => tool)).toEqual(['echo']);
  await writeFile(release, '');
  expect(await pending).toEqual(winningResult);

  await f.configure('alpha', { pages: [[{ ...echo, name: 'losing_echo' }]] });
  expect(text(await loser.call())).toMatch(/changed since search/u);
  expect(await f.receipts('alpha', 'tools/call')).toEqual([]);
});

it('uses one absolute deadline across discovery waves', async () => {
  const servers = Array.from({ length: 9 }, (_, index) => `server${index}`);
  const f = await fixtureContext(servers);
  await Promise.all(servers.map((name) => f.configure(name, { listDelayMs: 6_000 })));
  const hub = await f.connect();
  const failed = await hub.search('echo');
  expect(failed.isError).toBe(true);
  expect(text(failed)).toMatch(/10-second budget/u);
  expect(await readMcpHubCatalog(f.binding)).toBeUndefined();
  const [lastChild] = await f.receipts('server8', 'start');
  expect(alive(lastChild!.pid)).toBe(false);
}, 16_000);

it('cancels unfinished discovery and lets the next search start fresh', async () => {
  const f = await fixtureContext();
  const release = join(f.binding.launchCwd, 'release');
  await f.configure('alpha', { waitForList: release });
  const hub = await f.connect();
  const cancel = new AbortController();
  const pending = hub.search('echo', cancel.signal);
  void pending.catch(() => undefined);
  await expect.poll(async () => (await f.receipts('alpha', 'list-wait')).length).toBe(1);
  cancel.abort();
  await expect(pending).rejects.toThrow();
  const [child] = await f.receipts('alpha', 'start');
  await expect.poll(() => alive(child!.pid)).toBe(false);
  expect(await readMcpHubCatalog(f.binding)).toBeUndefined();
  await writeFile(release, '');
  expect(searchHits(await hub.search('echo'))).toHaveLength(1);
});

it('reuses the published catalog after hub restart and rejects live schema drift before dispatch', async () => {
  const f = await fixtureContext();
  const first = await f.connect();
  const initial = await first.search('echo');
  await first.close();
  await f.configure('alpha', { pages: [[{ ...echo, inputSchema: { ...inputSchema, additionalProperties: true } }]] });
  const restarted = await f.connect();
  expect(await restarted.search('echo')).toEqual(initial);
  expect(await f.receipts('alpha', 'start')).toHaveLength(1);
  expect(text(await restarted.call())).toMatch(/changed since search/u);
  expect(await f.receipts('alpha', 'tools/call')).toEqual([]);
  await expect(readMcpHubCatalog({ ...f.binding, attemptId: 'attempt-2' })).rejects.toThrow(/does not match/u);
});

it('refuses a helper without Attempt proof before discovering or starting a target', async () => {
  const f = await fixtureContext();
  const unbound = await f.connect({ noProof: true });
  expect(text(await unbound.search('echo'))).toMatch(/inactive/u);
  expect(await f.receipts('alpha', 'start')).toEqual([]);
  const bound = await f.connect();
  await bound.search('echo');
  expect(text(await unbound.call())).toMatch(/inactive/u);
  expect(await f.receipts('alpha', 'start')).toHaveLength(1);
});

it('rechecks the Attempt proof when a cold handshake finishes', async () => {
  const f = await fixtureContext();
  const hub = await f.connect();
  await hub.search('echo');
  const release = join(f.binding.launchCwd, 'release');
  await f.configure('alpha', { waitForList: release });
  const pending = hub.call();
  await expect.poll(async () => (await f.receipts('alpha', 'tools/list')).length).toBe(2);
  await f.setProof(false);
  await writeFile(release, '');
  expect(text(await pending)).toMatch(/inactive/u);
  expect(await f.receipts('alpha', 'tools/call')).toEqual([]);
});

it('blocks a warm call on a revoked Attempt proof and closes its connection', async () => {
  const f = await fixtureContext();
  const hub = await f.connect();
  await hub.search('echo');
  expect((await hub.call()).structuredContent).toEqual({ text: 'hello' });
  await f.setProof(false);
  expect(text(await hub.call())).toMatch(/inactive/u);
  const [call] = await f.receipts('alpha', 'tools/call');
  expect(await f.receipts('alpha', 'tools/call')).toHaveLength(1);
  expect(alive(call!.pid)).toBe(false);
});

it('validates the exact identity, arguments and grant before inner dispatch', async () => {
  const f = await fixtureContext(['alpha', 'constructor']);
  const hub = await f.connect({ denyServer: 'constructor' });
  await hub.search('echo');
  const malformed = await hub.client.callTool({ name: 'call_tool', arguments: { server: 'alpha', tool: 'echo', arguments: [] } });
  expect(text(malformed)).toMatch(/arguments object/u);
  expect(text(await hub.call('__proto__'))).toMatch(/absent/u);
  expect(text(await hub.call('alpha', { text: 7 }))).toMatch(/input schema/u);
  expect(text(await hub.call('constructor'))).toMatch(/not authorized/u);
  for (const name of ['alpha', 'constructor']) {
    expect(await f.receipts(name, 'start')).toHaveLength(1);
    expect(await f.receipts(name, 'tools/call')).toEqual([]);
  }
});

it.each(['disconnect', 'inner-oversize', 'outer-oversize', 'invalid-result', 'hang'])('reports an unknown result for %s without replay', async (behavior) => {
  const f = await fixtureContext();
  const hub = await f.connect({ toolCallTimeoutMs: 250 });
  await hub.search('echo');
  // The outer JSON-RPC id has more digits, so a frame just within the inner
  // limit exceeds the outer limit even though its result is identical.
  for (let count = 0; count < 10; count++) await hub.client.ping();
  await f.configure('alpha', { behavior });
  const failed = await hub.call();
  expect(failed.isError).toBe(true);
  expect(text(failed)).toMatch(/result unknown/u);
  expect(await f.receipts('alpha', 'tools/call')).toHaveLength(1);
  await f.configure('alpha');
  expect((await hub.call()).structuredContent).toEqual({ text: 'hello' });
  expect(await f.receipts('alpha', 'tools/call')).toHaveLength(2);
  expect(await f.receipts('alpha', 'initialize')).toHaveLength(behavior === 'outer-oversize' ? 2 : 3);
});

it('propagates outer cancellation to a dispatched inner tool and reaps the child without replay', async () => {
  const f = await fixtureContext();
  const hub = await f.connect();
  await hub.search('echo');
  await f.configure('alpha', { behavior: 'hang' });
  const cancel = new AbortController();
  const pending = hub.call('alpha', { text: 'hello' }, cancel.signal);
  void pending.catch(() => undefined);
  await expect.poll(async () => (await f.receipts('alpha', 'tools/call')).length).toBe(1);
  const [request] = await f.receipts('alpha', 'tools/call');
  cancel.abort();
  await expect(pending).rejects.toThrow();
  await expect.poll(() => alive(request!.pid)).toBe(false);
  expect(await f.receipts('alpha', 'notifications/cancelled')).toHaveLength(1);
  expect(await f.receipts('alpha', 'tools/call')).toHaveLength(1);
});
