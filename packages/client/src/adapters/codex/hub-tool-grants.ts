import type { McpStdioServerConfig, RuntimeOperationStartInput } from '../../types.js';
import { RuntimeExecutionFailure } from '../../runtime-failure.js';
import { readMcpHubCatalog, snapshotHubBinding, type McpHubCatalogBinding } from '../../mcp/hub/catalog.js';
import { MCP_HUB_SERVER_NAME, type McpHubCall } from '../../mcp/hub/protocol.js';

// The startup owner copies the input to attach its signal. Attempt scratch
// preserves identity across that copy and is replaced for the next Attempt.
const installations = new WeakSet<RuntimeOperationStartInput['scratch']>();

/** The daemon supplies the exact helper it installed on this start input. */
export function bindCodexMcpHubInstallation(input: RuntimeOperationStartInput, helper: McpStdioServerConfig): void {
  if (input.kind !== 'instruction' || input.mcpServers?.[MCP_HUB_SERVER_NAME] !== helper) {
    throw new Error('Codex MCP hub binding requires the SDK-installed helper on an instruction start');
  }
  installations.add(input.scratch);
}

export function assertCodexMcpHubQualified(input: RuntimeOperationStartInput): void {
  if (installations.has(input.scratch)) {
    throw new RuntimeExecutionFailure({
      phase: 'start', retry: 'non-retryable', reason: 'Codex MCP hub tool approval is not qualified',
    });
  }
}

/** Candidate hub policy for Codex. Only an exact frozen grant may reach dispatch. */
export function createCodexMcpHubCallPolicy(
  binding: McpHubCatalogBinding,
  approvals: Readonly<Record<string, readonly string[]>>,
): (call: McpHubCall, signal: AbortSignal) => Promise<boolean> {
  const catalogBinding = snapshotHubBinding(binding);
  const grants = new Map(Object.entries(approvals).map(([server, tools]) => [server, new Set(tools)]));
  return async ({ server, tool }, signal) => {
    if (signal.aborted || grants.get(server)?.has(tool) !== true) return false;
    const catalog = await readMcpHubCatalog(catalogBinding);
    return !signal.aborted && catalog?.get(server)?.tools.some(descriptor => descriptor.name === tool) === true;
  };
}
