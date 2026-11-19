import type { ToolAuthorizationGate, ToolCall } from '../tool-authorization.js';
import { qualifiedMcpToolName } from './projection.js';
import { readMcpHubCatalog, snapshotHubBinding, type McpHubCatalogBinding } from './hub/catalog.js';
import { HUB_CALL_TOOL, MCP_HUB_SERVER_NAME, parseHubCall } from './hub/protocol.js';

// The standalone classifier is also loaded directly by Node's type stripper.
// Share the private brand with it without adding a runtime import to that module.
const HUB_GATE_MARKER = Symbol.for('byok.tool-authorization.mcp-hub');

export interface McpHubGateAuthority {
  readonly outerToolName: string;
  readonly isActive: () => boolean;
  resolve(call: ToolCall, outer: ToolCall['mcp']): Promise<ToolCall | undefined>;
}

/** Bind only when the daemon installs the SDK hub on this Attempt's auto gate. */
export function bindMcpHubAuthorization(
  gate: ToolAuthorizationGate,
  options: { readonly catalog: McpHubCatalogBinding; readonly isActive: () => boolean },
): void {
  const catalog = snapshotHubBinding(options.catalog);
  const isActive = options.isActive;
  const authority: McpHubGateAuthority = Object.freeze({
    outerToolName: qualifiedMcpToolName(MCP_HUB_SERVER_NAME, HUB_CALL_TOOL),
    isActive,
    async resolve(call: ToolCall, outer: ToolCall['mcp']) {
      if (outer?.server !== MCP_HUB_SERVER_NAME || outer.tool !== HUB_CALL_TOOL || !isActive()) return undefined;
      const inner = parseHubCall(call.input);
      if (inner === undefined) return undefined;
      const frozen = await readMcpHubCatalog(catalog);
      if (frozen?.get(inner.server)?.tools.some(tool => tool.name === inner.tool) !== true || !isActive()) return undefined;
      return {
        ...call,
        cwd: catalog.launchCwd,
        toolName: qualifiedMcpToolName(inner.server, inner.tool),
        input: inner.arguments,
        mcp: { server: inner.server, tool: inner.tool },
      };
    },
  });
  Object.defineProperty(gate.authorize, HUB_GATE_MARKER, { value: authority });
}
