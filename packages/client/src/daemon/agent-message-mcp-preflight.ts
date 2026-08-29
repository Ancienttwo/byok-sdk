import { spawn } from 'node:child_process';
import type { McpStdioServerConfig } from '../types';
import { AGENT_MESSAGE_TOOL_NAME } from '../bin/agent-message-mcp-server';

export const AGENT_MESSAGE_MCP_PREFLIGHT_TIMEOUT_MS = 3_000;

/**
 * Prove the exact configured helper can start and expose the reserved message
 * tool before a runtime process is created. No tools/call is sent, so the
 * authenticated task binding remains unused until the real runtime invokes it.
 */
export async function preflightAgentMessageMcp(
  server: Readonly<McpStdioServerConfig>,
  timeoutMs = AGENT_MESSAGE_MCP_PREFLIGHT_TIMEOUT_MS,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(server.command, [...(server.args ?? [])], {
      env: { ...process.env, ...(server.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (error) reject(error);
      else resolve();
    };
    const inspect = (): void => {
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        let response: unknown;
        try { response = JSON.parse(line); } catch { continue; }
        if (response === null || typeof response !== 'object' || Array.isArray(response)) continue;
        const record = response as { id?: unknown; result?: { tools?: unknown } };
        if (record.id !== 2 || !Array.isArray(record.result?.tools)) continue;
        if (record.result.tools.some((tool) => (
          tool !== null && typeof tool === 'object' && !Array.isArray(tool)
          && (tool as { name?: unknown }).name === AGENT_MESSAGE_TOOL_NAME
        ))) finish();
        else finish(new Error(`helper tools/list omitted ${AGENT_MESSAGE_TOOL_NAME}`));
      }
    };
    const timer = setTimeout(() => {
      finish(new Error(`helper handshake timed out after ${timeoutMs}ms${stderr ? `: ${stderr.trim()}` : ''}`));
    }, timeoutMs);
    timer.unref?.();
    child.once('error', (error) => finish(new Error(`helper failed to start: ${error.message}`)));
    child.once('exit', (code, signal) => {
      if (!settled) finish(new Error(
        `helper exited before handshake (code=${String(code)}, signal=${String(signal)})${stderr ? `: ${stderr.trim()}` : ''}`,
      ));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; inspect(); });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.stdin.on('error', (error) => finish(new Error(`helper stdin failed: ${error.message}`)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
  });
}
