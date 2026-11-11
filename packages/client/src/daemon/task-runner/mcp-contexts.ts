// `TaskRunner` members that add the SDK-owned MCP servers and their context
// tokens to a task (see ./support.ts for how a member module runs).
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentMessageEgressRequirement, TerminalProjectionSelection } from '@byok-sdk/protocol';
import type { McpStdioServerConfig } from '../../types.js';
import type { AgentRef } from '../../agent-home.js';
import { AGENT_MEMORY_MCP_SERVER_NAME, AGENT_MESSAGE_MCP_SERVER_NAME, AGENT_RESULT_MCP_SERVER_NAME } from '../../sdk-reserved-mcp.js';
import type { AgentMemoryMcpContext, SdkReservedMcpContext } from '../../sdk-reserved-helper-context.js';
import { atomicWriteFile } from '../../util/atomic-write.js';
import type { ExecutionScratch } from '../retention/scratch.js';
import type { AgentResultContext } from './support.js';
import { freshHostToolsetContextToken } from './support.js';
import type { TaskRunner } from '../task-runner.js';

/**
 * One server's context, in the Execution's SDK directory: private to this user
 * on POSIX by mode, on Windows by the scratch root's inherited ACL. Releasing
 * the scratch at task disposal removes it. A mid-task revocation leaves it,
 * because a runtime that restarts the server must still reach the refusal of
 * the revoked token and not a failed server start.
 */
async function writeMcpContextFile(file: string, context: SdkReservedMcpContext): Promise<string> {
  await atomicWriteFile(file, JSON.stringify(context), { mode: 0o600 });
  return file;
}

function mcpContextFile(scratch: ExecutionScratch, name: string): string {
  return path.join(scratch.sdkDir, `${name}-context.json`);
}

export async function withAgentMessageMcp(
  this: TaskRunner,
  existing: Readonly<Record<string, McpStdioServerConfig>> | undefined,
  taskId: string,
  requirement: Readonly<AgentMessageEgressRequirement> | undefined,
  scratch: ExecutionScratch,
): Promise<Readonly<Record<string, McpStdioServerConfig>> | undefined> {
  if (requirement === undefined) return existing;
  const bin = this['deps'].agentMessageMcpBin!;
  const contextToken = `${randomUUID()}.${randomUUID()}`;
  const contextFile = await writeMcpContextFile(mcpContextFile(scratch, AGENT_MESSAGE_MCP_SERVER_NAME), {
    storeDir: this['deps'].storeDir, productId: this['deps'].productId, contextToken,
  });
  this['revokeAgentMessageContext'](taskId);
  this['messageContextByToken'].set(contextToken, taskId);
  this['messageContextByTask'].set(taskId, contextToken);
  return Object.freeze({
    ...(existing ?? {}),
    [AGENT_MESSAGE_MCP_SERVER_NAME]: Object.freeze({
      command: bin.command,
      args: Object.freeze([...bin.args, contextFile]),
    }),
  });
}

export async function withAgentResultMcp(
  this: TaskRunner,
  existing: Readonly<Record<string, McpStdioServerConfig>> | undefined,
  taskId: string,
  selection: Readonly<TerminalProjectionSelection> | undefined,
  scratch: ExecutionScratch,
): Promise<Readonly<Record<string, McpStdioServerConfig>> | undefined> {
  if (selection?.mode !== 'result-document') return existing;
  const bin = this['deps'].agentResultMcpBin!;
  const contextToken = `${randomUUID()}.${randomUUID()}`;
  const contextFile = await writeMcpContextFile(mcpContextFile(scratch, AGENT_RESULT_MCP_SERVER_NAME), {
    storeDir: this['deps'].storeDir, productId: this['deps'].productId, contextToken,
  });
  this['revokeAgentResultContext'](taskId);
  const context: AgentResultContext = { taskId, token: contextToken, contract: selection.contract, schema: selection.schema };
  this['resultContextByToken'].set(contextToken, context);
  this['resultContextByTask'].set(taskId, context);
  return Object.freeze({
    ...(existing ?? {}),
    [AGENT_RESULT_MCP_SERVER_NAME]: Object.freeze({
      command: bin.command,
      args: Object.freeze([...bin.args, contextFile]),
    }),
  });
}

