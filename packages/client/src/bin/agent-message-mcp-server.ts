import { createInterface } from 'node:readline';
import type { AgentMessageContentType } from '@byok-sdk/protocol';
import { AGENT_MESSAGE_TOOL_NAME } from '../sdk-reserved-mcp';

export interface AgentMessageMcpDeps {
  publish(input: { contentType: AgentMessageContentType; body: string }): Promise<{ messageId: string; state: string }>;
}

interface RequestLike { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

export async function handleAgentMessageMcpRequest(
  request: RequestLike,
  deps: AgentMessageMcpDeps,
): Promise<Record<string, unknown> | undefined> {
  const id = request.id;
  if (request.method === 'initialize') {
    const params = (request.params ?? {}) as { protocolVersion?: unknown };
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'byok-agent-message-mcp', version: '0.0.1' },
      },
    };
  }
  if (request.method === 'notifications/initialized') return undefined;
  if (request.method === 'tools/list') {
    return {
      jsonrpc: '2.0', id, result: { tools: [{
        name: AGENT_MESSAGE_TOOL_NAME,
        description: 'Send the single user-visible Agent reply for this exact task. Routing identity is supplied by the authenticated task context.',
        inputSchema: {
          type: 'object', additionalProperties: false, required: ['body'],
          properties: {
            body: { type: 'string', minLength: 1 },
            contentType: { type: 'string', enum: ['text/plain', 'text/markdown'] },
          },
        },
      }] },
    };
  }
  if (request.method === 'tools/call') {
    const params = (request.params ?? {}) as { name?: unknown; arguments?: unknown };
    if (params.name !== AGENT_MESSAGE_TOOL_NAME) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown Agent message tool' } };
    const args = params.arguments;
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return { jsonrpc: '2.0', id, error: { code: -32602, message: 'message input must be an object' } };
    const record = args as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'body' && key !== 'contentType') || typeof record.body !== 'string' || record.body.length === 0) {
      return { jsonrpc: '2.0', id, error: { code: -32602, message: 'message input accepts only non-empty body and optional contentType' } };
    }
    const contentType = record.contentType ?? 'text/markdown';
    if (contentType !== 'text/plain' && contentType !== 'text/markdown') return { jsonrpc: '2.0', id, error: { code: -32602, message: 'unsupported contentType' } };
    try {
      const receipt = await deps.publish({ contentType, body: record.body });
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(receipt) }] } };
    } catch (error) {
      return { jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
    }
  }
  return id === undefined ? undefined : { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${String(request.method)}` } };
}

export function serveAgentMessageMcpOverStdio(input: { deps: AgentMessageMcpDeps; stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream }): void {
  const reader = createInterface({ input: input.stdin ?? process.stdin, terminal: false });
  const output = input.stdout ?? process.stdout;
  reader.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    void (async () => {
      let request: RequestLike;
      try { request = JSON.parse(trimmed) as RequestLike; } catch { return; }
      const response = await handleAgentMessageMcpRequest(request, input.deps);
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
    })();
  });
}
