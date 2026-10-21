import type { AgentEvent } from '@byok-sdk/protocol';
import type { McpToolsetToolObservation } from '../types';
import { projectMcpTools, qualifiedMcpToolName } from './projection';

export type McpEventIdentity = NonNullable<Extract<AgentEvent, { type: 'tool_use' }>['mcp']>;
export type McpEventIdentities = ReadonlyMap<string, McpEventIdentity>;

/** Exact admitted names, never split an arbitrary runtime label (names may contain __). */
export function mcpEventIdentities(observation: McpToolsetToolObservation = {}): McpEventIdentities {
  return new Map(projectMcpTools(observation).map(tool => [
    qualifiedMcpToolName(tool.serverName, tool.toolName),
    Object.freeze({ server: tool.serverName, tool: tool.toolName }),
  ]));
}
