import { isAgentMemorySecureFilesystemAvailable } from './agent-memory';
import { resolveSdkReservedHelperBin, type SdkHelperHostConfig } from '../sdk-reserved-helper-host';

export interface ResolvedAgentMemoryMcpBin { readonly command: string; readonly args: readonly string[]; }
/** Resolve the SDK-owned stdio Agent-memory MCP helper shipped beside the client bundle. */
export function resolveAgentMemoryMcpBin(
  externalHelperConfigured = false,
  host?: SdkHelperHostConfig,
): ResolvedAgentMemoryMcpBin | undefined {
  if (!isAgentMemorySecureFilesystemAvailable(externalHelperConfigured)) return undefined;
  const resolved = resolveSdkReservedHelperBin('agent-memory-mcp', host);
  return Object.freeze({ command: resolved.command, args: resolved.args });
}

/** Resolve the SDK-owned task-free Agent-memory descriptor helper a preparation observes. */
export function resolveAgentMemoryDescribeBin(
  externalHelperConfigured = false,
  host?: SdkHelperHostConfig,
): ResolvedAgentMemoryMcpBin | undefined {
  if (!isAgentMemorySecureFilesystemAvailable(externalHelperConfigured)) return undefined;
  const resolved = resolveSdkReservedHelperBin('agent-memory-describe', host);
  return Object.freeze({ command: resolved.command, args: resolved.args });
}
