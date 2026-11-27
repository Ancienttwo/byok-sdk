import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { AgentEventSchema, type AgentEvent } from '@byok-sdk/protocol';
import { AGENT_RESULT_MCP_SERVER_NAME, AGENT_RESULT_TOOL_NAME } from '../sdk-reserved-mcp';
import type { MessageDraftDelta } from '../types';
import { mcpEventIdentities } from '../mcp/event-identity';
import { attributeHubAttempt } from '../mcp/hub-event-attribution';
import { publishMcpHubCatalog } from '../mcp/hub/catalog';
import { mapClaudeMessageToAgentEvents, type ToolUseCorrelation } from '../adapters/claude/projection';
import { mapPiMessageToAgentEvent } from '../adapters/pi/events';
import { createPiMcpTools } from '../adapters/pi/mcp-tools';
import { projectDurableEvent, withMcpIdentity } from '../adapters/pi-durable/events';
import { CodexProjection } from '../adapters/codex/projection';
import { AgyProjection, agyMcpEventIdentities } from '../adapters/antigravity/projection';
import { DshProjection } from '../adapters/dsh/projection';
import { GrokProjection } from '../adapters/grok/projection';
import { OpenCodeProjection } from '../adapters/opencode/projection';
import { createSessionKernel } from '../../vendor/oar/223703d/shared/session-kernel';
import { projectMcpTools } from '../mcp/projection';

const identities = mcpEventIdentities({ market__feed: { toolsetId: 'market', serverName: 'market__feed', serverInfo: { name: 'market', version: '1' }, protocolVersion: '2025-03-26', tools: [
  { name: 'get__quote', description: 'quote', inputSchema: { type: 'object' } },
] } });
const name = 'mcp__market__feed__get__quote';
const mcp = { server: 'market__feed', tool: 'get__quote' };

it('attributes only exact, live hub attempts against the current frozen catalog', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hub-attribution-'));
  const binding = { catalogPath: path.join(dir, 'catalog.json'), attemptId: 'attempt', launchCwd: dir,
    mcpEnv: {}, mcpServers: { alpha: { command: process.execPath }, beta: { command: process.execPath } } };
  const hub = { binding, isActive: () => true, innerAttempts: true as const };
  const use = (server: string, toolCallId: string): Extract<AgentEvent, { type: 'tool_use' }> => ({
    type: 'tool_use', tool: 'mcp__byoktools__call_tool', mcp: { server: 'byoktools', tool: 'call_tool' },
    toolCallId, input: { server, tool: 'same_name', arguments: { symbol: toolCallId } },
  });
  const first = use('alpha', 'first');
  try {
    expect(await attributeHubAttempt(first, hub)).toBeUndefined();
    await publishMcpHubCatalog(binding, ['alpha', 'beta'].map(serverName => ({
      serverName, serverInfo: { name: serverName, version: '1' }, protocolVersion: '2025-11-25',
      tools: [{ name: 'same_name', description: '', inputSchema: { type: 'object' } }],
    })), new AbortController().signal);
    await expect(Promise.all([attributeHubAttempt(first, hub), attributeHubAttempt(use('beta', 'second'), hub)]))
      .resolves.toMatchObject([
        { mcp: { server: 'alpha', tool: 'same_name' }, toolCallId: 'first', input: { symbol: 'first' } },
        { mcp: { server: 'beta', tool: 'same_name' }, toolCallId: 'second', input: { symbol: 'second' } },
      ]);
    expect(first.mcp?.server).toBe('byoktools');
    const outer = [
      [first, { ...hub, innerAttempts: undefined }],
      [first, { ...hub, isActive: () => false }],
      [first, { ...hub, binding: { ...binding, attemptId: 'retired' } }],
      [{ ...first, mcp: undefined }, hub],
      [{ ...first, tool: 'mcp__byoktools__tool_search' }, hub],
      [{ ...first, toolCallId: undefined }, hub],
      [{ ...first, input: '{"server":"alpha"}' }, hub],
      [use('outside', 'missing'), hub],
    ] as const;
    await expect(Promise.all(outer.map(([event, attempt]) => attributeHubAttempt(event, attempt))))
      .resolves.toEqual(outer.map(() => undefined));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('retains exact observed Claude identity across tool use/result without delimiter guessing', () => {
  const correlation: ToolUseCorrelation = { toolNameByUseId: new Map(), mcpIdentities: identities };
  const use = mapClaudeMessageToAgentEvents({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'call', name, input: {} },
  ] } }, correlation, { workspaceDir: '/tmp' });
  const result = mapClaudeMessageToAgentEvents({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'call', content: 'quote', is_error: false },
  ] } }, correlation, { workspaceDir: '/tmp' });
  expect(use.events[0]).toMatchObject({ type: 'tool_use', mcp });
  expect(result.events[0]).toMatchObject({ type: 'tool_result', mcp });
  expect(AgentEventSchema.parse(use.events[0])).toHaveProperty('mcp', mcp);
});