export async function withAgentMemoryMcp(
  this: TaskRunner,
  existing: Readonly<Record<string, McpStdioServerConfig>> | undefined,
  taskId: string,
  agentRef: AgentRef,
  mode: 'read' | 'read-write',
  bin: {command: string; args: readonly string[]},
  toolList: 'granted' | 'complete',
  scratch: ExecutionScratch,
): Promise<Readonly<Record<string, McpStdioServerConfig>>> {
  if (existing !== undefined && Object.prototype.hasOwnProperty.call(existing, AGENT_MEMORY_MCP_SERVER_NAME)) {
    throw new Error(`MCP server name "${AGENT_MEMORY_MCP_SERVER_NAME}" is reserved by the daemon`);
  }
  const contextToken = `${randomUUID()}.${randomUUID()}`;
  const context: AgentMemoryMcpContext = {
    storeDir: this['deps'].storeDir, productId: this['deps'].productId, contextToken, mode, toolList,
  };
  const contextFile = await writeMcpContextFile(mcpContextFile(scratch, AGENT_MEMORY_MCP_SERVER_NAME), context);
  this['revokeAgentMemoryContext'](taskId);
  this['memoryContextByToken'].set(contextToken, Object.freeze({ taskId, agentRef: Object.freeze({ ...agentRef }), mode }));
  this['memoryContextByTask'].set(taskId, contextToken);
  return Object.freeze({
    ...(existing ?? {}),
    [AGENT_MEMORY_MCP_SERVER_NAME]: Object.freeze({
      command: bin.command,
      args: Object.freeze([...bin.args, contextFile]),
    }),
  });
}

export async function withHostToolsetContext(
  this: TaskRunner,
  servers: Readonly<Record<string, McpStdioServerConfig>>,
  taskId: string,
  agentRef: AgentRef,
  toolsetIdByServer: ReadonlyMap<string, string>,
  scratch: ExecutionScratch,
): Promise<Readonly<Record<string, McpStdioServerConfig>>> {
  // A re-offer of the same taskId must not leave the previous attempt's
  // nonces mintable: the old child is gone, so its tokens are authority
  // nobody holds any more.
  this['deleteHostToolsetContexts'](taskId);
  // §8.1's capability gate, asked before anything is minted. An undeclared
  // lane gets no nonce at all — not a weaker one, and not a device
  // assertion's identity wearing a task's name. Its server still gets the
  // argument, which names no file, so every task run has one argv shape, the
  // prepared host can recover the configured argv by position, and the child
  // fails explicitly for want of a token (§8.2(1)), which is the visible
  // outcome §8.3 asks for when a device or a deployment cannot serve this lane.
  const available = this['deps'].hostTaskContextAvailable?.() === true;
  const frozenAgentRef = Object.freeze({ ...agentRef });
  const tokens = new Set<string>();
  const tokenByServer = new Map<string, string>();
  for (const serverName of available ? Object.keys(servers) : []) {
    const toolsetId = toolsetIdByServer.get(serverName);
    // A server with no owning toolset would mean the resolution above lost
    // the binding; minting a nonce for it would produce a claim no frozen
    // offer can confirm, so it simply gets no task lane.
    if (toolsetId === undefined) continue;
    const contextToken = freshHostToolsetContextToken();
    this['hostToolsetContextByToken'].set(contextToken, {
      taskId,
      agentRef: frozenAgentRef,
      toolsetId,
      serverName,
      state: 'active',
    });
    tokens.add(contextToken);
    tokenByServer.set(serverName, contextToken);
  }
  // Every nonce is registered before the first write, so a cancel landing
  // during one revokes them all.
  if (tokens.size > 0) this['hostToolsetContextTokensByTask'].set(taskId, tokens);
  const injected: Record<string, McpStdioServerConfig> = {};
  for (const [serverName, server] of Object.entries(servers)) {
    if (!toolsetIdByServer.has(serverName)) {
      injected[serverName] = server;
      continue;
    }
    // Random, not the server name: names that differ only in case would share
    // one file on a case-insensitive filesystem.
    const contextFile = mcpContextFile(scratch, `host-toolset-${randomUUID()}`);
    const contextToken = tokenByServer.get(serverName);
    if (contextToken !== undefined) {
      await writeMcpContextFile(contextFile, {
        storeDir: this['deps'].storeDir, productId: this['deps'].productId, contextToken,
      });
    }
    injected[serverName] = Object.freeze({
      ...server,
      args: Object.freeze([...(server.args ?? []), contextFile]),
    });
  }
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
