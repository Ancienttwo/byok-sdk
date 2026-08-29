import type { McpStdioServerConfig } from '../types';
import { AGENT_MESSAGE_TOOL_NAME } from '../sdk-reserved-mcp';
import { probeMcpServerTools } from './mcp-tools-probe';

export const AGENT_MESSAGE_MCP_PREFLIGHT_TIMEOUT_MS = 10_000;

/**
 * Prove the exact configured helper can start and expose the reserved message
 * tool before a runtime process is created. No tools/call is sent, so the
 * authenticated task binding remains unused until the real runtime invokes it.
 *
 * The handshake itself is `mcp-tools-probe.ts`'s — the same one that observes
 * a projected toolset server's grantable tool names — so the reserved helper
 * and a host toolset server can never diverge on what "this server started and
 * listed its tools" means. Only the reserved-tool assertion is local, and the
 * `helper` label keeps this path's error text byte-identical to what it was
 * before the handshake moved.
 */
export async function preflightAgentMessageMcp(
  server: Readonly<McpStdioServerConfig>,
  timeoutMs = AGENT_MESSAGE_MCP_PREFLIGHT_TIMEOUT_MS,
): Promise<void> {
  const tools = await probeMcpServerTools(server, { label: 'helper', timeoutMs });
  if (!tools.includes(AGENT_MESSAGE_TOOL_NAME)) {
    throw new Error(`helper tools/list omitted ${AGENT_MESSAGE_TOOL_NAME}`);
  }
}