it.each(['bash', 'mcp__unknown__quote', name])('does not infer Claude identity without observation: %s', tool => {
  const event = mapClaudeMessageToAgentEvents({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'call', name: tool, input: {} },
  ] } }, { toolNameByUseId: new Map() }, { workspaceDir: '/tmp' }).events[0];
  expect(event).not.toHaveProperty('mcp');
});

it('annotates both Pi native events from the exact registered tool identity', () => {
  const use = mapPiMessageToAgentEvent({ type: 'tool_execution_start', toolName: name, toolCallId: 'call', args: {} }, identities);
  const result = mapPiMessageToAgentEvent({ type: 'tool_execution_end', toolName: name, toolCallId: 'call', result: {}, isError: false }, identities);
  expect(use).toMatchObject({ type: 'tool_use', mcp });
  expect(result).toMatchObject({ type: 'tool_result', mcp });
  expect(AgentEventSchema.parse(result)).toHaveProperty('mcp', mcp);
  for (const toolName of ['bash', 'mcp__unknown__quote']) {
    expect(mapPiMessageToAgentEvent({ type: 'tool_execution_start', toolName, toolCallId: 'other', args: {} }, identities)).not.toHaveProperty('mcp');
  }
});

it('annotates both durable Pi tool events from the exact observed toolset name only', () => {
  const use = withMcpIdentity({ type: 'tool_use', tool: name, toolCallId: 'task-call', input: {} }, identities);
  const result = withMcpIdentity(projectDurableEvent({ type: 'tool_end', tool: name, callId: 'pi-call' })[0]!, identities);
  expect(use).toEqual({ type: 'tool_use', tool: name, mcp, toolCallId: 'task-call', input: {} });
  expect(result).toMatchObject({ type: 'tool_result', tool: name, mcp });
  expect(AgentEventSchema.parse(result)).toHaveProperty('mcp', mcp);
  for (const tool of ['bash', 'submit_result', 'mcp__unknown__quote']) {
    expect(withMcpIdentity({ type: 'tool_use', tool, toolCallId: 'other', input: {} }, identities)).not.toHaveProperty('mcp');
  }
  expect(withMcpIdentity({ type: 'progress', text: name }, identities)).toEqual({ type: 'progress', text: name });
});

it('annotates Pi and durable Pi helper events only when the SDK configured the helper', () => {
  const helper = { server: AGENT_RESULT_MCP_SERVER_NAME, tool: AGENT_RESULT_TOOL_NAME };
  const configured = mcpEventIdentities({}, { [AGENT_RESULT_MCP_SERVER_NAME]: { command: 'helper' } });
  const start = { type: 'tool_execution_start', toolName: AGENT_RESULT_TOOL_NAME, toolCallId: 'call', args: {} };
  const end = { type: 'tool_execution_end', toolName: AGENT_RESULT_TOOL_NAME, toolCallId: 'call', result: {}, isError: false };
  expect(mapPiMessageToAgentEvent(start, configured)).toMatchObject({ type: 'tool_use', mcp: helper });
  expect(mapPiMessageToAgentEvent(end, configured)).toMatchObject({ type: 'tool_result', mcp: helper });
  expect(withMcpIdentity({ type: 'tool_use', tool: AGENT_RESULT_TOOL_NAME, toolCallId: 'call', input: {} }, configured)).toHaveProperty('mcp', helper);
  expect(withMcpIdentity(projectDurableEvent({ type: 'tool_end', tool: AGENT_RESULT_TOOL_NAME, callId: 'call' })[0]!, configured)).toHaveProperty('mcp', helper);
  expect(mapPiMessageToAgentEvent(start, mcpEventIdentities())).not.toHaveProperty('mcp');
});

