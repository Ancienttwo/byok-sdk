import { createInterface } from 'node:readline';

export const AGENT_MEMORY_RECALL_TOOL_NAME = 'memory.recall';
export const AGENT_MEMORY_SAVE_TOOL_NAME = 'memory.save';

export interface AgentMemoryMcpDeps {
  recall(input: { path: string; ifRevision?: string }): Promise<{ path: string; revision: string; content: string }>;
  save(input: { op: 'replace' | 'delete'; path: string; expectedRevision: string; content?: string }): Promise<{ path: string; revision?: string; deleted: boolean }>;
}
interface RequestLike { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
function record(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function invalid(id: unknown, message: string): Record<string, unknown> { return { jsonrpc: '2.0', id, error: { code: -32602, message } }; }
function success(id: unknown, value: unknown): Record<string, unknown> { return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } }; }

export async function handleAgentMemoryMcpRequest(request: RequestLike, deps: AgentMemoryMcpDeps): Promise<Record<string, unknown> | undefined> {
  const id = request.id;
  if (request.method === 'initialize') {
    const params = record(request.params) ?? {};
    return { jsonrpc: '2.0', id, result: { protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'byok-agent-memory-mcp', version: '0.0.1' } } };
  }
  if (request.method === 'notifications/initialized') return undefined;
  if (request.method === 'tools/list') return {
    jsonrpc: '2.0', id, result: { tools: [
      { name: AGENT_MEMORY_RECALL_TOOL_NAME, description: 'Recall one SDK-owned memory file for this exact active Agent task. Identity and memory root are never model parameters.', inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' }, ifRevision: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' } } } },
      { name: AGENT_MEMORY_SAVE_TOOL_NAME, description: 'Atomically replace or delete one SDK-owned memory file with exact sha256 compare-and-swap.', inputSchema: { type: 'object', additionalProperties: false, required: ['op', 'path', 'expectedRevision'], properties: { op: { type: 'string', enum: ['replace', 'delete'] }, path: { type: 'string' }, expectedRevision: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' }, content: { type: 'string' } } } },
    ] },
  };
  if (request.method !== 'tools/call') return id === undefined ? undefined : { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${String(request.method)}` } };
  const params = record(request.params); const args = record(params?.arguments);
  if (!params || !args || typeof params.name !== 'string') return invalid(id, 'memory tool input must be an object');
  try {
    if (params.name === AGENT_MEMORY_RECALL_TOOL_NAME) {
      if (Object.keys(args).some((key) => key !== 'path' && key !== 'ifRevision') || typeof args.path !== 'string' || (args.ifRevision !== undefined && typeof args.ifRevision !== 'string')) return invalid(id, 'memory.recall accepts only path and optional ifRevision');
      return success(id, await deps.recall({ path: args.path, ...(args.ifRevision === undefined ? {} : { ifRevision: args.ifRevision }) }));
    }
    if (params.name === AGENT_MEMORY_SAVE_TOOL_NAME) {
      if (Object.keys(args).some((key) => key !== 'op' && key !== 'path' && key !== 'expectedRevision' && key !== 'content') || (args.op !== 'replace' && args.op !== 'delete') || typeof args.path !== 'string' || typeof args.expectedRevision !== 'string' || (args.op === 'replace' && typeof args.content !== 'string') || (args.op === 'delete' && args.content !== undefined)) return invalid(id, 'memory.save requires replace|delete, path, expectedRevision, and content only for replace');
      const content = args.content;
      return success(id, await deps.save({ op: args.op, path: args.path, expectedRevision: args.expectedRevision, ...(typeof content === 'string' ? { content } : {}) }));
    }
    return invalid(id, 'unknown Agent memory tool');
  } catch (error) { return { jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }; }
}

export function serveAgentMemoryMcpOverStdio(input: { deps: AgentMemoryMcpDeps; stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream }): void {
  const reader = createInterface({ input: input.stdin ?? process.stdin, terminal: false }); const output = input.stdout ?? process.stdout;
  reader.on('line', (line) => { const trimmed = line.trim(); if (!trimmed) return; void (async () => { let request: RequestLike; try { request = JSON.parse(trimmed) as RequestLike; } catch { return; } const response = await handleAgentMemoryMcpRequest(request, input.deps); if (response !== undefined) output.write(`${JSON.stringify(response)}\n`); })(); });
}
