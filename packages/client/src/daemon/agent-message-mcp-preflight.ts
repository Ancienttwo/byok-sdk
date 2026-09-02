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
 * listed its tools" means, nor on which environment the probed child receives.
 * Only the reserved-tool assertion is local. The `helper` label keeps every
 * message on this path prefixed the way it always was; the wording of a probe
 * failure (a timeout, a failed spawn, an ungrantable name) is now the shared
 * module's, not a byte-for-byte copy of the pre-extraction local text.
 */
export async function preflightAgentMessageMcp(
  server: Readonly<McpStdioServerConfig>,
  env: Readonly<Record<string, string>>,
  cwd?: string,
  timeoutMs = AGENT_MESSAGE_MCP_PREFLIGHT_TIMEOUT_MS,
): Promise<void> {
  const tools = await probeMcpServerTools(server, {
    label: 'helper',
    timeoutMs,
    env,
    ...(cwd === undefined ? {} : { cwd }),
  });
  if (!tools.includes(AGENT_MESSAGE_TOOL_NAME)) {
    throw new Error(`helper tools/list omitted ${AGENT_MESSAGE_TOOL_NAME}`);
  }
}
