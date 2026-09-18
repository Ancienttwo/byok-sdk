import {
  McpServerToolError,
  serveMcpOverStdio,
  type McpServerToolCall,
  type McpServerToolDefinition,
} from '../mcp-server';

export const AGENT_MEMORY_RECALL_TOOL_NAME = 'memory_recall';
export const AGENT_MEMORY_SAVE_TOOL_NAME = 'memory_save';

export interface AgentMemoryMcpDeps {
  recall(input: { path: string; ifRevision?: string }): Promise<{ path: string; revision: string; content: string; auditWarning?: { code: 'agent_memory_audit_unavailable' } }>;
  save(input: { op: 'replace' | 'delete'; path: string; expectedRevision: string; content?: string }): Promise<{ path: string; revision?: string; deleted: boolean }>;
}

/** The exact tools this server advertises. The JSON Schema literals are product authority and reach the peer verbatim. */
export const AGENT_MEMORY_TOOLS: readonly McpServerToolDefinition[] = [
  { name: AGENT_MEMORY_RECALL_TOOL_NAME, description: 'Recall one SDK-owned memory file for this exact active Agent task. Identity and memory root are never model parameters.', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' }, ifRevision: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' } } } },
  { name: AGENT_MEMORY_SAVE_TOOL_NAME, description: 'Atomically replace or delete one SDK-owned memory file with exact sha256 compare-and-swap.', inputSchema: { type: 'object', additionalProperties: false, required: ['op', 'path', 'expectedRevision'], properties: { op: { type: 'string', enum: ['replace', 'delete'] }, path: { type: 'string' }, expectedRevision: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, content: { type: 'string' } } } },
];

const SERVER_INFO = { name: 'byok-agent-memory-mcp', version: '0.0.1' };

const invalid = (message: string): McpServerToolError => new McpServerToolError(-32602, message);
const success = (value: unknown): Record<string, unknown> => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/**
 * One `tools/call`, returning the JSON-RPC `result` payload. The path policy,
 * the compare-and-swap contract and the exact accepted argument set stay here;
 * envelope, framing and protocol faults belong to `../mcp-server`.
 */
export async function handleAgentMemoryToolCall(call: McpServerToolCall, deps: AgentMemoryMcpDeps): Promise<Record<string, unknown>> {
  const args = call.arguments;
  if (args === undefined) throw invalid('memory tool input must be an object');
  try {
    if (call.name === AGENT_MEMORY_RECALL_TOOL_NAME) {
      if (Object.keys(args).some((key) => key !== 'path' && key !== 'ifRevision') || typeof args.path !== 'string' || (args.ifRevision !== undefined && typeof args.ifRevision !== 'string')) throw invalid('memory_recall accepts only path and optional ifRevision');
      return success(await deps.recall({ path: args.path, ...(args.ifRevision === undefined ? {} : { ifRevision: args.ifRevision }) }));
    }
    if (call.name === AGENT_MEMORY_SAVE_TOOL_NAME) {
      if (Object.keys(args).some((key) => key !== 'op' && key !== 'path' && key !== 'expectedRevision' && key !== 'content') || (args.op !== 'replace' && args.op !== 'delete') || typeof args.path !== 'string' || typeof args.expectedRevision !== 'string' || (args.op === 'replace' && typeof args.content !== 'string') || (args.op === 'delete' && args.content !== undefined)) throw invalid('memory_save requires replace|delete, path, expectedRevision, and content only for replace');
      const content = args.content;
      return success(await deps.save({ op: args.op, path: args.path, expectedRevision: args.expectedRevision, ...(typeof content === 'string' ? { content } : {}) }));
    }
    throw invalid('unknown Agent memory tool');
  } catch (error) {
    if (error instanceof McpServerToolError) throw error;
    throw new McpServerToolError(-32000, error instanceof Error ? error.message : String(error));
  }
}

export function serveAgentMemoryMcpOverStdio(input: { deps: AgentMemoryMcpDeps; stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream }): void {
  serveMcpOverStdio({
    serverInfo: SERVER_INFO,
    tools: AGENT_MEMORY_TOOLS,
    callTool: (call) => handleAgentMemoryToolCall(call, input.deps),
    input: input.stdin,
    output: input.stdout,
  });
}
