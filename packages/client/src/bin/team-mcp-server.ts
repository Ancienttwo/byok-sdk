import {
  McpServerToolError,
  serveMcpOverStdio,
  type McpServerToolCall,
  type McpServerToolDefinition,
} from '../mcp-server';

export const TEAM_POST_TOOL_NAME = 'post_team_message';
export const TEAM_READ_TOOL_NAME = 'read_team_messages';
export const TEAM_ACK_TOOL_NAME = 'ack_team_messages';

export interface TeamMcpDeps {
  post(input: { body: string; contentType?: string }): Promise<unknown>;
  read(input: { afterSeq?: number }): Promise<unknown>;
  ack(input: { throughSeq: number }): Promise<unknown>;
}

/** The exact tools this server advertises. The JSON Schema literals are product authority and reach the peer verbatim. */
export const TEAM_TOOLS: readonly McpServerToolDefinition[] = [
  { name: TEAM_POST_TOOL_NAME, description: 'Post one broadcast message as this exact leased team member. Sender and workspace are daemon-owned.', inputSchema: { type: 'object', additionalProperties: false, required: ['body'], properties: { body: { type: 'string' }, contentType: { type: 'string' } } } },
  { name: TEAM_READ_TOOL_NAME, description: 'Read ordered team messages visible to this exact leased member.', inputSchema: { type: 'object', additionalProperties: false, properties: { afterSeq: { type: 'integer', minimum: 0 } } } },
  { name: TEAM_ACK_TOOL_NAME, description: 'Durably acknowledge messages through an already delivered sequence for this exact leased member.', inputSchema: { type: 'object', additionalProperties: false, required: ['throughSeq'], properties: { throughSeq: { type: 'integer', minimum: 0 } } } },
];

const SERVER_INFO = { name: 'byok-agent-team-mcp', version: '0.0.1' };

const invalid = (message: string): McpServerToolError => new McpServerToolError(-32602, message);
const success = (value: unknown): Record<string, unknown> => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

/**
 * One `tools/call`, returning the JSON-RPC `result` payload. Sender and
 * workspace identity are never model parameters, and that refusal stays here;
 * envelope, framing and protocol faults belong to `../mcp-server`.
 */
export async function handleTeamToolCall(call: McpServerToolCall, deps: TeamMcpDeps): Promise<Record<string, unknown>> {
  const args = call.arguments;
  if (args === undefined) throw invalid('team tool input must be an object');
  try {
    if (call.name === TEAM_POST_TOOL_NAME) {
      if (Object.keys(args).some((key) => key !== 'body' && key !== 'contentType') || typeof args.body !== 'string' || (args.contentType !== undefined && typeof args.contentType !== 'string')) throw invalid('post_team_message accepts body and optional contentType only');
      return success(await deps.post({ body: args.body, ...(typeof args.contentType === 'string' ? { contentType: args.contentType } : {}) }));
    }
    if (call.name === TEAM_READ_TOOL_NAME) {
      if (Object.keys(args).some((key) => key !== 'afterSeq') || (args.afterSeq !== undefined && (!Number.isSafeInteger(args.afterSeq) || Number(args.afterSeq) < 0))) throw invalid('read_team_messages accepts optional non-negative integer afterSeq only');
      return success(await deps.read(args.afterSeq === undefined ? {} : { afterSeq: Number(args.afterSeq) }));
    }
    if (call.name === TEAM_ACK_TOOL_NAME) {
      if (Object.keys(args).some((key) => key !== 'throughSeq') || !Number.isSafeInteger(args.throughSeq) || Number(args.throughSeq) < 0) throw invalid('ack_team_messages requires non-negative integer throughSeq only');
      return success(await deps.ack({ throughSeq: Number(args.throughSeq) }));
    }
    throw invalid('unknown team tool');
  } catch (error) {
    if (error instanceof McpServerToolError) throw error;
    throw new McpServerToolError(-32000, error instanceof Error ? error.message : String(error));
  }
}

export function serveTeamMcpOverStdio(input: { deps: TeamMcpDeps; stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream }): void {
  serveMcpOverStdio({
    serverInfo: SERVER_INFO,
    tools: TEAM_TOOLS,
    callTool: (call) => handleTeamToolCall(call, input.deps),
    input: input.stdin,
    output: input.stdout,
  });
}