it('assigns Grok no MCP identity from its collapsed tool name', () => {
  const events: Array<AgentEvent | MessageDraftDelta> = [];
  // Grok 1.0.62 names an MCP tool `<server>__<tool>` and also routes MCP calls through `use_tool` / `CallMcpTool`.
  const tools = ['market__feed__get__quote', name, 'use_tool', 'CallMcpTool', 'run_terminal_command'];
  new GrokProjection('root').consume({ seq: 1, sessionId: 'root', agentPath: [], kind: 'frame', body: { events: tools.flatMap((tool, index) => [
    { kind: 'tool_call_started', callId: `call-${index}`, tool, input: '{}' },
    { kind: 'tool_call_ended', callId: `call-${index}`, result: 'completed' },
  ]) } }, event => events.push(event), () => {});
  expect(events.map(event => event.type)).toEqual(tools.flatMap(() => ['tool_use', 'tool_result']));
  for (const event of events) expect(event).not.toHaveProperty('mcp');
});

it('rejects ambiguous qualified-name collisions rather than assigning an arbitrary server', () => {
  const server = { toolsetId: 'market', serverName: 'ignored', serverInfo: { name: 'fixture', version: '1' }, protocolVersion: '2025-03-26' };
  const tool = { description: '', inputSchema: { type: 'object' } };
  expect(() => mcpEventIdentities({
    a__b: { ...server, tools: [{ ...tool, name: 'c' }] },
    a: { ...server, tools: [{ ...tool, name: 'b__c' }] },
  })).toThrow('duplicate MCP runtime tool name');
});

it('projects canonical Claude MCP observations with structuredContent while leaving non-MCP tools unchanged', () => {
  const correlation: ToolUseCorrelation = { toolNameByUseId: new Map(), mcpIdentities: identities };
  const use = mapClaudeMessageToAgentEvents({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'c1', name, input: { symbol: 'NVDA' } },
    { type: 'tool_use', id: 'c2', name, input: { symbol: 'AMD' } },
    { type: 'tool_use', id: 'c3', name, input: { symbol: 'INTC' } },
    { type: 'tool_use', id: 'c4', name, input: { symbol: 'ERR' } },
    { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'echo ok' } },
  ] } }, correlation, { workspaceDir: '/tmp' }).events;
  expect(use[0]).toEqual({ type: 'tool_use', mcp, tool: name, input: { symbol: 'NVDA' }, toolCallId: 'c1' });
  expect(use[4]).toEqual({ type: 'tool_use', tool: 'Bash', input: { command: 'echo ok' }, toolCallId: 'b1' });

  // Single tool_result with structuredContent in tool_use_result.
  const structured = mapClaudeMessageToAgentEvents({
    type: 'user',
    tool_use_result: { content: [{ type: 'text', text: '142.50' }], structuredContent: { price: 142.5 } },
    message: { content: [{ type: 'tool_result', tool_use_id: 'c1', content: '142.50', is_error: false }] },
  }, correlation, { workspaceDir: '/tmp' }).events[0];
  expect(structured).toEqual({
    type: 'tool_result', mcp, tool: name, toolCallId: 'c1', isError: false,
    output: { content: [{ type: 'text', text: '142.50' }], structuredContent: { price: 142.5 } },
  });
  expect(AgentEventSchema.parse(structured)).toEqual(structured);

  // Error propagated from tool_use_result.isError even when block.is_error is false, and null structuredContent omitted.
  const failed = mapClaudeMessageToAgentEvents({
    type: 'user',
    tool_use_result: { content: [{ type: 'text', text: 'not found' }], structuredContent: null, isError: true },
    message: { content: [{ type: 'tool_result', tool_use_id: 'c2', content: 'not found', is_error: false }] },
  }, correlation, { workspaceDir: '/tmp' }).events[0];
  expect(failed).toEqual({
    type: 'tool_result', mcp, tool: name, toolCallId: 'c2', isError: true,
    output: { content: [{ type: 'text', text: 'not found' }] },
  });

  // Failure without any MCP payload emits canonical empty content array with isError: true.
  const emptyFailure = mapClaudeMessageToAgentEvents({
    type: 'user',
    tool_use_result: { isError: true },
    message: { content: [{ type: 'tool_result', tool_use_id: 'c4', is_error: false }] },
  }, correlation, { workspaceDir: '/tmp' }).events[0];
  expect(emptyFailure).toEqual({
    type: 'tool_result', mcp, tool: name, toolCallId: 'c4', isError: true,
    output: { content: [] },
  });

  // Multi-block user message ignores msg.tool_use_result, normalizes MCP string content, and leaves non-MCP Bash untouched.
  const mixed = mapClaudeMessageToAgentEvents({
    type: 'user',
    tool_use_result: { content: [{ type: 'text', text: 'wrong-shared' }], structuredContent: { wrong: true } },
    message: { content: [
      { type: 'tool_result', tool_use_id: 'c3', content: 'plain quote', is_error: false },
      { type: 'tool_result', tool_use_id: 'b1', content: 'ok', is_error: false },
    ] },
  }, correlation, { workspaceDir: '/tmp' }).events;
  expect(mixed).toEqual([
    { type: 'tool_result', mcp, tool: name, toolCallId: 'c3', isError: false, output: { content: [{ type: 'text', text: 'plain quote' }] } },
    { type: 'tool_result', tool: 'Bash', toolCallId: 'b1', isError: false, output: { content: 'ok' } },
  ]);
});

