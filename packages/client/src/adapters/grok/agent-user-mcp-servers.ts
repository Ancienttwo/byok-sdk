import { spawn } from 'node:child_process';

const INSPECT_TIMEOUT_MS = 5000;
const INSPECT_MAX_BYTES = 16 * 1024 * 1024;
const PREFIX = 'grok Agent user MCP server exclusion refused';
const INSPECT_FAILED = `${PREFIX}: grok inspect failed`;

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
  const failed = INSPECT_FAILED;
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

/**
 * Runs `grok inspect --json` through the spawn that starts the agent, with
 * the agent's command, cwd and environment, so it judges the configuration
 * the agent will load. A non-zero exit, a spawn error, more than 16 MiB of
 * output or 5 s without an exit fail it.
 */
export async function grokUserMcpServersRefusal(spawnFn: typeof spawn, command: string, cwd: string, env: Readonly<Record<string, string>>): Promise<string | undefined> {
  const stdout = await new Promise<string | undefined>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(command, ['inspect', '--json'], { cwd, env, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      finish(undefined);
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    timer = setTimeout(() => { child.kill('SIGKILL'); finish(undefined); }, INSPECT_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= INSPECT_MAX_BYTES) chunks.push(chunk);
      else { child.kill('SIGKILL'); finish(undefined); }
    });
    child.on('error', () => finish(undefined));
    child.on('close', (code) => finish(code === 0 ? Buffer.concat(chunks).toString('utf8') : undefined));
  });
  return stdout === undefined ? INSPECT_FAILED : grokInspectRefusal(stdout);
}
