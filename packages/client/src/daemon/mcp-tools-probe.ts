import { spawn } from 'node:child_process';
import type { McpStdioServerConfig } from '../types';

export const MCP_TOOLS_PROBE_TIMEOUT_MS = 10_000;

/**
 * Tool names an adapter is allowed to pre-grant must be OBSERVED, never
 * configured: the daemon's own `mcpToolsets` config carries `command`/`args`
 * only (see `toolset-registry.ts`), so the single authority for "which tools
 * does this server actually expose" is the server's own `tools/list` answer.
 *
 * A name that survives this filter is about to be interpolated into runtime
 * CLI authority — `--allowedTools mcp__<server>__<tool>` for claude, and
 * `mcp_servers.<server>.tools.<tool>.approval_mode` for codex. A comma, a
 * dot, a quote, or whitespace in a tool name would forge additional grants or
 * a different config key out of one legitimate one, so a server that reports
 * such a name is rejected outright rather than partially granted. The shape
 * below is deliberately narrower than MCP's own (unbounded) name rule; the
 * two real servers this SDK ships and every toolset server observed so far
 * satisfy it, and a legitimate server that does not can still be listed and
 * called by a runtime that grants tools itself — it simply cannot be
 * pre-granted here.
 */
const GRANTABLE_TOOL_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/u;

export interface McpToolsProbeOptions {
  /** Prefix used in every error message, so a failure names the thing that failed. */
  label?: string;
  timeoutMs?: number;
}

/**
 * Start the exact configured stdio MCP server, complete an
 * `initialize` + `tools/list` handshake, and return the reported tool names.
 * No `tools/call` is ever sent, so an authenticated task binding stays unused
 * until the real runtime invokes it.
 *
 * The child is always killed before this resolves — the probe proves the
 * server can start and enumerate its tools; the runtime spawns its own copy.
 */
export async function probeMcpServerTools(
  server: Readonly<McpStdioServerConfig>,
  options: McpToolsProbeOptions = {},
): Promise<readonly string[]> {
  const label = options.label ?? 'MCP server';
  const timeoutMs = options.timeoutMs ?? MCP_TOOLS_PROBE_TIMEOUT_MS;
  return new Promise<readonly string[]>((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(server.command, [...(server.args ?? [])], {
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (error?: Error, tools?: readonly string[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve(tools ?? []);
    };
    const inspect = (): void => {
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        let response: unknown;
        try { response = JSON.parse(line); } catch { continue; }
        if (response === null || typeof response !== 'object' || Array.isArray(response)) continue;
        const record = response as { id?: unknown; result?: { tools?: unknown } };
        if (record.id !== 2 || !Array.isArray(record.result?.tools)) continue;
        const names: string[] = [];
        for (const tool of record.result.tools) {
          if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) {
            finish(new Error(`${label} tools/list returned a malformed tool entry`));
            return;
          }
          const name = (tool as { name?: unknown }).name;
          if (typeof name !== 'string' || !GRANTABLE_TOOL_NAME.test(name)) {
            finish(new Error(`${label} tools/list reported an ungrantable tool name ${JSON.stringify(name)}`));
            return;
          }
          names.push(name);
        }
        finish(undefined, Object.freeze([...new Set(names)].sort()));
        return;
      }
    };
    const timer = setTimeout(() => {
      finish(new Error(`${label} handshake timed out after ${timeoutMs}ms${stderr ? `: ${stderr.trim()}` : ''}`));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => finish(new Error(`${label} failed to start: ${error.message}`)));
    child.once('exit', (code, signal) => {
      if (!settled) finish(new Error(
        `${label} exited before handshake (code=${String(code)}, signal=${String(signal)})${stderr ? `: ${stderr.trim()}` : ''}`,
      ));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; inspect(); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.stdin.on('error', (error) => finish(new Error(`${label} stdin failed: ${error.message}`)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  });
}
