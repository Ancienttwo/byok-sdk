import { AGENT_RESULT_TOOL_NAME } from '../sdk-reserved-mcp';
import {
  McpServerToolError,
  serveMcpOverStdio,
  type McpServerToolCall,
  type McpServerToolDefinition,
} from '../mcp-server';
import type { AgentResultDescribeResult, AgentResultSubmitResult } from '../daemon/control-protocol';

/**
 * The daemon side of the result helper. Both calls go over the authenticated
 * control socket under the helper's per-task context token; the helper holds
 * no schema, no validator and no task identity of its own.
 */
export interface AgentResultMcpDeps {
  describe(): Promise<AgentResultDescribeResult>;
  submit(outcome: Readonly<Record<string, unknown>>): Promise<AgentResultSubmitResult>;
}

const SERVER_INFO = { name: 'byok-agent-result-mcp', version: '0.0.1' };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The one advertised tool, from the daemon's describe answer. Only the shape
 * of the answer is checked here: the schema itself is the offer's frozen
 * authority and reaches the peer verbatim.
 */
export function agentResultToolDefinition(described: unknown): McpServerToolDefinition {
  if (!isPlainRecord(described) || described.name !== AGENT_RESULT_TOOL_NAME
    || typeof described.description !== 'string' || !isPlainRecord(described.inputSchema)) {
    throw new Error('daemon answered agent_results.describe with an invalid tool description');
  }
  return { name: AGENT_RESULT_TOOL_NAME, description: described.description, inputSchema: described.inputSchema };
}

/**
 * One `tools/call`. The raw arguments are forwarded unchanged; the daemon
 * validates them against the frozen schema. A rejection is a tool RESULT with
 * `isError: true` carrying the bounded issues, so the model can correct and
 * submit again; a daemon refusal or transport fault is a JSON-RPC error.
 */
export async function handleAgentResultToolCall(
  call: McpServerToolCall,
  deps: AgentResultMcpDeps,
): Promise<Record<string, unknown>> {
  if (call.name !== AGENT_RESULT_TOOL_NAME) throw new McpServerToolError(-32602, 'unknown Agent result tool');
  if (call.arguments === undefined) throw new McpServerToolError(-32602, 'submit_result requires an arguments object');
  let response: AgentResultSubmitResult;
  try {
    response = await deps.submit(call.arguments);
  } catch (error) {
    throw new McpServerToolError(-32000, error instanceof Error ? error.message : String(error));
  }
  if (response.state === 'staged') {
    return { content: [{ type: 'text', text: JSON.stringify({ receiptId: response.receiptId, state: 'staged' }) }] };
  }
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ error: 'result_rejected', reason: response.reason, issues: response.issues, truncated: response.truncated }),
    }],
    isError: true,
  };
}

/**
 * Fetch the tool description first, then serve. Stdin stays unread until the
 * server attaches, so an early `initialize` waits in the pipe rather than
 * meeting a server with no tool list.
 */
export async function serveAgentResultMcpOverStdio(input: {
  deps: AgentResultMcpDeps;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
}): Promise<void> {
  const tool = agentResultToolDefinition(await input.deps.describe());
  serveMcpOverStdio({
    serverInfo: SERVER_INFO,
    tools: [tool],
    callTool: (call) => handleAgentResultToolCall(call, input.deps),
    input: input.stdin,
    output: input.stdout,
  });
}
