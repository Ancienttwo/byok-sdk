import {
  AGENT_MEMORY_MCP_SERVER_INFO,
  AGENT_MEMORY_RECALL_TOOL_NAME,
  AGENT_MEMORY_SAVE_TOOL_NAME,
  AGENT_MEMORY_TOOLS,
  type AgentMemoryToolDefinition,
} from '../agent-memory/tool-manifest';
import {
  McpServerToolError,
  serveMcpOverStdio,
  type McpServerToolCall,
} from '../mcp-server';

export {
  AGENT_MEMORY_MCP_SERVER_INFO,
  AGENT_MEMORY_RECALL_TOOL_NAME,
  AGENT_MEMORY_SAVE_TOOL_NAME,
  AGENT_MEMORY_TOOLS,
  PREPARED_AGENT_MEMORY_OPERATION_META_KEY,
  type AgentMemoryOperation,
  type AgentMemoryToolDefinition,
} from '../agent-memory/tool-manifest';

export interface AgentMemoryMcpDeps {
  recall(input: { path: string; ifRevision?: string }): Promise<{ path: string; revision: string; content: string; auditWarning?: { code: 'agent_memory_audit_unavailable' } }>;
  save(input: { op: 'replace' | 'delete'; path: string; expectedRevision: string; content?: string }): Promise<{ path: string; revision?: string; deleted: boolean }>;
}

const invalid = (message: string): McpServerToolError => new McpServerToolError(-32602, message);
const success = (value: unknown): Record<string, unknown> => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/**
 * One `tools/call`, returning the JSON-RPC `result` payload. The path policy,
 * the compare-and-swap contract and the exact accepted argument set stay here;
 * envelope, framing and protocol faults belong to `../mcp-server`.
 */
export async function handleAgentMemoryToolCall(call: McpServerToolCall, deps: AgentMemoryMcpDeps, mode: 'read' | 'read-write'): Promise<Record<string, unknown>> {
  const args = call.arguments;
  if (args === undefined) throw invalid('memory tool input must be an object');
  try {
    if (call.name === AGENT_MEMORY_RECALL_TOOL_NAME) {
      if (Object.keys(args).some((key) => key !== 'path' && key !== 'ifRevision') || typeof args.path !== 'string' || (args.ifRevision !== undefined && typeof args.ifRevision !== 'string')) throw invalid('memory_recall accepts only path and optional ifRevision');
      return success(await deps.recall({ path: args.path, ...(args.ifRevision === undefined ? {} : { ifRevision: args.ifRevision }) }));
    }
    if (call.name === AGENT_MEMORY_SAVE_TOOL_NAME) {
      if (mode !== 'read-write') throw new McpServerToolError(-32000, 'agent_memory_operation_denied');
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

function serveAgentMemoryToolsOverStdio(tools: readonly AgentMemoryToolDefinition[], input: Parameters<typeof serveAgentMemoryMcpOverStdio>[0]): void {
  serveMcpOverStdio({
    serverInfo: AGENT_MEMORY_MCP_SERVER_INFO,
    tools,
    callTool: (call) => handleAgentMemoryToolCall(call, input.deps, input.mode),
    input: input.stdin,
    output: input.stdout,
  });
}

/** Lists the complete tool set; the prepared lane compares it with its sealed descriptor. */
export function serveAgentMemoryMcpOverStdio(input: { deps: AgentMemoryMcpDeps; mode: 'read' | 'read-write'; stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream }): void {
  serveAgentMemoryToolsOverStdio(AGENT_MEMORY_TOOLS, input);
}

/** Lists only the tools `mode` grants: a `read` helper lists `memory_recall` and no write tool. */
export function serveGrantedAgentMemoryMcpOverStdio(input: Parameters<typeof serveAgentMemoryMcpOverStdio>[0]): void {
  serveAgentMemoryToolsOverStdio(AGENT_MEMORY_TOOLS.filter((tool) => input.mode === 'read-write' || tool.operation === 'read'), input);
}

/** A task-free descriptor has the same tools/list identity, but never an execution handler. */
export function serveAgentMemoryDescriptorOverStdio(input: { stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream }): void {
  serveMcpOverStdio({
    serverInfo: AGENT_MEMORY_MCP_SERVER_INFO,
    tools: AGENT_MEMORY_TOOLS,
    callTool: async () => { throw new McpServerToolError(-32602, 'agent memory descriptor does not accept tools/call'); },
    input: input.stdin,
    output: input.stdout,
  });
}
