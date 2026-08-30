import { createInterface } from 'node:readline';

export const TEAM_POST_TOOL_NAME = 'post_team_message';
export const TEAM_READ_TOOL_NAME = 'read_team_messages';
export const TEAM_ACK_TOOL_NAME = 'ack_team_messages';

export interface TeamMcpDeps {
  post(input: { body: string; contentType?: string }): Promise<unknown>;
  read(input: { afterSeq?: number }): Promise<unknown>;
  ack(input: { throughSeq: number }): Promise<unknown>;
}

interface RequestLike { id?: unknown; method?: unknown; params?: unknown }
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const invalid = (id: unknown, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code: -32602, message } });
const success = (id: unknown, value: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }] } });

export async function handleTeamMcpRequest(request: RequestLike, deps: TeamMcpDeps): Promise<Record<string, unknown> | undefined> {
  const { id } = request;
  if (request.method === 'initialize') {
    const params = record(request.params) ?? {};
    return { jsonrpc: '2.0', id, result: { protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'byok-agent-team-mcp', version: '0.0.1' } } };
  }
  if (request.method === 'notifications/initialized') return undefined;
  if (request.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: [
    { name: TEAM_POST_TOOL_NAME, description: 'Post one broadcast message as this exact leased team member. Sender and workspace are daemon-owned.', inputSchema: { type: 'object', additionalProperties: false, required: ['body'], properties: { body: { type: 'string' }, contentType: { type: 'string' } } } },
    { name: TEAM_READ_TOOL_NAME, description: 'Read ordered team messages visible to this exact leased member.', inputSchema: { type: 'object', additionalProperties: false, properties: { afterSeq: { type: 'integer', minimum: 0 } } } },
    { name: TEAM_ACK_TOOL_NAME, description: 'Durably acknowledge messages through an already delivered sequence for this exact leased member.', inputSchema: { type: 'object', additionalProperties: false, required: ['throughSeq'], properties: { throughSeq: { type: 'integer', minimum: 0 } } } },
  ] } };
  if (request.method !== 'tools/call') return id === undefined ? undefined : { jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${String(request.method)}` } };
  const params = record(request.params); const args = record(params?.arguments);
  if (!params || !args || typeof params.name !== 'string') return invalid(id, 'team tool input must be an object');
  try {
    if (params.name === TEAM_POST_TOOL_NAME) {
      if (Object.keys(args).some((key) => key !== 'body' && key !== 'contentType') || typeof args.body !== 'string' || (args.contentType !== undefined && typeof args.contentType !== 'string')) return invalid(id, 'post_team_message accepts body and optional contentType only');
      return success(id, await deps.post({ body: args.body, ...(typeof args.contentType === 'string' ? { contentType: args.contentType } : {}) }));
    }
    if (params.name === TEAM_READ_TOOL_NAME) {
      if (Object.keys(args).some((key) => key !== 'afterSeq') || (args.afterSeq !== undefined && (!Number.isSafeInteger(args.afterSeq) || Number(args.afterSeq) < 0))) return invalid(id, 'read_team_messages accepts optional non-negative integer afterSeq only');
      return success(id, await deps.read(args.afterSeq === undefined ? {} : { afterSeq: Number(args.afterSeq) }));
    }
    if (params.name === TEAM_ACK_TOOL_NAME) {
      if (Object.keys(args).some((key) => key !== 'throughSeq') || !Number.isSafeInteger(args.throughSeq) || Number(args.throughSeq) < 0) return invalid(id, 'ack_team_messages requires non-negative integer throughSeq only');
      return success(id, await deps.ack({ throughSeq: Number(args.throughSeq) }));
    }
    return invalid(id, 'unknown team tool');
  } catch (error) {
    return { jsonrpc: '2.0', id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
  }
}

export function serveTeamMcpOverStdio(input: { deps: TeamMcpDeps; stdin?: NodeJS.ReadableStream; stdout?: NodeJS.WritableStream }): void {
  const reader = createInterface({ input: input.stdin ?? process.stdin, terminal: false });
  const output = input.stdout ?? process.stdout;
  reader.on('line', (line) => {
    const trimmed = line.trim(); if (!trimmed) return;
    void (async () => {
      let request: RequestLike; try { request = JSON.parse(trimmed) as RequestLike; } catch { return; }
      const response = await handleTeamMcpRequest(request, input.deps);
      if (response !== undefined) output.write(`${JSON.stringify(response)}\n`);
    })();
  });
}
