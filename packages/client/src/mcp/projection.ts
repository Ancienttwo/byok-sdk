import { compareCodeUnits } from '../util/compare-code-units';
import { McpAuthorityError, type McpStdioServerSpec } from './client';
import {
  GRANTABLE_MCP_SERVER_NAME,
  type McpServerObservation,
  type McpToolsetServerObservation,
} from './observation';

/**
 * One model-visible MCP tool, in vocabulary no runtime owns.
 *
 * This is the single shape both consumers project from: the ordinary Pi
 * extension turns it into a registered Pi tool, and the prepared launch entry
 * turns it into a frozen native tool plus its executor identity. Neither
 * re-derives anything from a server — if the two could each decide what the
 * tool set is, "the prepared session sees what the ordinary session sees"
 * would be a coincidence rather than a property.
 */
export interface McpToolProjection {
  readonly toolsetId: string;
  readonly serverName: string;
  readonly toolName: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

/**
 * The name one MCP tool is known by inside a runtime.
 *
 * `mcp__<server>__<tool>` is already the grant vocabulary claude and codex
 * interpolate into their own authority surfaces, so pi registering the same
 * string keeps one name per tool across all three runtimes instead of a
 * per-runtime dialect. Both halves passed {@link GRANTABLE_MCP_SERVER_NAME} /
 * `GRANTABLE_TOOL_NAME` before reaching here, so the `__` separator cannot be
 * ambiguous: neither half may contain one.
 */
export function qualifiedMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`;
}

/**
 * Order every observed tool into the ONE canonical sequence.
 *
 * `(toolsetId, serverName, toolName)` by UTF-16 code unit — the same ordering
 * `toolset-registry.ts` digests its server list with. Order is load-bearing
 * twice over: it is the order the model is shown the tools in, which feeds the
 * system prompt bytes, and it is the order the frozen tool manifest binds. Two
 * machines that disagreed about it would produce two different prepared
 * digests for the same toolset.
 */
export function projectMcpTools(
  observation: Readonly<Record<string, McpToolsetServerObservation>>,
): readonly McpToolProjection[] {
  const projections: McpToolProjection[] = [];
  for (const [serverName, server] of Object.entries(observation)) {
    if (!GRANTABLE_MCP_SERVER_NAME.test(serverName)) {
      throw new McpAuthorityError(
        `observed MCP server name ${JSON.stringify(serverName)} cannot be expressed as a runtime tool name`,
      );
    }
    for (const tool of server.tools) {
      projections.push(Object.freeze({
        toolsetId: server.toolsetId,
        serverName,
        toolName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    }
  }
  return Object.freeze(projections.sort((left, right) =>
    compareCodeUnits(left.toolsetId, right.toolsetId)
    || compareCodeUnits(left.serverName, right.serverName)
    || compareCodeUnits(left.toolName, right.toolName)));
}

/**
 * The names-only view of one observation, for the runtimes that pre-grant by
 * name.
 *
 * Derived, never stored: the full descriptors are the observation, and a
 * separately-carried name list would be a second authority that could disagree
 * with the schemas the model was actually shown.
 */
export function mcpToolsetToolNames(
  observation: Readonly<Record<string, McpServerObservation>>,
): Readonly<Record<string, readonly string[]>> {
  const names: Record<string, readonly string[]> = {};
  for (const [serverName, server] of Object.entries(observation)) {
    names[serverName] = Object.freeze(server.tools.map((tool) => tool.name).sort(compareCodeUnits));
  }
  return Object.freeze(names);
}

/** The task-scoped authority one Pi launch is handed: what to run, and exactly which tools exist. */
export interface McpLaunchProjection {
  readonly mcpServers: Readonly<Record<string, McpStdioServerSpec>>;
  /** Canonically ordered by {@link projectMcpTools}. */
  readonly tools: readonly McpToolProjection[];
}
