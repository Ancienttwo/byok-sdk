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
 */
export const RESERVED_MCP_SERVER_NAMES: ReadonlySet<string> = Object.freeze(new Set([
  AGENT_MESSAGE_MCP_SERVER_NAME,
  AGENT_MEMORY_MCP_SERVER_NAME,
  APPROVAL_MCP_SERVER_NAME,
])) as ReadonlySet<string>;
