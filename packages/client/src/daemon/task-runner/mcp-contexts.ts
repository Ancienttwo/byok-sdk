// `TaskRunner` members that add the SDK-owned MCP servers and their context
// tokens to a task (see ./support.ts for how a member module runs).
import { randomUUID } from 'node:crypto';
import type { AgentMessageEgressRequirement, TerminalProjectionSelection } from '@byok-sdk/protocol';
import type { McpStdioServerConfig } from '../../types';
import type { AgentRef } from '../../agent-home';
import { AGENT_MEMORY_MCP_SERVER_NAME, AGENT_MESSAGE_MCP_SERVER_NAME, AGENT_RESULT_MCP_SERVER_NAME } from '../../sdk-reserved-mcp';
import type { AgentResultContext } from './support';
import { freshHostToolsetContextToken } from './support';
import type { TaskRunner } from '../task-runner';
import { HOST_TOOLSET_CONTEXT_ENV } from '../task-runner';

export function withAgentMessageMcp(
  this: TaskRunner,
  existing: Readonly<Record<string, McpStdioServerConfig>> | undefined,
  taskId: string,
  requirement: Readonly<AgentMessageEgressRequirement> | undefined,
): Readonly<Record<string, McpStdioServerConfig>> | undefined {
  if (requirement === undefined) return existing;
  const bin = this['deps'].agentMessageMcpBin!;
  const contextToken = `${randomUUID()}.${randomUUID()}`;
  this['revokeAgentMessageContext'](taskId);
  this['messageContextByToken'].set(contextToken, taskId);
  this['messageContextByTask'].set(taskId, contextToken);
  return Object.freeze({
    ...(existing ?? {}),
    [AGENT_MESSAGE_MCP_SERVER_NAME]: Object.freeze({
      command: bin.command,
      args: Object.freeze([...bin.args]),
      env: Object.freeze({
        BYOK_STORE_DIR: this['deps'].storeDir,
        BYOK_PRODUCT_ID: this['deps'].productId,
        BYOK_AGENT_MESSAGE_CONTEXT: contextToken,
      }),
    }),
  });
}

export function withAgentResultMcp(
  this: TaskRunner,
  existing: Readonly<Record<string, McpStdioServerConfig>> | undefined,
  taskId: string,
  selection: Readonly<TerminalProjectionSelection> | undefined,
): Readonly<Record<string, McpStdioServerConfig>> | undefined {
  if (selection?.mode !== 'result-document') return existing;
  const bin = this['deps'].agentResultMcpBin!;
  const contextToken = `${randomUUID()}.${randomUUID()}`;
  this['revokeAgentResultContext'](taskId);
  const context: AgentResultContext = { taskId, token: contextToken, contract: selection.contract, schema: selection.schema };
  this['resultContextByToken'].set(contextToken, context);
  this['resultContextByTask'].set(taskId, context);
  return Object.freeze({
    ...(existing ?? {}),
    [AGENT_RESULT_MCP_SERVER_NAME]: Object.freeze({
      command: bin.command,
      args: Object.freeze([...bin.args]),
      env: Object.freeze({
        BYOK_STORE_DIR: this['deps'].storeDir,
        BYOK_PRODUCT_ID: this['deps'].productId,
        BYOK_AGENT_RESULT_CONTEXT: contextToken,
      }),
    }),
  });
}

export function withAgentMemoryMcp(
  this: TaskRunner,
  existing: Readonly<Record<string, McpStdioServerConfig>> | undefined,
  taskId: string,
  agentRef: AgentRef,
  mode: 'read' | 'read-write',
  bin: {command: string; args: readonly string[]},
  toolList: 'granted' | 'complete',
): Readonly<Record<string, McpStdioServerConfig>> {
  if (existing !== undefined && Object.prototype.hasOwnProperty.call(existing, AGENT_MEMORY_MCP_SERVER_NAME)) {
    throw new Error(`MCP server name "${AGENT_MEMORY_MCP_SERVER_NAME}" is reserved by the daemon`);
  }
  const contextToken = `${randomUUID()}.${randomUUID()}`;
  this['revokeAgentMemoryContext'](taskId);
  this['memoryContextByToken'].set(contextToken, Object.freeze({ taskId, agentRef: Object.freeze({ ...agentRef }), mode }));
  this['memoryContextByTask'].set(taskId, contextToken);
  return Object.freeze({
    ...(existing ?? {}),
    [AGENT_MEMORY_MCP_SERVER_NAME]: Object.freeze({
      command: bin.command,
      args: Object.freeze([...bin.args]),
      env: Object.freeze({
        BYOK_STORE_DIR: this['deps'].storeDir,
        BYOK_PRODUCT_ID: this['deps'].productId,
        BYOK_AGENT_MEMORY_CONTEXT: contextToken,
        BYOK_PREPARED_AGENT_MEMORY_MODE: mode,
        ...(toolList === 'granted' ? { BYOK_AGENT_MEMORY_TOOL_LIST: 'granted' } : {}),
      }),
    }),
  });
}

