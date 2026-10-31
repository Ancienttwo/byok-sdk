import { AGENT_MEMORY_RECALL_TOOL_NAME as RECALL_TOOL, AGENT_MEMORY_SAVE_TOOL_NAME as SAVE_TOOL } from '../sdk-reserved-mcp';
import type { McpServerToolDefinition } from '../mcp-server';

export const AGENT_MEMORY_RECALL_TOOL_NAME = RECALL_TOOL;
export const AGENT_MEMORY_SAVE_TOOL_NAME = SAVE_TOOL;
export const PREPARED_AGENT_MEMORY_OPERATION_META_KEY = 'byok.agent-memory.operation';

export type AgentMemoryOperation = 'read' | 'write';

export interface AgentMemoryToolDefinition extends McpServerToolDefinition {
  readonly operation: AgentMemoryOperation;
  readonly _meta: Readonly<Record<typeof PREPARED_AGENT_MEMORY_OPERATION_META_KEY, AgentMemoryOperation>>;
}

function agentMemoryTool(input: Omit<AgentMemoryToolDefinition, '_meta'>): AgentMemoryToolDefinition {
  return Object.freeze({ ...input, _meta: Object.freeze({ [PREPARED_AGENT_MEMORY_OPERATION_META_KEY]: input.operation }) });
}

/** The exact tools this server advertises. This table is the sole schema and operation-classification authority. */
export const AGENT_MEMORY_TOOLS: readonly AgentMemoryToolDefinition[] = Object.freeze([
  agentMemoryTool({ name: AGENT_MEMORY_RECALL_TOOL_NAME, operation: 'read', description: 'Recall one SDK-owned memory file for this exact active Agent task. Identity and memory root are never model parameters.', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' }, ifRevision: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' } } } }),
  agentMemoryTool({ name: AGENT_MEMORY_SAVE_TOOL_NAME, operation: 'write', description: 'Atomically replace or delete one SDK-owned memory file with exact sha256 compare-and-swap.', inputSchema: { type: 'object', additionalProperties: false, required: ['op', 'path', 'expectedRevision'], properties: { op: { type: 'string', enum: ['replace', 'delete'] }, path: { type: 'string' }, expectedRevision: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, content: { type: 'string' } } } }),
]);

export const AGENT_MEMORY_MCP_SERVER_INFO = Object.freeze({ name: 'byok-agent-memory-mcp', version: '0.0.1' });
