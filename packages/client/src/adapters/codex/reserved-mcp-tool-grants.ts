import { SDK_RESERVED_MCP_TOOL_NAMES } from '../../sdk-reserved-mcp';
import { RuntimeExecutionFailure } from '../../runtime-failure';

type JsonRecord = Record<string, unknown>;

/** Grant only the fixed tools of SDK helpers injected into this operation, on start and resume. */
export function withCodexReservedMcpToolGrants(params: JsonRecord, taskServers: readonly string[]): JsonRecord {
  const helpers = Object.entries(SDK_RESERVED_MCP_TOOL_NAMES).filter(([name]) => taskServers.includes(name));
  if (helpers.length === 0) return params;
  // These tables are produced by OAR's codexThreadOpen, rather than supplied by a remote task.
  const config = params.config as { mcp_servers?: Record<string, JsonRecord> } | undefined;
  const servers = { ...config?.mcp_servers };
  for (const [name, tools] of helpers) {
    const server = servers[name];
    if (server === undefined) {
      throw new RuntimeExecutionFailure({
        phase: 'start', category: 'authority', retry: 'non-retryable',
        reason: `codex thread config omitted injected SDK MCP helper: ${name}`,
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
