import { once } from 'node:events';
import { z } from 'zod';
import { ConnectorBrokerError, type GmailConnectorBroker } from './broker';

export const GMAIL_SEARCH_TOOL_NAME = 'gmail_search_correspondence';
export const MAX_MCP_REQUEST_BYTES = 64 * 1024;

const JsonRpcIdSchema = z.union([
  z.string().min(1).max(160),
  z.number().int().safe(),
  z.null(),
]);

const JsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema.optional(),
    method: z.string().min(1).max(160),
    params: z.unknown().optional(),
  })
  .strict();

type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export type ConnectorMcpResponse =
  | { readonly jsonrpc: '2.0'; readonly id: JsonRpcId; readonly result: unknown }
  | {
      readonly jsonrpc: '2.0';
      readonly id: JsonRpcId;
      readonly error: {
        readonly code: number;
        readonly message: string;
        readonly data?: { readonly brokerCode: string };
      };
    };

function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  brokerCode?: string,
): ConnectorMcpResponse {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(brokerCode ? { data: { brokerCode } } : {}) },
  };
}

/** Handles one MCP JSON-RPC request without exposing process or stdio authority. */
export async function handleConnectorMcpRequest(
  requestValue: unknown,
  broker: GmailConnectorBroker,
): Promise<ConnectorMcpResponse | undefined> {
  const parsed = JsonRpcRequestSchema.safeParse(requestValue);
  if (!parsed.success) return errorResponse(null, -32600, 'invalid JSON-RPC request');
  const request = parsed.data;
  const id = request.id ?? null;

  if (request.method === 'notifications/initialized') return undefined;
  // No-id JSON-RPC notifications must never trigger provider side effects.
  if (request.id === undefined) return undefined;
  if (request.method === 'initialize') {
    const requestedProtocolVersion =
      typeof request.params === 'object' &&
      request.params !== null &&
      'protocolVersion' in request.params &&
      typeof request.params.protocolVersion === 'string' &&
      request.params.protocolVersion.length <= 64
        ? request.params.protocolVersion
        : '2024-11-05';
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requestedProtocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'salesko-connector-broker', version: '1.0.0' },
      },
    };
  }
  if (request.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: [
          {
            name: GMAIL_SEARCH_TOOL_NAME,
            description: 'Search bounded Gmail correspondence metadata for explicitly allowed domains.',
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              required: ['domains'],
              properties: {
                domains: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 16,
                  items: { type: 'string' },
                },
                limit: { type: 'integer', minimum: 1, maximum: 25 },
                newerThanDays: { type: 'integer', minimum: 1, maximum: 365 },
              },
            },
          },
        ],
      },
    };
  }
  if (request.method === 'tools/call') {
    const params = z
      .object({ name: z.literal(GMAIL_SEARCH_TOOL_NAME), arguments: z.unknown() })
      .strict()
      .safeParse(request.params);
    if (!params.success) return errorResponse(id, -32602, 'invalid Gmail connector tool call');
    try {
      const result = await broker.search(params.data.arguments);
      return {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(result) }] },
      };
    } catch (error) {
      if (error instanceof ConnectorBrokerError) {
        return errorResponse(id, -32001, error.message, error.code);
      }
      return errorResponse(id, -32000, 'connector execution failed');
    }
  }

  return request.id === undefined ? undefined : errorResponse(id, -32601, 'method not found');
}

async function writeResponse(output: NodeJS.WritableStream, response: ConnectorMcpResponse): Promise<void> {
  if (output.write(`${JSON.stringify(response)}\n`)) return;
  await once(output, 'drain');
}

type BoundedLine = { readonly kind: 'line'; readonly text: string } | { readonly kind: 'oversized' };

/** Byte-bounded NDJSON framing; an oversized line is discarded through its newline. */
async function* readBoundedLines(input: NodeJS.ReadableStream): AsyncGenerator<BoundedLine> {
  let chunks: Buffer[] = [];
  let bytes = 0;
  let oversized = false;

  function reset(): void {
    chunks = [];
    bytes = 0;
    oversized = false;
  }

  function append(segment: Buffer): void {
    if (oversized || segment.length === 0) return;
    bytes += segment.length;
    if (bytes > MAX_MCP_REQUEST_BYTES) {
      oversized = true;
      chunks = [];
      return;
    }
    chunks.push(segment);
  }

  function decode(): BoundedLine {
    if (oversized) return { kind: 'oversized' };
    let line = Buffer.concat(chunks, bytes);
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    try {
      return { kind: 'line', text: new TextDecoder('utf-8', { fatal: true }).decode(line) };
    } catch {
      return { kind: 'line', text: '' };
    }
  }

  for await (const rawChunk of input) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(String(rawChunk), 'utf8');
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      append(chunk.subarray(start, index));
      yield decode();
      reset();
      start = index + 1;
    }
    append(chunk.subarray(start));
  }
  if (oversized || bytes > 0) yield decode();
}

/** Sequential, bounded NDJSON stdio transport for the local connector MCP. */
export async function serveConnectorMcp(
  broker: GmailConnectorBroker,
  streams: {
    readonly input?: NodeJS.ReadableStream;
    readonly output?: NodeJS.WritableStream;
  } = {},
): Promise<void> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  for await (const line of readBoundedLines(input)) {
    if (line.kind === 'oversized') {
      await writeResponse(output, errorResponse(null, -32600, 'JSON-RPC request exceeds the byte limit'));
      continue;
    }
    let request: unknown;
    try {
      request = JSON.parse(line.text);
    } catch {
      await writeResponse(output, errorResponse(null, -32700, 'invalid JSON'));
      continue;
    }
    const response = await handleConnectorMcpRequest(request, broker);
    if (response) await writeResponse(output, response);
  }
}
