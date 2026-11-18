import type { AgentEvent } from '@byok-sdk/protocol';
import { SDK_RESERVED_MCP_TOOL_NAMES } from '../sdk-reserved-mcp.js';
import type { McpToolsetToolObservation } from '../types.js';
import { projectMcpTools, qualifiedMcpToolName } from './projection.js';

export type McpEventIdentity = NonNullable<Extract<AgentEvent, { type: 'tool_use' }>['mcp']>;
export type McpEventIdentities = ReadonlyMap<string, McpEventIdentity>;

/** Exact admitted names, never split an arbitrary runtime label (names may contain __). */
export function mcpEventIdentities(observation: McpToolsetToolObservation = {}, servers: Readonly<Record<string, unknown>> = {}): McpEventIdentities {
  const identities = new Map(projectMcpTools(observation).map(tool => [
    qualifiedMcpToolName(tool.serverName, tool.toolName),
    Object.freeze({ server: tool.serverName, tool: tool.toolName }),
  ]));
  for (const [server, tools] of Object.entries(SDK_RESERVED_MCP_TOOL_NAMES)) {
    if (servers[server] !== undefined) for (const tool of tools) identities.set(tool, Object.freeze({ server, tool }));
  }
  return identities;
}
