import { isReservedMcpServerName } from '../../sdk-reserved-mcp';
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
 * that server's `tools/list`. Only `configuredServers` (the servers the SDK
 * wrote into `--mcp-config`) receive an identity, and only when Claude reports
 * the same command and args: a same-named server from the user's own
 * configuration is not the task's server. Every other reported server still
 * counts for collisions: a runtime name two reported tools share is ambiguous
 * and gets no identity. A malformed response yields no identities. Under
 * `agentUserContext: 'excluded'` an Agent task's Claude reports no user servers.
 */
export function claudeMcpEventIdentities(
  response: unknown,
  configuredServers: ReadonlyMap<string, McpStdioServerConfig>,
): McpEventIdentities {
  const servers = (response as { mcpServers?: unknown } | undefined)?.mcpServers;
  if (!Array.isArray(servers)) return new Map();
  const byName = new Map<string, McpEventIdentity | null>();
  for (const server of servers as { name?: unknown; tools?: unknown; config?: unknown }[]) {
    if (typeof server?.name !== 'string' || server.name.length === 0 || !Array.isArray(server.tools)) continue;
    const configured = isConfiguredServer(server.config, configuredServers.get(server.name));
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

/**
 * One runtime observation shared by the first authorization hook and event
 * reporting. The gate resolves every SDK-written server, so a Host MCP rule
 * cannot lock out the SDK helpers by leaving them without identity. Events
 * carry only the task toolset servers: whether helper calls carry `mcp` is an
 * open owner decision (#633).
 */
export function createClaudeMcpIdentityResolver(
  status: () => Promise<unknown>,
  configuredServers: ReadonlyMap<string, McpStdioServerConfig>,
) {
  const authorized = new Map<string, McpEventIdentity>();
  const identities = new Map<string, McpEventIdentity>();
  const hasToolsetServers = [...configuredServers.keys()].some(name => !isReservedMcpServerName(name));
  let pending: Promise<void> | undefined;
  const observe = (): Promise<void> => {
    pending ??= status().then(response => {
      for (const [name, identity] of claudeMcpEventIdentities(response, configuredServers)) {
        authorized.set(name, identity);
        if (!isReservedMcpServerName(identity.server)) identities.set(name, identity);
      }
    });
    return pending;
  };
  return {
    identities: identities as McpEventIdentities,
    async resolve(name: string): Promise<McpEventIdentity | undefined> {
      if (configuredServers.size === 0 || !name.startsWith('mcp__')) return undefined;
      await observe();
      return authorized.get(name);
    },
    async observe() {
      if (hasToolsetServers) await observe();
    },
  };
}
