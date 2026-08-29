/** SDK-owned names shared by daemon injection, adapter policy, and MCP helpers. */
export const AGENT_MESSAGE_MCP_SERVER_NAME = 'byokagentmessage';
export const AGENT_MESSAGE_TOOL_NAME = 'send_agent_message';
export const AGENT_MEMORY_MCP_SERVER_NAME = 'byokagentmemory';
/** The MCP server NAME the claude adapter registers `byok-approval-mcp` under in its generated `--mcp-config` — combined with `APPROVAL_TOOL_NAME` (single-sourced from `bin/approval-mcp-server.ts`) to form the `mcp__<server>__<tool>` identifier `--permission-prompt-tool` expects. Lives here, beside the other reserved names, so `toolset-registry.ts`'s host-config rejection and the adapters' own "never treat a reserved server as a projected toolset server" rule read from one list. */
export const APPROVAL_MCP_SERVER_NAME = 'byokapproval';

/**
 * Every MCP server name the SDK owns. A server under one of these names is
 * never a projected host toolset server: `toolset-registry.ts` refuses to
 * configure one, and the adapters grant each reserved server exactly the
 * fixed tool its own protocol needs rather than anything observed.
 *
 * A frozen tuple rather than a `Set`: `Object.freeze` on a `Set` freezes the
 * object's own properties and leaves `add`/`delete` fully functional, so the
 * previous shape advertised an immutability it did not have. Three entries
 * make `includes` the same cost as a hash lookup, and the array really is
 * immutable. Use {@link isReservedMcpServerName} rather than reaching for
 * membership directly.
 */
export const RESERVED_MCP_SERVER_NAMES = Object.freeze([
  AGENT_MESSAGE_MCP_SERVER_NAME,
  AGENT_MEMORY_MCP_SERVER_NAME,
  APPROVAL_MCP_SERVER_NAME,
] as const) satisfies readonly string[];

/** Whether `name` is one of the SDK-owned MCP server names above. */
export function isReservedMcpServerName(name: string): boolean {
  return (RESERVED_MCP_SERVER_NAMES as readonly string[]).includes(name);
}
