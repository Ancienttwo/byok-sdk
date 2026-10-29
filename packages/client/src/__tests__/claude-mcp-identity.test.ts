import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentEventSchema, type AgentEvent } from '@byok-sdk/protocol';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { createClaudeControlChannel } from '../adapters/claude/control-channel';
import { claudeMcpEventIdentities, createClaudeMcpIdentityResolver } from '../adapters/claude/mcp-identity';
import { AGENT_MESSAGE_MCP_SERVER_NAME } from '../sdk-reserved-mcp';
import type { Session, MessageDraftDelta } from '../types';
import { startPreparedOperation } from './fixtures/prepared-operation';

const CLAUDE_FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const SALESKO_MCP_FIXTURE = fileURLToPath(new URL('./fixtures/fake-salesko-mcp.mjs', import.meta.url));

const server = (name: string) => ({ command: process.execPath, args: [`/opt/${name}.mjs`] });
const configured = (...names: string[]) => new Map(names.map(name => [name, server(name)]));

/** The `mcp_status` response shape real claude 2.1.302 returned in a credential-free local run. */
const status = (...servers: { name: string; tools?: string[]; status?: string; config?: object; scope?: string }[]) => ({
  mcpServers: servers.map(({ name, tools, status = 'connected', config = { type: 'stdio', ...server(name) }, scope = 'dynamic' }) => ({
    name, status, config, scope, source: scope,
    ...(tools === undefined ? {} : { tools: tools.map(tool => ({ name: tool, annotations: {} })) }),
  })),
});

