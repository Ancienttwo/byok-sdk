import { objectRecord as record } from '../shared-rules.js';
import { RuntimeExecutionFailure } from '../../runtime-failure.js';
import type { CodexOpenStepRequest } from '../../runtime/codex-session-runtime.js';

type JsonRecord = Record<string, unknown>;

const refuse = (reason: string) => new RuntimeExecutionFailure({ phase: 'start', retry: 'non-retryable', reason });
const PREFIX = 'codex Agent user MCP server exclusion refused';
const UNREADABLE_STATUS = `${PREFIX}: mcpServerStatus/list returned a reply it cannot read`;
/** A cursor that never ends is a broken reply, not an inventory. */
const MAX_STATUS_PAGES = 64;

/**
 * Adds the `excluded` overrides to a `thread/start` or `thread/resume` request.
 *
 * Each name comes from `config/read` for the task cwd after the collision
 * check. Apps and plugins are disabled here because their servers can come
 * from outside `mcp_servers`. Preserve other overrides in the open request.
 */
export function withCodexUserMcpServersExcluded(params: JsonRecord, userServerNames: readonly string[]): JsonRecord {
  const config = record(params.config) ?? {};
  const opened = record(config.mcp_servers) ?? {};
  return {
    ...params,
    config: {
      ...config,
      mcp_servers: { ...opened, ...Object.fromEntries(userServerNames.map(name => [name, { ...record(opened[name]), enabled: false }])) },
      features: { ...record(config.features), apps: false, plugins: false },
    },
  };
}

/** Refuse names that Codex would merge with a task's injected server configuration. */
export function codexUserMcpServerNames(effective: JsonRecord, taskServers: readonly string[]): string[] {
  const configured = record(effective.config);
  const servers = configured?.mcp_servers === undefined || configured.mcp_servers === null ? {} : record(configured.mcp_servers);
  if (configured === undefined || servers === undefined) throw refuse('codex_mcp_config_unavailable: config/read returned no readable configuration');
  const names = Object.keys(servers);
  const shared = names.filter(name => taskServers.includes(name)).sort();
  if (shared.length > 0) {
    throw refuse(`codex_mcp_server_name_collision: user MCP servers share a name with task servers: ${shared.join(', ')}. Rename either server and try again.`);
  }
  return names;
}

/**
 * Reads the opened thread's MCP servers back (`mcpServerStatus/list` with the
 * thread id reuses its connections and starts nothing) and refuses the start
 * when a server outside the task is not disabled.
 */
export async function verifyCodexUserMcpServersExcluded(request: CodexOpenStepRequest, threadId: string, taskServers: readonly string[]): Promise<void> {
  const leaks: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_STATUS_PAGES; page++) {
    const reply = await request('mcpServerStatus/list', { threadId, detail: 'toolsAndAuthOnly', ...(cursor === undefined ? {} : { cursor }) });
    if (!Array.isArray(reply.data)) throw refuse(UNREADABLE_STATUS);
    for (const entry of reply.data) {
      const server = record(entry);
      if (typeof server?.name !== 'string') throw refuse(UNREADABLE_STATUS);
      const plugin = server.pluginId ?? undefined;
      if (plugin !== undefined && typeof plugin !== 'string') throw refuse(UNREADABLE_STATUS);
      // A plugin server may carry a task server's name; only a configured server is the task's.
      if ((plugin === undefined && taskServers.includes(server.name)) || server.runtimeStatus === 'disabled') continue;
      leaks.push(plugin === undefined ? server.name : `${server.name} (plugin ${plugin})`);
    }
    if (reply.nextCursor === undefined || reply.nextCursor === null) {
      if (leaks.length > 0) throw refuse(`codex Agent thread still runs MCP servers outside the task: ${leaks.sort().join(', ')}`);
      return;
    }
    if (typeof reply.nextCursor !== 'string') throw refuse(UNREADABLE_STATUS);
    cursor = reply.nextCursor;
  }
  throw refuse(UNREADABLE_STATUS);
}
