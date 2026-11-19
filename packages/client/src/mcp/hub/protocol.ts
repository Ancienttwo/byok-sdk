import type { McpServerToolDefinition } from '../../mcp-server/index.js';
import { GRANTABLE_MCP_SERVER_NAME, GRANTABLE_TOOL_NAME } from '../observation.js';

export const MCP_HUB_SERVER_NAME = 'byoktools';
export const MCP_HUB_SERVER_INFO = Object.freeze({ name: MCP_HUB_SERVER_NAME, version: '1' });
export const HUB_SEARCH_TOOL = 'tool_search';
export const HUB_CALL_TOOL = 'call_tool';
const MAX_QUERY_LENGTH = 256;

export const MCP_HUB_TOOLS: readonly McpServerToolDefinition[] = [
  {
    name: HUB_SEARCH_TOOL,
    description: 'Find tools by name or description. Include English keywords for the action and object. Returns exact server and tool names and their input schemas.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object', properties: { query: { type: 'string', maxLength: MAX_QUERY_LENGTH } },
      required: ['query'], additionalProperties: false,
    },
  },
  {
    name: HUB_CALL_TOOL,
    description: 'Call a tool from the search catalog using its exact server and tool names and an arguments object matching its input schema.',
    inputSchema: {
      type: 'object',
      properties: {
        server: { type: 'string', pattern: GRANTABLE_MCP_SERVER_NAME.source },
        tool: { type: 'string', pattern: GRANTABLE_TOOL_NAME.source },
        arguments: { type: 'object' },
      },
      required: ['server', 'tool', 'arguments'], additionalProperties: false,
    },
  },
];

export interface McpHubCall {
  readonly server: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

type JsonValue = null | string | boolean | number | readonly JsonValue[] | JsonObject;
interface JsonObject { readonly [key: string]: JsonValue }

function copyJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(copyJson));
  if (!isJsonObject(value)) throw new TypeError('MCP arguments must be JSON values');
  // JSON Schema required-property checks must only see properties that were sent.
  const copy: Record<string, JsonValue> = Object.create(null);
  for (const [key, child] of Object.entries(value)) copy[key] = copyJson(child);
  return Object.freeze(copy);
}

export function parseHubCall(input: unknown): McpHubCall | undefined {
  if (!isJsonObject(input) || Object.keys(input).length !== 3
    || !Object.hasOwn(input, 'server') || !Object.hasOwn(input, 'tool') || !Object.hasOwn(input, 'arguments')) {
    return undefined;
  }
  const { server, tool, arguments: args } = input;
  if (typeof server !== 'string' || !GRANTABLE_MCP_SERVER_NAME.test(server)
    || typeof tool !== 'string' || !GRANTABLE_TOOL_NAME.test(tool) || !isJsonObject(args)) {
    return undefined;
  }
  try {
    return { server, tool, arguments: copyJson(args) as Readonly<Record<string, unknown>> };
  } catch {
    return undefined;
  }
}

export function parseHubQuery(input: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (input === undefined || Object.keys(input).length !== 1 || !Object.hasOwn(input, 'query')) return undefined;
  const { query } = input;
  if (typeof query !== 'string' || [...query].length > MAX_QUERY_LENGTH) return undefined;
  return query;
}

export function hubText(text: string, isError = false): Record<string, unknown> {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}
