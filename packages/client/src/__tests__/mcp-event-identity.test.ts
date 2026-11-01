import { expect, it } from 'vitest';
import { AgentEventSchema, type AgentEvent } from '@byok-sdk/protocol';
import type { MessageDraftDelta } from '../types';
import { mcpEventIdentities } from '../mcp/event-identity';
import { createToolUseCorrelation, mapClaudeMessageToAgentEvents } from '../adapters/claude/events';
import { mapPiMessageToAgentEvent } from '../adapters/pi/events';
import { projectDurableEvent, withMcpIdentity } from '../adapters/pi-durable/events';
import { GrokProjection } from '../adapters/grok/projection';
import { AcpProjection } from '../runtime/acp-projection';

const identities = mcpEventIdentities({ market__feed: { toolsetId: 'market', serverName: 'market__feed', serverInfo: { name: 'market', version: '1' }, protocolVersion: '2025-03-26', tools: [
  { name: 'get__quote', description: 'quote', inputSchema: { type: 'object' } },
] } });
const name = 'mcp__market__feed__get__quote';
const mcp = { server: 'market__feed', tool: 'get__quote' };

it('retains exact observed Claude identity across tool use/result without delimiter guessing', () => {
  const correlation = createToolUseCorrelation(identities);
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
  ] } }, createToolUseCorrelation(), { workspaceDir: '/tmp' }).events[0];
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
  const result = withMcpIdentity(projectDurableEvent({ type: 'tool_execution_end', toolName: name, toolCallId: 'pi-call' })[0]!, identities);
  expect(use).toEqual({ type: 'tool_use', tool: name, mcp, toolCallId: 'task-call', input: {} });
  expect(result).toMatchObject({ type: 'tool_result', tool: name, mcp });
  expect(AgentEventSchema.parse(result)).toHaveProperty('mcp', mcp);
  for (const tool of ['bash', 'submit_result', 'mcp__unknown__quote']) {
    expect(withMcpIdentity({ type: 'tool_use', tool, toolCallId: 'other', input: {} }, identities)).not.toHaveProperty('mcp');
  }
  expect(withMcpIdentity({ type: 'progress', text: name }, identities)).toEqual({ type: 'progress', text: name });
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

it('assigns Hermes no MCP identity from its ACP title', () => {
  const events: Array<AgentEvent | MessageDraftDelta> = [];
  const projection = new AcpProjection();
  // Hermes 0.22.4 titles an MCP call with its registry name, often followed by `: <preview>`.
  for (const [index, title] of [name, `${name}: AAPL`, 'terminal: ls'].entries()) {
    projection.update({ sessionUpdate: 'tool_call', toolCallId: `call-${index}`, title, rawInput: {} }, event => events.push(event));
    projection.update({ sessionUpdate: 'tool_call_update', toolCallId: `call-${index}`, status: 'completed', rawOutput: 'ok' }, event => events.push(event));
  }
  expect(events.map(event => event.type)).toEqual(['tool_use', 'tool_result', 'tool_use', 'tool_result', 'tool_use', 'tool_result']);
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