describe('Claude MCP identity from its own mcp_status answer', () => {
  it('shares one in-flight lookup across simultaneous hooks and event reporting', async () => {
    let complete!: (response: unknown) => void;
    const fetch = vi.fn(() => new Promise<unknown>(resolve => { complete = resolve; }));
    const source = createClaudeMcpIdentityResolver(fetch, configured('market'));
    await expect(source.resolve('Read')).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
    const lookups = [source.resolve('mcp__market__get_quote'), source.observe(), source.resolve('mcp__market__get_quote')];
    expect(fetch).toHaveBeenCalledOnce();
    complete(status({ name: 'market', tools: ['get.quote'] }));
    expect(await Promise.all(lookups)).toEqual([{ server: 'market', tool: 'get.quote' }, undefined, { server: 'market', tool: 'get.quote' }]);
    expect(source.identities.get('mcp__market__get_quote')).toEqual({ server: 'market', tool: 'get.quote' });
    await source.observe();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('maps Claude runtime names to the configured server and original tool names', () => {
    const identities = claudeMcpEventIdentities(
      status({ name: 'market.feed', tools: ['get.quote', 'get_snapshot'] }),
      configured('market.feed'),
    );
    expect([...identities]).toEqual([
      ['mcp__market_feed__get_quote', { server: 'market.feed', tool: 'get.quote' }],
      ['mcp__market_feed__get_snapshot', { server: 'market.feed', tool: 'get_snapshot' }],
    ]);
  });

  it('gives no identity to servers outside the task toolsets, but counts them for collisions', () => {
    const toolset = configured('market');
    // The user's own `market__feed` server and the task's `market` server both yield `mcp__market__feed__get`.
    expect(claudeMcpEventIdentities(status(
      { name: 'market', tools: ['feed__get', 'quote'] },
      { name: 'market__feed', tools: ['get'] },
      { name: AGENT_MESSAGE_MCP_SERVER_NAME, tools: ['send_message'] },
    ), toolset)).toEqual(new Map([['mcp__market__quote', { server: 'market', tool: 'quote' }]]));
  });

  it('drops a name two task toolset servers share instead of throwing', () => {
    expect(claudeMcpEventIdentities(status(
      { name: 'a', tools: ['b__c'] },
      { name: 'a__b', tools: ['c'] },
    ), configured('a', 'a__b')).size).toBe(0);
    // `get.quote` and `get_quote` normalize to one runtime name.
    expect(claudeMcpEventIdentities(status({ name: 'm', tools: ['get.quote', 'get_quote'] }), configured('m')).size).toBe(0);
  });

  it('gives no identity to a same-named server Claude reports with another command or args', () => {
    // Claude 2.1.302 keeps the `--mcp-config` entry over a same-named user server; a different merge must not mislabel.
    for (const config of [
      { type: 'stdio', command: process.execPath, args: ['/home/user/market.mjs'] },
      { type: 'stdio', command: 'node', args: ['/opt/market.mjs'] },
      { type: 'stdio', command: process.execPath },
      undefined,
    ]) {
      const response = status({ name: 'market', tools: ['quote'], scope: 'user' });
      (response.mcpServers[0] as { config?: object }).config = config;
      expect(claudeMcpEventIdentities(response, configured('market')).size).toBe(0);
    }
  });

  it.each([
    ['no response', undefined],
    ['no server list', {}],
    ['a pending server without tools', status({ name: 'market', status: 'pending' })],
    ['malformed entries', { mcpServers: [null, { name: 'market', tools: [null, { name: '' }, { name: 7 }] }] }],
  ])('yields no identity for %s', (_label, response) => {
    expect(claudeMcpEventIdentities(response, configured('market')).size).toBe(0);
  });
});

describe('Claude mcp_status control request', () => {
  afterEach(() => vi.useRealTimers());

  it('returns the response body and never blocks a concurrent interrupt', async () => {
    const channel = createClaudeControlChannel(1000);
    const frames: Array<{ request_id: string; request: { subtype: string } }> = [];
    channel.bind(async frame => { frames.push(frame as never); });
    const lookup = channel.mcpStatus();
    expect(await channel.mcpStatus()).toBeUndefined();
    const interrupt = channel.interrupt();
    expect(frames.map(frame => frame.request.subtype)).toEqual(['mcp_status', 'interrupt']);
    channel.receive({ type: 'control_response', response: { subtype: 'success', request_id: frames[1]!.request_id } });
    expect(await interrupt).toBe(true);
    const body = status({ name: 'market', tools: ['quote'] });
    channel.receive({ type: 'control_response', response: { subtype: 'success', request_id: frames[0]!.request_id, response: body } });
    expect(await lookup).toEqual(body);
  });

  it('settles undefined on an error answer, a timeout or process close', async () => {
    const channel = createClaudeControlChannel(1000);
    const frames: Array<{ request_id: string }> = [];
    channel.bind(async frame => { frames.push(frame as never); });
    const failed = channel.mcpStatus();
    channel.receive({ type: 'control_response', response: { subtype: 'error', request_id: frames[0]!.request_id, response: status() } });
    expect(await failed).toBeUndefined();

    vi.useFakeTimers();
    const slow = channel.mcpStatus();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await slow).toBeUndefined();
    vi.useRealTimers();

    const open = channel.mcpStatus();
    channel.closed();
    expect(await open).toBeUndefined();
  });
});

describe('ordinary ClaudeAdapter MCP event identity against fake-claude', () => {
  const sessions: Session[] = [];
  afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.close())); });

  async function runTurn(instruction: string, env: NodeJS.ProcessEnv = {}): Promise<{ events: Array<AgentEvent | MessageDraftDelta>; receipt: string }> {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-claude-mcp-identity-'));
    const receipt = path.join(workspaceDir, 'mcp-status.ndjson');
    const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }) });
    // No `mcpToolsetTools`: the ordinary daemon takes no tools/list observation for Claude.
    const session = await startPreparedOperation(adapter, { instruction }, {
      workspaceDir,
      env: { ...process.env, ...env, FAKE_CLAUDE_MCP_STATUS_RECEIPT: receipt },
      mcpServers: { salesko: { command: process.execPath, args: [SALESKO_MCP_FIXTURE] } },
    });
    sessions.push(session);
    const events: Array<AgentEvent | MessageDraftDelta> = [];
    for await (const event of session.events) { events.push(event); if (event.type === 'turn_end') break; }
    return { events, receipt };
  }
  const toolEvents = (events: Array<AgentEvent | MessageDraftDelta>) => events.filter(event => event.type === 'tool_use' || event.type === 'tool_result');

  it('annotates both MCP tool events from one mcp_status lookup', async () => {
    const { events, receipt } = await runTurn('salesko:find-leads');
    const tools = toolEvents(events);
    expect(tools).toHaveLength(2);
    for (const event of tools) {
      expect(AgentEventSchema.parse(event)).toMatchObject({ tool: 'mcp__salesko__find_leads', mcp: { server: 'salesko', tool: 'find_leads' } });
    }
    expect((await fs.readFile(receipt, 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('never asks for mcp_status or annotates a built-in tool', async () => {
    const { events, receipt } = await runTurn('say hi');
    expect(toolEvents(events).map(event => event.tool)).toEqual(['Bash', 'Bash']);
    for (const event of toolEvents(events)) expect(event).not.toHaveProperty('mcp');
    await expect(fs.access(receipt)).rejects.toThrow();
  });

  it('leaves mcp absent when the runtime name is ambiguous across reported servers', async () => {
    const { events } = await runTurn('salesko:find-leads', {
      // `find.leads` and `find_leads` both become `mcp__salesko__find_leads` in Claude.
      FAKE_CLAUDE_MCP_STATUS: JSON.stringify(status({
        name: 'salesko', tools: ['find_leads', 'find.leads'], config: { type: 'stdio', command: process.execPath, args: [SALESKO_MCP_FIXTURE] },
      })),
    });
    expect(toolEvents(events)).toHaveLength(2);
    for (const event of toolEvents(events)) expect(event).not.toHaveProperty('mcp');
  });
});
