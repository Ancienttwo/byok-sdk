import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import { addAbortListener } from 'node:events';
import {
  MCP_DEFAULT_REQUEST_TIMEOUT_MS,
  MCP_OBSERVATION_MAX_STDOUT_BYTES,
  McpAuthorityError,
  McpStdioClient,
  type McpStdioClientOptions,
  type McpStdioServerSpec,
} from './client.js';
import { describeMcpServer, diffMcpObservation, type McpServerObservation } from './observation.js';

export const MCP_TOOL_CALL_TIMEOUT_MS = 120_000;

export class McpServerDriftError extends McpAuthorityError {}
export class McpCallOutcomeUnknownError extends Error {}

interface ServerConnection {
  readonly client: McpStdioClient;
  readonly ready: Promise<readonly Tool[]>;
  tools?: readonly Tool[];
  retired?: Promise<void>;
}

interface ServerLaunch extends McpStdioClientOptions {
  readonly spec: McpStdioServerSpec;
  readonly frozen?: McpServerObservation;
}

type DescribeServer = (
  name: string, client: McpStdioClient, tools: readonly Tool[], label: string,
) => McpServerObservation;

/** Task-scoped lazy connections shared by Pi and the hub. */
export class McpServerPool {
  private readonly connections = new Map<string, ServerConnection>();
  private readonly children = new Set<McpStdioClient>();
  private closed = false;

  constructor(
    private readonly launch: (name: string) => ServerLaunch,
    private readonly policy: { readonly boundedHandshake: true } | { readonly describe: DescribeServer },
  ) {}

  private async open(
    name: string,
    client: McpStdioClient,
    launch: ServerLaunch,
    previousClose?: Promise<void>,
    beforeOpen?: () => Promise<void>,
  ): Promise<readonly Tool[]> {
    if (previousClose !== undefined) await previousClose;
    if (beforeOpen !== undefined) await beforeOpen();
    const bounded = 'boundedHandshake' in this.policy;
    const signal = bounded ? AbortSignal.timeout(MCP_DEFAULT_REQUEST_TIMEOUT_MS) : undefined;
    const deadline = bounded ? performance.now() + MCP_DEFAULT_REQUEST_TIMEOUT_MS : undefined;
    await client.connect(signal, deadline);
    const tools = await client.listTools(signal);
    const describe = 'describe' in this.policy ? this.policy.describe : describeMcpServer;
    const observed = describe(name, client, tools, launch.label ?? `MCP server "${name}"`);
    if (launch.frozen !== undefined) {
      const drifts = diffMcpObservation(launch.frozen, observed);
      if (drifts.length > 0) {
        throw new McpServerDriftError(
          `MCP toolset server "${name}" no longer matches the tools this task was admitted with: `
          + drifts.map((drift) => `${drift.reason} (${drift.detail})`).join('; '),
        );
      }
    }
    if (bounded) {
      signal?.throwIfAborted();
      client.finishObservation();
    }
    return tools;
  }

  private connection(name: string, beforeOpen?: () => Promise<void>): ServerConnection {
    if (this.closed) throw new McpAuthorityError('the MCP toolset connections for this task are closed');
    const existing = this.connections.get(name);
    let previousClose: Promise<void> | undefined;
    if (existing !== undefined) {
      const failed = existing.tools !== undefined && !existing.client.isConnected;
      if (!('boundedHandshake' in this.policy) || (existing.retired === undefined && !failed)) return existing;
      previousClose = this.evict(name, existing);
    }
    const launch = this.launch(name);
    const client = new McpStdioClient(launch.spec, 'boundedHandshake' in this.policy
      ? { ...launch, maxStdoutBytes: MCP_OBSERVATION_MAX_STDOUT_BYTES }
      : launch);
    this.children.add(client);
    const connection: ServerConnection = {
      client,
      ready: this.open(name, client, launch, previousClose, beforeOpen).then((tools) => {
        connection.tools = tools;
        return tools;
      }).catch(async (error: unknown) => {
        await this.evict(name, connection);
        throw error;
      }),
    };
    this.connections.set(name, connection);
    return connection;
  }

  private evict(name: string, connection: ServerConnection): Promise<void> {
    connection.retired ??= connection.client.close().finally(() => {
      if (this.connections.get(name) === connection) this.connections.delete(name);
      this.children.delete(connection.client);
    });
    return connection.retired;
  }

  async listTools(name: string): Promise<readonly Tool[]> {
    const connection = this.connection(name);
    await connection.ready;
    return connection.client.listTools();
  }

  async call(
    server: string, tool: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const connection = this.connection(server);
    await connection.ready;
    return connection.client.callTool(tool, args, { signal, timeoutMs: MCP_TOOL_CALL_TIMEOUT_MS });
  }

  async callVerified(
    server: string,
    tool: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
    checkActive: () => Promise<void>,
    timeoutMs = MCP_TOOL_CALL_TIMEOUT_MS,
  ): Promise<CallToolResult> {
    signal.throwIfAborted();
    const connection = this.connection(server, checkActive);
    let calling = false;
    const cancel = addAbortListener(signal, () => {
      if (!calling) void this.evict(server, connection);
    });
    try {
      const tools = await connection.ready;
      const definition = tools.find((entry) => entry.name === tool);
      if (definition === undefined) throw new McpAuthorityError('MCP tool was absent from the verified connection');
      try {
        await checkActive();
      } catch (error) {
        await this.evict(server, connection);
        throw error;
      }
      signal.throwIfAborted();
      if (connection.retired !== undefined || !connection.client.isConnected) {
        throw new McpAuthorityError('MCP server disconnected before dispatch');
      }
      try {
        calling = true;
        return await connection.client.callTool(tool, args, { signal, timeoutMs, toolDefinition: definition });
      } catch (error) {
        await this.evict(server, connection);
        throw new McpCallOutcomeUnknownError('MCP tool call result unknown', { cause: error });
      }
    } finally {
      cancel[Symbol.dispose]();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.connections.clear();
    await Promise.all([...this.children].map((client) => client.close()));
    this.children.clear();
  }
}