export function withHostToolsetContext(
  this: TaskRunner,
  servers: Readonly<Record<string, McpStdioServerConfig>>,
  taskId: string,
  agentRef: AgentRef,
  toolsetIdByServer: ReadonlyMap<string, string>,
): Readonly<Record<string, McpStdioServerConfig>> {
  // §8.1's capability gate, asked before anything is minted. An undeclared
  // lane gets no nonce at all — not a weaker one, and not a device
  // assertion's identity wearing a task's name. The MCP child then fails
  // explicitly for want of a token (§8.2(1)), which is the visible outcome
  // §8.3 asks for when a device or a deployment cannot serve this lane.
  if (this['deps'].hostTaskContextAvailable?.() !== true) return servers;
  // A re-offer of the same taskId must not leave the previous attempt's
  // nonces mintable: the old child is gone, so its tokens are authority
  // nobody holds any more.
  this['deleteHostToolsetContexts'](taskId);
  const frozenAgentRef = Object.freeze({ ...agentRef });
  const tokens = new Set<string>();
  const injected: Record<string, McpStdioServerConfig> = {};
  for (const [serverName, server] of Object.entries(servers)) {
    const toolsetId = toolsetIdByServer.get(serverName);
    // A server with no owning toolset would mean the resolution above lost
    // the binding; minting a nonce for it would produce a claim no frozen
    // offer can confirm, so it simply gets no task lane.
    if (toolsetId === undefined) {
      injected[serverName] = server;
      continue;
    }
    const contextToken = freshHostToolsetContextToken();
    this['hostToolsetContextByToken'].set(contextToken, {
      taskId,
      agentRef: frozenAgentRef,
      toolsetId,
      serverName,
      state: 'active',
    });
    tokens.add(contextToken);
    injected[serverName] = Object.freeze({
      ...server,
      env: Object.freeze({
        BYOK_STORE_DIR: this['deps'].storeDir,
        BYOK_PRODUCT_ID: this['deps'].productId,
        [HOST_TOOLSET_CONTEXT_ENV]: contextToken,
      }),
    });
  }
  if (tokens.size > 0) this['hostToolsetContextTokensByTask'].set(taskId, tokens);
  return Object.freeze(injected);
}

export function resolveMcpServers(
  this: TaskRunner,
  requiredToolsets: readonly string[],
):
  | {
      ok: true;
      servers: Readonly<Record<string, McpStdioServerConfig>>;
      toolsetIdByServer: ReadonlyMap<string, string>;
      mcpToolApprovals?: Readonly<Record<string, readonly string[]>>;
    }
  | { ok: false; reason: string } {
  const registry = this['deps'].getMcpToolsets?.();
  if (!registry || registry.size === 0) {
    return { ok: false, reason: 'offer requires MCP toolsets, but this device has no local mcpToolsets registry' };
  }
  const servers = Object.create(null) as Record<string, McpStdioServerConfig>;
  const toolsetIdByServer = new Map<string, string>();
  const approvals: Record<string, readonly string[]> = Object.create(null);
  for (const toolsetId of requiredToolsets) {
    const toolset = registry.get(toolsetId);
    if (!toolset) {
      return { ok: false, reason: `required MCP toolset "${toolsetId}" is not configured on this device` };
    }
    for (const [serverName, server] of Object.entries(toolset.mcpServers)) {
      if (Object.prototype.hasOwnProperty.call(servers, serverName)) {
        return {
          ok: false,
          reason: `required MCP toolsets collide on server name "${serverName}"; refusing ambiguous projection`,
        };
      }
      servers[serverName] = Object.freeze({
        command: server.command,
        ...(server.args ? { args: Object.freeze([...server.args]) } : {}),
      });
      if (server.approveTools?.length) approvals[serverName] = Object.freeze([...server.approveTools]);
      toolsetIdByServer.set(serverName, toolsetId);
    }
  }
  if (Object.keys(servers).length === 0) {
    return { ok: false, reason: 'required MCP toolsets resolved to no servers; refusing to run without tools' };
  }
  return { ok: true, servers: Object.freeze(servers), toolsetIdByServer,
    ...(Object.keys(approvals).length > 0 ? { mcpToolApprovals: Object.freeze(approvals) } : {}),
  };
}