it('projects canonical Pi and durable Pi MCP observations without leaking rendered text blocks', async () => {
  const observation = { market__feed: { toolsetId: 'market', serverName: 'market__feed', serverInfo: { name: 'market', version: '1' }, protocolVersion: '2025-03-26', tools: [
    { name: 'get__quote', description: 'quote', inputSchema: { type: 'object' } },
  ] } };
  const cases = [
    {
      raw: { content: [{ type: 'text' as const, text: 'done' }], structuredContent: { leads: 2 }, isError: false },
      expectedOutput: { content: [{ type: 'text', text: 'done' }], structuredContent: { leads: 2 } },
      expectedRenderedContent: [{ type: 'text', text: 'done' }, { type: 'text', text: '{"leads":2}' }],
      expectedError: false,
    },
    {
      raw: { content: [], structuredContent: { only: true }, isError: false },
      expectedOutput: { content: [], structuredContent: { only: true } },
      expectedRenderedContent: [{ type: 'text', text: '{"only":true}' }],
      expectedError: false,
    },
    {
      raw: { content: [{ type: 'resource_link' as const, uri: 'file:///leads.csv', name: 'leads.csv' }], isError: false },
      expectedOutput: { content: [{ type: 'resource_link', uri: 'file:///leads.csv', name: 'leads.csv' }] },
      expectedRenderedContent: [{ type: 'text', text: '[MCP returned a resource_link block for file:///leads.csv]' }],
      expectedError: false,
    },
    {
      raw: { content: [{ type: 'text' as const, text: 'upstream failed' }], isError: true },
      expectedOutput: { content: [{ type: 'text', text: 'upstream failed' }] },
      expectedRenderedContent: [{ type: 'text', text: 'upstream failed' }],
      expectedError: true,
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const [piTool] = createPiMcpTools(projectMcpTools(observation), { call: async () => entry.raw });
    const execResult = await piTool!.execute(`call-${index}`, { symbol: 'NVDA' }, undefined);
    expect(execResult.content).toEqual(entry.expectedRenderedContent);
    expect(execResult.isError === true).toBe(entry.expectedError);

    const piEvent = mapPiMessageToAgentEvent({
      type: 'tool_execution_end', toolName: name, toolCallId: `call-${index}`,
      result: execResult, isError: execResult.isError === true,
    }, identities);
    expect(piEvent).toEqual({
      type: 'tool_result', mcp, tool: name, toolCallId: `call-${index}`,
      isError: entry.expectedError, output: entry.expectedOutput,
    });
    expect(AgentEventSchema.parse(piEvent)).toEqual(piEvent);

    const durableEntry = {
      id: index + 1, kind: 'pi.tool-result',
      model: [{ role: 'toolResult', toolCallId: `call-${index}`, toolName: name, content: execResult.content, details: execResult.details, isError: execResult.details.isError }],
      data: {},
    };
    const durableEvent = withMcpIdentity(
      projectDurableEvent({ type: 'tool_end', callId: `call-${index}`, tool: name, entry: durableEntry as never })[0]!,
      identities,
    );
    expect(durableEvent).toEqual({
      type: 'tool_result', mcp, tool: name, toolCallId: `call-${index}`,
      isError: entry.expectedError, output: entry.expectedOutput,
    });
    expect(AgentEventSchema.parse(durableEvent)).toEqual(durableEvent);
  }

  // Propagates details.isError even when a Pi wire frame reports isError: false (e.g., hub call_tool error).
  const hubIdentities = mcpEventIdentities({ byoktools: { toolsetId: '@byok-sdk/mcp-hub', serverName: 'byoktools', serverInfo: { name: 'byoktools', version: '1' }, protocolVersion: '2025-11-25', tools: [
    { name: 'call_tool', description: '', inputSchema: { type: 'object' } },
  ] } });
  const hubErr = mapPiMessageToAgentEvent({
    type: 'tool_execution_end', toolName: 'mcp__byoktools__call_tool', toolCallId: 'hub-1', isError: false,
    result: { content: [{ type: 'text', text: 'denied' }], details: { serverName: 'byoktools', toolName: 'call_tool', isError: true } },
  }, hubIdentities);
  expect(hubErr).toEqual({
    type: 'tool_result', mcp: { server: 'byoktools', tool: 'call_tool' }, tool: 'mcp__byoktools__call_tool', toolCallId: 'hub-1',
    isError: true, output: { content: [{ type: 'text', text: 'denied' }] },
  });

  // Missing or unrecognized Pi / durable Pi MCP results emit { content: [] } with isError: true.
  for (const badResult of [undefined, 'plain error', {}, { content: 'not-array' }]) {
    const missingPi = mapPiMessageToAgentEvent({
      type: 'tool_execution_end', toolName: name, toolCallId: 'pi-bad', result: badResult, isError: false,
    }, identities);
    expect(missingPi).toEqual({
      type: 'tool_result', mcp, tool: name, toolCallId: 'pi-bad', isError: true, output: { content: [] },
    });
  }
  const missingDurableEntry = withMcpIdentity(
    projectDurableEvent({ type: 'tool_end', callId: 'dur-missing', tool: name })[0]!,
    identities,
  );
  expect(missingDurableEntry).toEqual({
    type: 'tool_result', mcp, tool: name, toolCallId: 'dur-missing', isError: true, output: { content: [] },
  });
  const malformedDurable = withMcpIdentity(
    projectDurableEvent({ type: 'tool_end', callId: 'dur-bad', tool: name, entry: { id: 8, kind: 'pi.tool-result', model: [{ role: 'toolResult', isError: true }], data: {} } as never })[0]!,
    identities,
  );
  expect(malformedDurable).toEqual({
    type: 'tool_result', mcp, tool: name, toolCallId: 'dur-bad', isError: true, output: { content: [] },
  });

  // Non-MCP tools keep their existing wrapper in both Pi and durable Pi.
  expect(mapPiMessageToAgentEvent({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'b1', result: { stdout: 'hi' }, isError: false }, identities))
    .toEqual({ type: 'tool_result', tool: 'bash', toolCallId: 'b1', isError: false, output: { result: { stdout: 'hi' } } });
  const nonMcpDurable = withMcpIdentity(
    projectDurableEvent({ type: 'tool_end', callId: 'b2', tool: 'bash', entry: { id: 9, kind: 'pi.tool-result', model: [{ role: 'toolResult', content: [{ type: 'text', text: 'hi' }], isError: false }], data: {} } as never })[0]!,
    identities,
  );
  expect(nonMcpDurable).toEqual({
    type: 'tool_result', tool: 'bash', toolCallId: 'b2', isError: false,
    output: { role: 'toolResult', content: [{ type: 'text', text: 'hi' }], isError: false },
  });
});

it('projects canonical Codex MCP observations while keeping non-MCP Codex branches unchanged', () => {
  const kernel = createSessionKernel('root');
  const projection = new CodexProjection('/workspace', 'root');
  const out: Array<AgentEvent | MessageDraftDelta> = [];
  const feed = (type: string, native: unknown) => {
    const body = { type, native, events: [], origin: 'byok-native', byokRoot: true };
    projection.consume(kernel, kernel.frame(body), event => out.push(event));
  };

  feed('item/started', { item: { id: 'm1', type: 'mcpToolCall', server: 'market', tool: 'quote', arguments: { symbol: 'NVDA' } } });
  feed('item/completed', { item: { id: 'm1', type: 'mcpToolCall', server: 'market', tool: 'quote', status: 'completed', result: { content: [{ type: 'text', text: '142.50' }], structuredContent: null } } });
  feed('item/started', { item: { id: 'm2', type: 'mcpToolCall', server: 'market', tool: 'quote', arguments: { symbol: 'BAD' } } });
  feed('item/completed', { item: { id: 'm2', type: 'mcpToolCall', server: 'market', tool: 'quote', status: 'failed', result: null, error: { message: 'refused' } } });
  feed('item/started', { item: { id: 'm3', type: 'mcpToolCall', server: 'market', tool: 'quote', arguments: { symbol: 'ERR' } } });
  feed('item/completed', { item: { id: 'm3', type: 'mcpToolCall', server: 'market', tool: 'quote', status: 'completed', result: { content: [{ type: 'text', text: 'bad' }], isError: true } } });
  feed('item/started', { item: { id: 'm3b', type: 'mcpToolCall', server: 'market', tool: 'quote', arguments: { symbol: 'RED' } } });
  feed('item/completed', { item: { id: 'm3b', type: 'mcpToolCall', server: 'market', tool: 'quote', status: 'completed', result: '[redacted]' } });
  feed('item/started', { item: { id: 'm4', type: 'mcpToolCall', server: 'market', tool: 'quote', arguments: { symbol: 'INT' } } });
  feed('item/started', { item: { id: 'c1', type: 'commandExecution', command: 'sleep 9' } });
  feed('turn/completed', { turn: { status: 'interrupted' } });

  expect(out).toEqual([
    { type: 'tool_use', tool: 'mcp_tool_call', toolCallId: 'm1', mcp: { server: 'market', tool: 'quote' }, input: { symbol: 'NVDA' } },
    { type: 'tool_result', tool: 'mcp_tool_call', toolCallId: 'm1', mcp: { server: 'market', tool: 'quote' }, isError: false, output: { content: [{ type: 'text', text: '142.50' }] } },
    { type: 'tool_use', tool: 'mcp_tool_call', toolCallId: 'm2', mcp: { server: 'market', tool: 'quote' }, input: { symbol: 'BAD' } },
    { type: 'tool_result', tool: 'mcp_tool_call', toolCallId: 'm2', mcp: { server: 'market', tool: 'quote' }, isError: true, output: { content: [] } },
    { type: 'tool_use', tool: 'mcp_tool_call', toolCallId: 'm3', mcp: { server: 'market', tool: 'quote' }, input: { symbol: 'ERR' } },
    { type: 'tool_result', tool: 'mcp_tool_call', toolCallId: 'm3', mcp: { server: 'market', tool: 'quote' }, isError: true, output: { content: [{ type: 'text', text: 'bad' }] } },
    { type: 'tool_use', tool: 'mcp_tool_call', toolCallId: 'm3b', mcp: { server: 'market', tool: 'quote' }, input: { symbol: 'RED' } },
    { type: 'tool_result', tool: 'mcp_tool_call', toolCallId: 'm3b', mcp: { server: 'market', tool: 'quote' }, isError: true, output: { content: [] } },
    { type: 'tool_use', tool: 'mcp_tool_call', toolCallId: 'm4', mcp: { server: 'market', tool: 'quote' }, input: { symbol: 'INT' } },
    { type: 'tool_use', tool: 'command_execution', toolCallId: 'c1', input: { command: 'sleep 9' } },
    { type: 'tool_result', tool: 'mcp_tool_call', toolCallId: 'm4', mcp: { server: 'market', tool: 'quote' }, isError: true, output: { content: [] } },
    { type: 'tool_result', tool: 'command_execution', toolCallId: 'c1', output: { status: 'interrupted', reason: 'closed after turn interruption; runtime did not report item completion' } },
    { type: 'turn_end' },
  ]);
  for (const event of out) expect(AgentEventSchema.parse(event)).toEqual(event);
});

it('projects canonical Antigravity ACP MCP observations without truncation or OAR rewrites', () => {
  const agyIdentities = agyMcpEventIdentities({ market__feed: { toolsetId: 'market', serverName: 'market__feed', serverInfo: { name: 'market', version: '1' }, protocolVersion: '2025-03-26', tools: [
    { name: 'get__quote', description: 'quote', inputSchema: { type: 'object' } },
  ] } });
  const agyName = 'mcp_market__feed_get__quote';
  const longText = 'x'.repeat(12_000);
  const projection = new AgyProjection('root', agyIdentities);
  const out: AgentEvent[] = [];
  const feed = (seq: number, body: Record<string, unknown>) =>
    projection.consume({ seq, sessionId: 'root', agentPath: [], kind: 'frame', body: { byokRoot: true, ...body } }, event => out.push(event), () => {});

  // 1. Canonical rawOutput with >10,000-char text, image mimeType, and structuredContent.
  feed(1, {
    native: { update: { toolCallId: 'a1', status: 'in_progress', rawInput: { symbol: 'NVDA' } } },
    events: [{ kind: 'tool_call_started', callId: 'a1', tool: agyName }],
  });
  feed(2, {
    native: { update: { toolCallId: 'a1', status: 'completed', rawOutput: {
      content: [{ type: 'text', text: longText }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }],
      structuredContent: { price: 142.5 },
    } } },
    events: [{ kind: 'tool_call_ended', callId: 'a1', result: 'completed', content: [{ type: 'text', text: longText.slice(0, 10_000) }, { type: 'image', data: 'AAAA', mediaType: 'image/png' }] }],
  });

  // 2. ACP content wrapper unwrapping + rawOutput.isError propagation.
  feed(3, {
    native: { update: { toolCallId: 'a2', status: 'in_progress', rawInput: { symbol: 'AMD' } } },
    events: [{ kind: 'tool_call_started', callId: 'a2', tool: agyName }],
  });
  feed(4, {
    native: { update: { toolCallId: 'a2', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'rate limited' } }], rawOutput: { isError: true } } },
    events: [{ kind: 'tool_call_ended', callId: 'a2', result: 'completed' }],
  });

  // 3. Fallback to normalized OAR content when update has no output + cancelled status sets isError.
  feed(5, {
    native: { update: { toolCallId: 'a2b', status: 'in_progress', rawInput: { symbol: 'INTC' } } },
    events: [{ kind: 'tool_call_started', callId: 'a2b', tool: agyName }],
  });
  feed(6, {
    native: { update: { toolCallId: 'a2b', status: 'cancelled' } },
    events: [{ kind: 'tool_call_ended', callId: 'a2b', content: [{ type: 'image', data: 'BBBB', mediaType: 'image/webp' }, { type: 'other', value: { type: 'resource_link', uri: 'file:///a' } }] }],
  });

  // 3b. Failed MCP call with no payload emits canonical { content: [] } with isError: true.
  feed(7, {
    native: { update: { toolCallId: 'a2c', status: 'in_progress', rawInput: { symbol: 'ERR' } } },
    events: [{ kind: 'tool_call_started', callId: 'a2c', tool: agyName }],
  });
  feed(8, {
    native: { update: { toolCallId: 'a2c', status: 'failed' } },
    events: [{ kind: 'tool_call_ended', callId: 'a2c', result: 'failed' }],
  });

  // 4. Non-MCP run_command keeps its CommandLine -> command normalization and { content, exitCode }.
  feed(9, {
    native: { update: { toolCallId: 'r1', status: 'in_progress', rawInput: { CommandLine: 'echo hi' } } },
    events: [{ kind: 'tool_call_started', callId: 'r1', tool: 'run_command' }],
  });
  feed(10, {
    native: { update: { toolCallId: 'r1', status: 'completed' } },
    events: [{ kind: 'tool_call_ended', callId: 'r1', result: 'completed', exitCode: 0, content: [{ type: 'text', text: 'hi' }] }],
  });

  // 5. Unclosed MCP call at turn_ended gets canonical { content: [] } + isError: true; unclosed non-MCP keeps status/reason.
  feed(11, {
    native: { update: { toolCallId: 'a3', status: 'in_progress', rawInput: { symbol: 'INT' } } },
    events: [{ kind: 'tool_call_started', callId: 'a3', tool: agyName }],
  });
  feed(12, {
    native: { update: { toolCallId: 'r2', status: 'in_progress', rawInput: { CommandLine: 'sleep 9' } } },
    events: [{ kind: 'tool_call_started', callId: 'r2', tool: 'run_command' }],
  });
  feed(13, { events: [{ kind: 'turn_ended', outcome: { kind: 'aborted' } }] });

  expect(out).toEqual([
    { type: 'tool_use', tool: agyName, toolCallId: 'a1', mcp, input: { symbol: 'NVDA' } },
    { type: 'tool_result', tool: agyName, toolCallId: 'a1', mcp, output: { content: [{ type: 'text', text: longText }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }], structuredContent: { price: 142.5 } } },
    { type: 'tool_use', tool: agyName, toolCallId: 'a2', mcp, input: { symbol: 'AMD' } },
    { type: 'tool_result', tool: agyName, toolCallId: 'a2', mcp, isError: true, output: { content: [{ type: 'text', text: 'rate limited' }] } },
    { type: 'tool_use', tool: agyName, toolCallId: 'a2b', mcp, input: { symbol: 'INTC' } },
    { type: 'tool_result', tool: agyName, toolCallId: 'a2b', mcp, isError: true, output: { content: [{ type: 'image', data: 'BBBB', mimeType: 'image/webp' }, { type: 'resource_link', uri: 'file:///a' }] } },
    { type: 'tool_use', tool: agyName, toolCallId: 'a2c', mcp, input: { symbol: 'ERR' } },
    { type: 'tool_result', tool: agyName, toolCallId: 'a2c', mcp, isError: true, output: { content: [] } },
    { type: 'tool_use', tool: 'run_command', toolCallId: 'r1', input: { CommandLine: 'echo hi', command: 'echo hi' } },
    { type: 'tool_result', tool: 'run_command', toolCallId: 'r1', output: { content: [{ type: 'text', text: 'hi' }], exitCode: 0 } },
    { type: 'tool_use', tool: agyName, toolCallId: 'a3', mcp, input: { symbol: 'INT' } },
    { type: 'tool_use', tool: 'run_command', toolCallId: 'r2', input: { CommandLine: 'sleep 9', command: 'sleep 9' } },
    { type: 'tool_result', tool: agyName, toolCallId: 'a3', mcp, isError: true, output: { content: [] } },
    { type: 'tool_result', tool: 'run_command', toolCallId: 'r2', output: { status: 'interrupted', reason: 'closed at turn end; runtime did not report the call ended' } },
  ]);
  for (const event of out) expect(AgentEventSchema.parse(event)).toEqual(event);
});

