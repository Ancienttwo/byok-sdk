import { resolveSdkReservedHelperBin, type SdkHelperHostConfig } from '../sdk-reserved-helper-host';

export interface ResolvedAgentMessageMcpBin {
  readonly command: string;
  readonly args: readonly string[];
}

/** Resolve the SDK-owned stdio MCP helper shipped beside the client bundle. */
export function resolveAgentMessageMcpBin(host?: SdkHelperHostConfig): ResolvedAgentMessageMcpBin {
  const resolved = resolveSdkReservedHelperBin('agent-message-mcp', host);
  return Object.freeze({ command: resolved.command, args: resolved.args });
}
