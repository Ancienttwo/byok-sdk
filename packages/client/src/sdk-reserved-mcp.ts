/** SDK-owned names shared by daemon injection, adapter policy, and MCP helpers. */
export const AGENT_MESSAGE_MCP_SERVER_NAME = 'byokagentmessage';
export const AGENT_MESSAGE_TOOL_NAME = 'send_agent_message';
export const AGENT_MEMORY_MCP_SERVER_NAME = 'byokagentmemory';
export const AGENT_MEMORY_RECALL_TOOL_NAME = 'memory_recall';
export const AGENT_MEMORY_SAVE_TOOL_NAME = 'memory_save';
export const AGENT_TEAM_MCP_SERVER_NAME = 'byokagentteam';
export const TEAM_POST_TOOL_NAME = 'post_team_message';
export const TEAM_READ_TOOL_NAME = 'read_team_messages';
export const TEAM_ACK_TOOL_NAME = 'ack_team_messages';
/** The structured outcome channel of a `terminalProjection.mode: 'result-document'` offer (wire v3). */
export const AGENT_RESULT_MCP_SERVER_NAME = 'byokagentresult';
/** Its one tool; the `inputSchema` it advertises is the offer's frozen result schema. */
export const AGENT_RESULT_TOOL_NAME = 'submit_result';
export const AGENT_RESULT_TOOL_DESCRIPTION = 'Submit the structured outcome required by this execution. A staged receipt confirms durable storage, not execution success.';

/**
 * Every MCP server name the SDK owns. A server under one of these names is
 * never a projected host toolset server: `toolset-registry.ts` refuses to
 * configure one, and the adapters grant each reserved server exactly the
 * fixed tool its own protocol needs rather than anything observed.
 *
 * A frozen tuple rather than a `Set`: `Object.freeze` on a `Set` freezes the
 * object's own properties and leaves `add`/`delete` fully functional, so the
 * previous shape advertised an immutability it did not have. Four entries
 * make `includes` the same cost as a hash lookup, and the array really is
 * immutable. Use {@link isReservedMcpServerName} rather than reaching for
 * membership directly.
 */
export const RESERVED_MCP_SERVER_NAMES = Object.freeze([
  AGENT_MESSAGE_MCP_SERVER_NAME,
  AGENT_MEMORY_MCP_SERVER_NAME,
  AGENT_TEAM_MCP_SERVER_NAME,
  AGENT_RESULT_MCP_SERVER_NAME,
] as const) satisfies readonly string[];

/** Whether `name` is one of the SDK-owned MCP server names above. */
export function isReservedMcpServerName(name: string): boolean {
  return (RESERVED_MCP_SERVER_NAMES as readonly string[]).includes(name);
}

/** Fixed helper protocols; runtime-discovered or host tool names cannot grant themselves approval. */
export const SDK_RESERVED_MCP_TOOL_NAMES = Object.freeze({
  [AGENT_MESSAGE_MCP_SERVER_NAME]: Object.freeze([AGENT_MESSAGE_TOOL_NAME]),
  [AGENT_MEMORY_MCP_SERVER_NAME]: Object.freeze([AGENT_MEMORY_RECALL_TOOL_NAME, AGENT_MEMORY_SAVE_TOOL_NAME]),
  [AGENT_TEAM_MCP_SERVER_NAME]: Object.freeze([TEAM_POST_TOOL_NAME, TEAM_READ_TOOL_NAME, TEAM_ACK_TOOL_NAME]),
  [AGENT_RESULT_MCP_SERVER_NAME]: Object.freeze([AGENT_RESULT_TOOL_NAME]),
});
