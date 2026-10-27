import { isReservedMcpServerName, SDK_RESERVED_MCP_TOOL_NAMES } from '../../sdk-reserved-mcp';
import { RuntimeExecutionFailure } from '../../runtime-failure';

type JsonRecord = Record<string, unknown>;

/** Fixed helper authority and the attempt's local Host declaration are disjoint server namespaces. */
export function withCodexMcpToolGrants(
  params: JsonRecord,
  taskServers: readonly string[],
  hostApprovals: Readonly<Record<string, readonly string[]>> = {},
): JsonRecord {
  const helpers = Object.entries(SDK_RESERVED_MCP_TOOL_NAMES).filter(([name]) => taskServers.includes(name));
  const hosts = Object.entries(hostApprovals);
  for (const [name] of hosts) {
    if (isReservedMcpServerName(name) || !taskServers.includes(name)) {
      throw new RuntimeExecutionFailure({
        phase: 'start', category: 'authority', retry: 'non-retryable',
        reason: `codex Host MCP approval must name an injected non-reserved server: ${name}`,
      });
    }
  }
  const grants = [...helpers, ...hosts.filter(([, tools]) => tools.length > 0)];
  if (grants.length === 0) return params;
  // These tables are produced by OAR's codexThreadOpen, rather than supplied by a remote task.
  const config = params.config as { mcp_servers?: Record<string, JsonRecord> } | undefined;
  const servers = { ...config?.mcp_servers };
  for (const [name, tools] of grants) {
    const server = servers[name];
    if (server === undefined) {
      throw new RuntimeExecutionFailure({
        phase: 'start', category: 'authority', retry: 'non-retryable',
        reason: `codex thread config omitted injected MCP server: ${name}`,
      });
    }
    const configuredTools = server.tools as Record<string, JsonRecord> | undefined;
    servers[name] = {
      ...server,
      tools: {
        ...configuredTools,
        ...Object.fromEntries(tools.map(tool => [tool, { ...configuredTools?.[tool], approval_mode: 'approve' }])),
      },
    };
  }
  return { ...params, config: { ...config, mcp_servers: servers } };
}
