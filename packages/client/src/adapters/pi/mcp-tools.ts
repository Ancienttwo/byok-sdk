import type { CallToolResult } from '@modelcontextprotocol/client';
import { qualifiedMcpToolName, type McpToolProjection } from '../../mcp/projection';

/**
 * Turn the runtime-agnostic MCP projection into Pi tool definitions.
 *
 * Shared on purpose: the ordinary extension (`./mcp-extension.ts`) and the
 * prepared launch entry both build their tool list from here, so "the prepared
 * session sees the same tools as the ordinary session" is a property of one
 * function rather than an agreement between two.
 *
 * One Pi tool per MCP tool, carrying the server's real schema. The retired
 * `pi-mcp-adapter` registered a single `mcp` proxy instead, which had two
 * consequences this replaces: the model never saw a toolset's schemas in its
 * first request (they arrived only after a discovery call), and one proxy tool
 * spanning read and mutation tools made every toolset task indivisible for
 * permission purposes.
 */

/** The subset of a Pi `ToolDefinition` this module produces. */
export interface PiMcpToolDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  /** The server's own JSON Schema, verbatim. */
  readonly parameters: unknown;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ): Promise<{
    content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>;
    details: PiMcpToolDetails;
  }>;
}

export interface PiMcpToolDetails {
  readonly toolsetId: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly isError: boolean;
}

/** How a registered Pi tool reaches its MCP server. */
export interface McpToolCallHost {
  call(
    tool: McpToolProjection,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<CallToolResult>;
}

const MAX_PROMPT_SNIPPET_CHARS = 100;

/** First sentence-ish fragment of the description, for Pi's tool index line. */
function promptSnippet(tool: McpToolProjection): string {
  const description = tool.description.replace(/\s+/gu, ' ').trim();
  if (description.length === 0) return `MCP tool ${tool.toolName} from ${tool.serverName}`;
  if (description.length <= MAX_PROMPT_SNIPPET_CHARS) return description;
  const clipped = description.slice(0, MAX_PROMPT_SNIPPET_CHARS);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

/**
 * Render one MCP result into Pi's content vocabulary.
 *
 * Text and image blocks cross unchanged. Every other block kind — embedded
 * resources, resource links, audio — is reported as the kind it is, with
 * whatever identifier it carried. Nothing is summarized, fetched, or
 * materialized to disk: this SDK is not the authority on what a resource
 * contains, and inventing a rendering would put words the server never said in
 * front of the model.
 */
function renderContent(
  result: CallToolResult,
): Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> {
  const blocks: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [];
  for (const block of result.content ?? []) {
    if (block.type === 'text') {
      blocks.push({ type: 'text', text: block.text });
      continue;
    }
    if (block.type === 'image') {
      blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType });
      continue;
    }
    const uri = (block as { uri?: unknown; resource?: { uri?: unknown } }).uri
      ?? (block as { resource?: { uri?: unknown } }).resource?.uri;
    blocks.push({
      type: 'text',
      text: `[MCP returned a ${block.type} block${typeof uri === 'string' ? ` for ${uri}` : ''}]`,
    });
  }
  if (result.structuredContent !== undefined) {
    blocks.push({ type: 'text', text: JSON.stringify(result.structuredContent) });
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '[MCP returned no content]' });
  return blocks;
}

/**
 * How a tool is named to the model.
 *
 * - `qualified` (`mcp__<server>__<tool>`) for HOST toolset servers. Both the
 *   server name and the tool name are host input, so they are namespaced per
 *   server: two toolsets may legitimately expose a `search`, and the qualified
 *   form is also the grant vocabulary claude and codex interpolate.
 * - `bare` for SDK-RESERVED helpers. Their tool names are fixed by protocols
 *   this SDK owns and are referenced verbatim in the prompts the relays send
 *   and in `docs/spec.md`; renaming them here would silently break every
 *   instruction that names them.
 */
export type PiMcpToolNaming = 'qualified' | 'bare';

/**
 * Build one Pi tool per projected MCP tool, in the projection's canonical
 * order.
 *
 * The order is preserved end to end: the caller registers them in this
 * sequence, which is the sequence the model is shown and the sequence a frozen
 * tool manifest binds.
 */
export function createPiMcpTools(
  tools: readonly McpToolProjection[],
  host: McpToolCallHost,
  naming: PiMcpToolNaming = 'qualified',
): readonly PiMcpToolDefinition[] {
  return Object.freeze(tools.map((tool) => ({
    name: naming === 'bare' ? tool.toolName : qualifiedMcpToolName(tool.serverName, tool.toolName),
    label: `MCP: ${tool.toolName}`,
    // The server's own description, never a rewritten one. It is part of what
    // a frozen observation binds, so editing it here would make the registered
    // tool differ from the tool that was observed and digested.
    description: tool.description.length > 0 ? tool.description : `MCP tool ${tool.toolName} from ${tool.serverName}`,
    promptSnippet: promptSnippet(tool),
    parameters: tool.inputSchema,
    async execute(_toolCallId: string, params: unknown, signal: AbortSignal | undefined) {
      const args = params === null || typeof params !== 'object' || Array.isArray(params)
        ? {}
        : params as Record<string, unknown>;
      const result = await host.call(tool, args, signal);
      return {
        content: renderContent(result),
        details: Object.freeze({
          toolsetId: tool.toolsetId,
          serverName: tool.serverName,
          toolName: tool.toolName,
          isError: result.isError === true,
        }),
      };
    },
  })));
}