it('assigns DSH no MCP identity because its bridge emits model-rendered tool results rather than CallToolResult', () => {
  const projection = new DshProjection('root');
  const out: AgentEvent[] = [];
  const tools = [name, 'bash'];
  for (const [index, tool] of tools.entries()) {
    const callId = `dsh-${index}`;
    projection.consume({
      seq: index * 2 + 1, sessionId: 'root', agentPath: [], kind: 'frame',
      body: { byokRoot: true, native: { data: { arguments: JSON.stringify({ x: index }) } }, events: [{ kind: 'tool_call_started', callId, tool }] },
    }, event => out.push(event), () => {});
    projection.consume({
      seq: index * 2 + 2, sessionId: 'root', agentPath: [], kind: 'frame',
      body: { byokRoot: true, native: { data: { message: { content: [{ type: 'text', text: 'ok' }], isError: false } } }, events: [{ kind: 'tool_call_ended', callId, result: 'completed', content: [{ type: 'text', text: 'ok' }] }] },
    }, event => out.push(event), () => {});
  }
  expect(out.map(event => event.type)).toEqual(tools.flatMap(() => ['tool_use', 'tool_result']));
  for (const event of out) expect(event).not.toHaveProperty('mcp');
});

it('assigns OpenCode no MCP identity from v1 tool names or v2 sandbox execute calls', () => {
  const events: AgentEvent[] = [];
  const projection = new OpenCodeProjection('root');
  const tools = ['market_get_quote', name, 'execute', 'bash'];
  for (const [index, tool] of tools.entries()) {
    const callId = `oc-${index}`;
    projection.consume({
      seq: index * 2 + 1, sessionId: 'root', agentPath: [], kind: 'frame',
      body: { byokRoot: true, native: { update: { toolCallId: callId, status: 'in_progress', rawInput: { x: index } } }, events: [{ kind: 'tool_call_started', callId, tool }] },
    }, event => events.push(event), () => {});
    projection.consume({
      seq: index * 2 + 2, sessionId: 'root', agentPath: [], kind: 'frame',
      body: { byokRoot: true, native: { update: { toolCallId: callId, status: 'completed' } }, events: [{ kind: 'tool_call_ended', callId, result: 'completed', content: [{ type: 'text', text: 'ok' }] }] },
    }, event => events.push(event), () => {});
  }
  expect(events.map(event => event.type)).toEqual(tools.flatMap(() => ['tool_use', 'tool_result']));
  for (const event of events) expect(event).not.toHaveProperty('mcp');
});
