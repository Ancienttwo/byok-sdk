import type { AgentMessageContentType } from '@byok-sdk/protocol';
import { AGENT_MESSAGE_TOOL_NAME } from '../sdk-reserved-mcp';
import {
  McpServerToolError,
  serveMcpOverStdio,
  type McpServerToolCall,
  type McpServerToolDefinition,
} from '../mcp-server';

export interface AgentMessageMcpDeps {
  publish(input: { contentType: AgentMessageContentType; body: string }): Promise<{ messageId: string; state: string }>;
}

/** The exact tool this server advertises. The JSON Schema literal is product authority and reaches the peer verbatim. */
export const AGENT_MESSAGE_TOOLS: readonly McpServerToolDefinition[] = [
  {
    name: AGENT_MESSAGE_TOOL_NAME,
    description:
      'Send the single user-visible Agent reply for this exact task. Routing identity is supplied by the authenticated task context.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['body'],
      properties: {
        body: { type: 'string', minLength: 1 },
        contentType: { type: 'string', enum: ['text/plain', 'text/markdown'] },
      },
    },
  },
];

const SERVER_INFO = { name: 'byok-agent-message-mcp', version: '0.0.1' };

/**
 * One `tools/call`, returning the JSON-RPC `result` payload. Envelope, framing
 * and protocol faults belong to `../mcp-server`; the input contract below —
 * body only, no routing identity from the model — is this server's and stays
 * here.
 */
export async function handleAgentMessageToolCall(
  call: McpServerToolCall,
  deps: AgentMessageMcpDeps,
): Promise<Record<string, unknown>> {
  if (call.name !== AGENT_MESSAGE_TOOL_NAME) throw new McpServerToolError(-32602, 'unknown Agent message tool');
  const record = call.arguments;
  if (record === undefined) throw new McpServerToolError(-32602, 'message input must be an object');
  if (Object.keys(record).some((key) => key !== 'body' && key !== 'contentType') || typeof record.body !== 'string' || record.body.length === 0) {
    throw new McpServerToolError(-32602, 'message input accepts only non-empty body and optional contentType');
  }
  const contentType = record.contentType ?? 'text/markdown';
  if (contentType !== 'text/plain' && contentType !== 'text/markdown') throw new McpServerToolError(-32602, 'unsupported contentType');
  try {
    const receipt = await deps.publish({ contentType, body: record.body });
    return { content: [{ type: 'text', text: JSON.stringify(receipt) }] };
  } catch (error) {
    throw new McpServerToolError(-32000, error instanceof Error ? error.message : String(error));
  }
}

export function serveAgentMessageMcpOverStdio(input: { deps: AgentMessageMcpDeps; stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream }): void {
  serveMcpOverStdio({
    serverInfo: SERVER_INFO,
    tools: AGENT_MESSAGE_TOOLS,
    callTool: (call) => handleAgentMessageToolCall(call, input.deps),
    input: input.stdin,
    output: input.stdout,
  });
}
