import type { McpStdioServerConfig } from '../types';
import { AGENT_RESULT_MCP_SERVER_NAME, AGENT_RESULT_TOOL_NAME } from '../sdk-reserved-mcp';
import { probeMcpServerTools } from './mcp-tools-probe';

export const AGENT_RESULT_MCP_PREFLIGHT_TIMEOUT_MS = 10_000;

/**
 * Prove the exact configured result helper starts, reaches this daemon's
 * `agent_results.describe` under its task token, and advertises
 * `submit_result` before a runtime process is created. Same handshake as the
 * message helper preflight (`agent-message-mcp-preflight.ts`); no
 * `tools/call` is sent.
 */
export async function preflightAgentResultMcp(
  server: Readonly<McpStdioServerConfig>,
  env: Readonly<Record<string, string>>,
  timeoutMs = AGENT_RESULT_MCP_PREFLIGHT_TIMEOUT_MS,
): Promise<void> {
  const tools = await probeMcpServerTools(AGENT_RESULT_MCP_SERVER_NAME, server, { label: 'result helper', timeoutMs, env });
  if (!tools.includes(AGENT_RESULT_TOOL_NAME)) {
    throw new Error(`result helper tools/list omitted ${AGENT_RESULT_TOOL_NAME}`);
  }
}
