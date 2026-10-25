import { RuntimeExecutionFailure } from '../../runtime-failure';

type JsonRecord = Record<string, unknown>;
/** One request on the session's own app-server client. */
export type CodexAppServerRequest = (method: string, params: JsonRecord) => Promise<JsonRecord>;

const refuse = (reason: string) => new RuntimeExecutionFailure({ phase: 'start', category: 'authority', retry: 'non-retryable', reason });
const record = (value: unknown): JsonRecord | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined;
/** A cursor that never ends is a broken reply, not an inventory. */
const MAX_STATUS_PAGES = 64;

/**
 * Adds the `excluded` overrides to a `thread/start` or `thread/resume` request.
 *
 * `effective` is Codex's `config/read` answer for the task cwd. Every
 * `mcp_servers` entry there that is not a task server gets `enabled = false`,
 * and the `apps` (connectors) and `plugins` features are turned off; plugin
 * servers are not listed in `mcp_servers`. A user entry named like a task
 * server would be merged into it field by field, keeping the user's `env`,
 * `cwd` and tool filters, so it refuses the start instead.
 */
export function withCodexUserContextExcluded(params: JsonRecord, effective: JsonRecord, taskServers: readonly string[]): JsonRecord {
  const configured = effective.config === undefined ? undefined : record(effective.config);
  const servers = configured?.mcp_servers === undefined || configured.mcp_servers === null ? {} : record(configured.mcp_servers);
  if (configured === undefined || servers === undefined) throw refuse('codex Agent user-context exclusion refused: config/read returned no readable configuration');
  const names = Object.keys(servers);
  const shared = names.filter(name => taskServers.includes(name)).sort();
  if (shared.length > 0) throw refuse(`codex Agent user-context exclusion refused: user MCP servers share a name with task servers: ${shared.join(', ')}`);
  const config = record(params.config) ?? {};
  return {
    ...params,
    config: {
      ...config,
      mcp_servers: { ...Object.fromEntries(names.map(name => [name, { enabled: false }])), ...record(config.mcp_servers) },
      features: { ...record(config.features), apps: false, plugins: false },
    },
  };
}

/**
 * Reads the opened thread's MCP servers back (`mcpServerStatus/list` with the
 * thread id reuses its connections and starts nothing) and refuses the start
 * when a server outside the task is not disabled.
 */
export async function verifyCodexUserContextExcluded(request: CodexAppServerRequest, threadId: string, taskServers: readonly string[]): Promise<void> {
  const leaks: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_STATUS_PAGES; page++) {
    const reply = await request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', ...(cursor === undefined ? {} : { cursor }) });
    if (!Array.isArray(reply.data)) throw refuse('codex Agent user-context exclusion refused: mcpServerStatus/list returned no server list');
    for (const entry of reply.data) {
      const server = record(entry);
      if (typeof server?.name !== 'string') throw refuse('codex Agent user-context exclusion refused: mcpServerStatus/list returned a server without a name');
      if (taskServers.includes(server.name) || server.runtimeStatus === 'disabled') continue;
      leaks.push(typeof server.pluginId === 'string' ? `${server.name} (plugin ${server.pluginId})` : server.name);
    }
    if (reply.nextCursor === undefined || reply.nextCursor === null) {
      if (leaks.length > 0) throw refuse(`codex Agent thread still runs MCP servers outside the task: ${leaks.sort().join(', ')}`);
      return;
    }
    if (typeof reply.nextCursor !== 'string') throw refuse('codex Agent user-context exclusion refused: mcpServerStatus/list returned an invalid cursor');
    cursor = reply.nextCursor;
  }
  throw refuse('codex Agent user-context exclusion refused: mcpServerStatus/list did not finish paging');
}
