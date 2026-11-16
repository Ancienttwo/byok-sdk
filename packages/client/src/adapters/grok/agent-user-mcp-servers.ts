import { objectRecord as record } from '../shared-rules.js';

const PREFIX = 'grok Agent user MCP server exclusion refused';
/** The refusal when inspect fails or prints output this check cannot read. */
export const GROK_INSPECT_FAILED = `${PREFIX}: grok inspect failed`;

/** Grok's per-process switches for the Claude and Cursor MCP compatibility cells and the managed MCP fetch. */
export const GROK_USER_MCP_SERVERS_OFF = Object.freeze({
  GROK_CLAUDE_MCPS_ENABLED: '0', GROK_CURSOR_MCPS_ENABLED: '0', GROK_MANAGED_MCPS_ENABLED: '0',
});

/**
 * Why `grok inspect --json` output leaves MCP servers outside the task, or
 * `undefined` when it lists none. Inspect reports discovery: a listed server
 * that is not `disabled` may load, and a plugin shows only how many servers
 * it provides. Output it cannot read refuses too.
 */
export function grokInspectRefusal(output: string): string | undefined {
  let parsed: Record<string, unknown> | undefined;
  try { parsed = record(JSON.parse(output)); } catch { parsed = undefined; }
  const failed = GROK_INSPECT_FAILED;
  if (!parsed || !Array.isArray(parsed.mcpServers) || !Array.isArray(parsed.plugins)) return failed;
  const servers: string[] = [];
  for (const entry of parsed.mcpServers) {
    const server = record(entry);
    if (typeof server?.name !== 'string') return failed;
    if (server.disabled === true) continue;
    const source = record(server.source)?.type;
    servers.push(typeof source === 'string' ? `${server.name} (${source})` : server.name);
  }
  const plugins: string[] = [];
  for (const entry of parsed.plugins) {
    const plugin = record(entry);
    const provided = record(plugin?.provides)?.mcpServers;
    if (typeof plugin?.name !== 'string' || typeof provided !== 'number') return failed;
    if (plugin.enabled !== false && provided > 0) plugins.push(plugin.name);
  }
  const found = [
    ...(servers.length === 0 ? [] : [`Grok still loads MCP servers outside the task: ${servers.sort().join(', ')}`]),
    ...(plugins.length === 0 ? [] : [`enabled plugins provide MCP servers: ${plugins.sort().join(', ')}`]),
  ];
  return found.length === 0 ? undefined : `${PREFIX}: ${found.join('; ')}`;
}
