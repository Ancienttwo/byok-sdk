import type { AgentEvent } from '@byok-sdk/protocol';
import type { McpEventIdentity } from './event-identity.js';
import type { ToolCall } from '../tool-authorization.js';
import { readMcpHubCatalog, type McpHubCatalogBinding } from './hub/catalog.js';
import { HUB_CALL_TOOL, MCP_HUB_SERVER_NAME, parseHubCall } from './hub/protocol.js';
import { qualifiedMcpToolName } from './projection.js';

const OUTER_CALL = qualifiedMcpToolName(MCP_HUB_SERVER_NAME, HUB_CALL_TOOL);

type ToolUse = Extract<AgentEvent, { type: 'tool_use' }>;

/** A runtime start frame can identify an attempted call. It carries no server receipt. */
export async function attributeHubAttempt(
  event: ToolUse,
  hub: { readonly binding: McpHubCatalogBinding; readonly isActive: () => boolean; readonly innerAttempts?: true },
): Promise<(ToolCall & { mcp: McpEventIdentity }) | undefined> {
  if (hub.innerAttempts !== true || event.tool !== OUTER_CALL || !event.toolCallId?.trim()
    || event.mcp?.server !== MCP_HUB_SERVER_NAME || event.mcp.tool !== HUB_CALL_TOOL || !hub.isActive()) return;
  const inner = parseHubCall(event.input);
  if (inner === undefined) return;
  // If the catalog is unavailable, corrupt, or belongs to a previous Attempt,
  // the runtime event still has its outer identity.
  const catalog = await readMcpHubCatalog(hub.binding).catch(() => undefined);
  if (catalog?.get(inner.server)?.tools.some(tool => tool.name === inner.tool) !== true || !hub.isActive()) return;
  return {
    toolCallId: event.toolCallId,
    toolName: qualifiedMcpToolName(inner.server, inner.tool),
    cwd: hub.binding.launchCwd,
    input: inner.arguments,
    mcp: { server: inner.server, tool: inner.tool },
  };
}
