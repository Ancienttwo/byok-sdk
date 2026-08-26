import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAgentMemorySecureFilesystemAvailable } from './agent-memory';

export interface ResolvedAgentMemoryMcpBin { readonly command: string; readonly args: readonly string[]; }
/** Resolve the SDK-owned stdio Agent-memory MCP helper shipped beside the client bundle. */
export function resolveAgentMemoryMcpBin(externalHelperConfigured = false): ResolvedAgentMemoryMcpBin | undefined {
  if (!isAgentMemorySecureFilesystemAvailable(externalHelperConfigured)) return undefined;
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'byok-agent-memory-mcp.js');
  return Object.freeze({ command: process.execPath, args: Object.freeze([script]) });
}
