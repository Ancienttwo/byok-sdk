import type { McpEventIdentities, McpEventIdentity } from '../../mcp/event-identity';
import type { McpStdioServerConfig } from '../../types';

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

/** Whether Claude reports the server with the command and args the SDK wrote for it. */
function isConfiguredServer(reported: unknown, configured: McpStdioServerConfig | undefined): boolean {
  const config = reported as { command?: unknown; args?: unknown } | undefined;
  const args = configured?.args ?? [];
  return configured !== undefined && config?.command === configured.command && Array.isArray(config.args)
    && config.args.length === args.length && config.args.every((arg, index) => arg === args[index]);
}

/**
 * MCP identities from Claude's own `mcp_status` control response: every
 * connected server Claude reports, with the original tool names it read from
 * that server's `tools/list`. Only `toolsetServers` (the task-projected toolset
 * servers the SDK wrote into `--mcp-config`) receive an identity, and only when
 * Claude reports the same command and args: a same-named server from the
 * user's own configuration is not the task's server. Every other reported
 * server (the user's own configuration, SDK-reserved helpers) still counts for
 * collisions: a runtime name two reported tools share is ambiguous and gets no
 * identity. A malformed response yields no identities. Under
 * `agentUserContext: 'excluded'` an Agent task's Claude reports no user servers.
 */
export function claudeMcpEventIdentities(
  response: unknown,
  toolsetServers: ReadonlyMap<string, McpStdioServerConfig>,
): McpEventIdentities {
  const servers = (response as { mcpServers?: unknown } | undefined)?.mcpServers;
  if (!Array.isArray(servers)) return new Map();
  const byName = new Map<string, McpEventIdentity | null>();
  for (const server of servers as { name?: unknown; tools?: unknown; config?: unknown }[]) {
    if (typeof server?.name !== 'string' || server.name.length === 0 || !Array.isArray(server.tools)) continue;
    const configured = isConfiguredServer(server.config, toolsetServers.get(server.name));
    for (const tool of server.tools as { name?: unknown }[]) {
      if (typeof tool?.name !== 'string' || tool.name.length === 0) continue;
      const name = `mcp__${claudeNamePart(server.name)}__${claudeNamePart(tool.name)}`;
      byName.set(name, byName.has(name) || !configured
        ? null
        : Object.freeze({ server: server.name, tool: tool.name }));
    }
  }
  return new Map([...byName].filter((entry): entry is [string, McpEventIdentity] => entry[1] !== null));
}

/** One runtime observation shared by the first authorization hook and event reporting. */
export function createClaudeMcpIdentityResolver(
  status: () => Promise<unknown>,
  toolsetServers: ReadonlyMap<string, McpStdioServerConfig>,
) {
  const identities = new Map<string, McpEventIdentity>();
  let pending: Promise<void> | undefined;
  const observe = (): Promise<void> => {
    pending ??= status().then(response => {
      for (const [name, identity] of claudeMcpEventIdentities(response, toolsetServers)) identities.set(name, identity);
    });
    return pending;
  };
  return {
    identities: identities as McpEventIdentities,
    async resolve(name: string): Promise<McpEventIdentity | undefined> {
      if (toolsetServers.size === 0 || !name.startsWith('mcp__')) return undefined;
      await observe();
      return identities.get(name);
    },
    async observe() {
      if (toolsetServers.size > 0) await observe();
    },
  };
}
