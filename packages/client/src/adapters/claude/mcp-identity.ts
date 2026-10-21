import type { McpEventIdentities, McpEventIdentity } from '../../mcp/event-identity';

/**
 * Claude's own runtime name part for an MCP server or tool name. Observed in
 * the installed Claude Code 2.1.302 binary and confirmed live against it with
 * no credentials: server `market.feed` with tool `get.quote` is reported in
 * `system/init.tools` as `mcp__market_feed__get_quote`. Servers named
 * `claude.ai …` also collapse and trim underscores.
 */
function claudeNamePart(name: string): string {
  const part = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  return name.startsWith('claude.ai ') ? part.replace(/_+/g, '_').replace(/^_|_$/g, '') : part;
}

/**
 * MCP identities from Claude's own `mcp_status` control response: every
 * connected server Claude reports, with the original tool names it read from
 * that server's `tools/list`. Only `toolsetServers` (the task-projected toolset
 * servers the SDK wrote into `--mcp-config`) receive an identity. Every other
 * reported server (the user's own configuration, SDK-reserved helpers) still
 * counts for collisions: a runtime name two reported tools share is ambiguous
 * and gets no identity. A malformed response yields no identities.
 */
export function claudeMcpEventIdentities(response: unknown, toolsetServers: ReadonlySet<string>): McpEventIdentities {
  const servers = (response as { mcpServers?: unknown } | undefined)?.mcpServers;
  if (!Array.isArray(servers)) return new Map();
  const byName = new Map<string, McpEventIdentity | null>();
  for (const server of servers as { name?: unknown; tools?: unknown }[]) {
    if (typeof server?.name !== 'string' || server.name.length === 0 || !Array.isArray(server.tools)) continue;
    for (const tool of server.tools as { name?: unknown }[]) {
      if (typeof tool?.name !== 'string' || tool.name.length === 0) continue;
      const name = `mcp__${claudeNamePart(server.name)}__${claudeNamePart(tool.name)}`;
      byName.set(name, byName.has(name) || !toolsetServers.has(server.name)
        ? null
        : Object.freeze({ server: server.name, tool: tool.name }));
    }
  }
  return new Map([...byName].filter((entry): entry is [string, McpEventIdentity] => entry[1] !== null));
}
