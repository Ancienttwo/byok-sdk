import { isReservedMcpServerName, SDK_RESERVED_MCP_TOOL_NAMES } from '../../sdk-reserved-mcp.js';
import { RuntimeExecutionFailure } from '../../runtime-failure.js';
import { compareSemver } from '../../runtime/oar-version-floors.js';
import { codexVersionToken } from './codex-version.js';

type JsonRecord = Record<string, unknown>;

// OpenAI Codex #5367 first shipped enabled_tools in 0.48.0.
export const CODEX_MCP_TOOL_ALLOWLIST_MINIMUM = '0.48.0';
export const CODEX_MCP_TOOL_ALLOWLIST_REFUSAL = `codex_mcp_tool_allowlist_unsupported: task MCP tools require Codex CLI ${CODEX_MCP_TOOL_ALLOWLIST_MINIMUM} or later`;

export function supportsCodexMcpToolAllowlist(version: string | undefined): boolean {
  if (version === undefined) return false;
  const order = compareSemver(codexVersionToken(version), CODEX_MCP_TOOL_ALLOWLIST_MINIMUM);
  return order !== null && order >= 0;
}

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
        phase: 'start', retry: 'non-retryable',
        reason: `codex Host MCP approval must name an injected non-reserved server: ${name}`,
      });
    }
  }
  if (taskServers.length === 0) return params;
  const grants = new Map([...helpers, ...hosts]);
  // OAR produces these tables from the injected server definitions.
  const config = params.config as { mcp_servers?: Record<string, JsonRecord> } | undefined;
  const servers = { ...config?.mcp_servers };
  for (const name of taskServers) {
    const tools = grants.get(name) ?? [];
    const server = Object.hasOwn(servers, name) ? servers[name] : undefined;
    if (server === undefined) {
      throw new RuntimeExecutionFailure({
        phase: 'start', retry: 'non-retryable',
        reason: `codex thread config omitted injected MCP server: ${name}`,
      });
    }
    const configuredTools = server.tools as Record<string, JsonRecord> | undefined;
    servers[name] = {
      ...server,
      enabled_tools: [...tools],
      ...(tools.length === 0 ? {} : { tools: {
        ...configuredTools,
        ...Object.fromEntries(tools.map(tool => [tool, { ...configuredTools?.[tool], approval_mode: 'approve' }])),
      } }),
    };
  }
  return { ...params, config: { ...config, mcp_servers: servers } };
}
