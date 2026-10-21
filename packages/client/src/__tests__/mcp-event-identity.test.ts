import { expect, it } from 'vitest';
import { AgentEventSchema } from '@byok-sdk/protocol';
import { mcpEventIdentities } from '../mcp/event-identity';
import { createToolUseCorrelation, mapClaudeMessageToAgentEvents } from '../adapters/claude/events';
import { mapPiMessageToAgentEvent } from '../adapters/pi/events';

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

it('rejects ambiguous qualified-name collisions rather than assigning an arbitrary server', () => {
  const server = { toolsetId: 'market', serverName: 'ignored', serverInfo: { name: 'fixture', version: '1' }, protocolVersion: '2025-03-26' };
  const tool = { description: '', inputSchema: { type: 'object' } };
  expect(() => mcpEventIdentities({
    a__b: { ...server, tools: [{ ...tool, name: 'c' }] },
    a: { ...server, tools: [{ ...tool, name: 'b__c' }] },
  })).toThrow('duplicate MCP runtime tool name');
});
