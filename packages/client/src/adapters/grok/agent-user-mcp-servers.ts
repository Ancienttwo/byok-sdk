import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const INSPECT_TIMEOUT_MS = 5000;
const INSPECT_MAX_BYTES = 16 * 1024 * 1024;
const PREFIX = 'grok Agent user MCP server exclusion refused';

/** Grok's per-process switches for the Claude and Cursor MCP compatibility cells and the managed MCP fetch. */
export const GROK_USER_MCP_SERVERS_OFF = Object.freeze({
  GROK_CLAUDE_MCPS_ENABLED: '0', GROK_CURSOR_MCPS_ENABLED: '0', GROK_MANAGED_MCPS_ENABLED: '0',
});

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/**
 * Why `grok inspect --json` output leaves MCP servers outside the task, or
 * `undefined` when it lists none. Inspect reports discovery: a listed server
 * that is not `disabled` may load, and a plugin shows only how many servers
 * it provides. Output it cannot read refuses too.
 */
export function grokInspectRefusal(output: string): string | undefined {
  let parsed: Record<string, unknown> | undefined;
  try { parsed = record(JSON.parse(output)); } catch { parsed = undefined; }
  const failed = `${PREFIX}: grok inspect failed`;
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

/** Runs `grok inspect --json` with the agent's cwd and environment and judges its output. */
export async function grokUserMcpServersRefusal(command: string, cwd: string, env: Readonly<Record<string, string>>): Promise<string | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(command, ['inspect', '--json'], {
      cwd, env, timeout: INSPECT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: INSPECT_MAX_BYTES,
    }));
  } catch {
    return `${PREFIX}: grok inspect failed`;
  }
  return grokInspectRefusal(stdout);
}
