import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ResolvedAgentMessageMcpBin {
  readonly command: string;
  readonly args: readonly string[];
}

/** Resolve the SDK-owned stdio MCP helper shipped beside the client bundle. */
export function resolveAgentMessageMcpBin(): ResolvedAgentMessageMcpBin {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'byok-agent-message-mcp.js');
  return Object.freeze({ command: process.execPath, args: Object.freeze([script]) });
}
