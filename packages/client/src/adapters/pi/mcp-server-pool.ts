import { parsePiMcpEnvironment } from './mcp-environment.js';
import { isAbsolute } from 'node:path';
import { McpAuthorityError, type McpStdioServerSpec } from '../../mcp/client.js';
import {
  GRANTABLE_TOOL_NAME,
  type McpToolDescriptor,
  type McpToolsetServerObservation,
} from '../../mcp/observation.js';
import { McpServerPool as SharedMcpServerPool } from '../../mcp/server-pool.js';
import type { McpToolProjection } from '../../mcp/projection.js';
import type { McpToolCallHost } from './mcp-tools.js';
import { isReservedMcpServerName } from '../../sdk-reserved-mcp.js';

/**
 * The ONE task-scoped MCP host both Pi entries run on.
 *
 * `./mcp-extension.ts` (the ordinary `pi --mode rpc` child) and
 * `../../bin/byok-pi-prepared.ts` (the in-process prepared launch) parse the
 * same task-scoped configuration with the parsers here and reach their servers
 * through the same {@link McpServerPool}. Two pools would be two answers to
 * "which child executed this tool call", and the prepared lane freezes an
 * executor identity per tool precisely so that question has exactly one.
 *
 * Everything in this file is parsing and process lifecycle. The projection and
 * the registered tool shapes stay in the shared core
 * (`../../mcp/`) and in `./mcp-tools.ts`.
 */

/**
 * The SDK's own Pi control variables, by name shape. Every variable the adapter
 * sets on the Pi child to address this SDK's entries
 * (`BYOK_PI_MCP_CONFIG_PATH`) matches it, so a new
 * one is stripped from MCP server children by existing.
 */
const BYOK_PI_CONTROL_ENV_PREFIX = /^BYOK_PI_/u;

/**
 * How one entry refuses a malformed configuration.
 *
 * Passed in rather than hard-coded so a failure names the entry that refused —
 * the extension and the prepared launcher are different processes with
 * different operator-visible identities, and a message that named only one of
 * them would misattribute half the failures.
 */
export type McpConfigFailure = (message: string) => never;

/** What the adapter writes for exactly one task. Strict: an unknown shape is refused, never repaired. */
export interface TaskScopedMcpConfig {
  /** Credential-free environment measured by daemon admission, never Pi process.env. */
  readonly mcpEnv: Readonly<Record<string, string>>;
  readonly mcpServers: Readonly<Record<string, McpStdioServerSpec>>;
  /**
   * Everything the daemon observed. A server that grew a tool since admission
   * has drifted.
   */
  readonly observation: Readonly<Record<string, McpToolsetServerObservation>>;
  /**
   * The working directory every server below is spawned in: the session
   * workspace or the Agent home, as in OAR. Required whenever this task
   * projects any server, so a server never inherits a different process cwd.
   */
  readonly launchCwd?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseMcpServerSpec(name: string, raw: unknown, fail: McpConfigFailure): McpStdioServerSpec {
  if (!isPlainObject(raw) || typeof raw.command !== 'string' || raw.command.length === 0) {
    fail(`mcpServers.${name} must declare a non-empty command`);
  }
  const args = raw.args;
  if (args !== undefined && (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))) {
    fail(`mcpServers.${name}.args must be an array of strings`);
  }
  const env = raw.env;
  if (env !== undefined && !isPlainObject(env)) fail(`mcpServers.${name}.env must be an object`);
  return Object.freeze({
    command: raw.command,
    ...(args === undefined ? {} : { args: Object.freeze([...(args as string[])]) }),
    ...(env === undefined ? {} : { env: Object.freeze({ ...(env as Record<string, string>) }) }),
  });
}

export function parseMcpTool(server: string, raw: unknown, fail: McpConfigFailure): McpToolDescriptor {
  if (!isPlainObject(raw) || typeof raw.name !== 'string' || !GRANTABLE_TOOL_NAME.test(raw.name)) {
    fail(`observation.${server} carries a tool without a grantable name`);
  }
  const name = raw.name as string;
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    fail(`observation.${server}.${name} has a non-string description`);
  }
  if (!isPlainObject(raw.inputSchema)) fail(`observation.${server}.${name} has no object inputSchema`);
  return Object.freeze({
    name,
    description: (raw.description as string | undefined) ?? '',
    inputSchema: raw.inputSchema,
  });
}

export function parseMcpObservation(
  name: string,
  raw: unknown,
  fail: McpConfigFailure,
): McpToolsetServerObservation {
  if (!isPlainObject(raw)) fail(`observation.${name} must be an object`);
  const { toolsetId, serverName, serverInfo, protocolVersion, tools } = raw;
  if (typeof toolsetId !== 'string' || toolsetId.length === 0) fail(`observation.${name} has no toolsetId`);
  if (serverName !== name) fail(`observation.${name} disagrees with its own key`);
  if (!isPlainObject(serverInfo) || typeof serverInfo.name !== 'string' || typeof serverInfo.version !== 'string') {
    fail(`observation.${name} has no serverInfo`);
  }
  if (typeof protocolVersion !== 'string' || protocolVersion.length === 0) {
    fail(`observation.${name} has no protocolVersion`);
  }
  if (!Array.isArray(tools) || tools.length === 0) fail(`observation.${name} lists no tools`);
  return Object.freeze({
    toolsetId: toolsetId as string,
    serverName: name,
    serverInfo: Object.freeze({ name: serverInfo.name as string, version: serverInfo.version as string }),
    protocolVersion: protocolVersion as string,
    tools: Object.freeze(tools.map((tool) => parseMcpTool(name, tool, fail))),
  });
}

/** Validate one already-parsed JSON value as the task-scoped configuration. */
export function parseTaskScopedMcpConfig(parsed: unknown, fail: McpConfigFailure): TaskScopedMcpConfig {
  if (!isPlainObject(parsed)) fail('the task-scoped configuration must be an object');
  let mcpEnv: Readonly<Record<string, string>>;
  try { mcpEnv = parsePiMcpEnvironment(parsed.mcpEnv); }
  catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  if (!isPlainObject(parsed.mcpServers)) fail('the task-scoped configuration must contain an mcpServers object');
  if (!isPlainObject(parsed.observation)) fail('the task-scoped configuration must contain an observation object');
  const mcpServers: Record<string, McpStdioServerSpec> = {};
  for (const [name, raw] of Object.entries(parsed.mcpServers)) mcpServers[name] = parseMcpServerSpec(name, raw, fail);
  const observation: Record<string, McpToolsetServerObservation> = {};
  for (const [name, raw] of Object.entries(parsed.observation)) {
    if (mcpServers[name] === undefined) fail(`observation.${name} names a server this task does not project`);
    if (isReservedMcpServerName(name)) {
      fail(`observation.${name} is an SDK-reserved server and is never observed by the daemon`);
    }
    observation[name] = parseMcpObservation(name, raw, fail);
  }
  // Every non-reserved server MUST arrive with the daemon's observation. A host
  // toolset server the daemon never observed is one whose tools nobody admitted
  // this task for, and discovering them here would make this process the
  // authority instead of the daemon.
  for (const name of Object.keys(mcpServers)) {
    if (!isReservedMcpServerName(name) && observation[name] === undefined) {
      fail(`mcpServers.${name} has no daemon observation; refusing to discover its tools here`);
    }
  }
  const launchCwd = parsed.launchCwd;
  if (Object.keys(mcpServers).length > 0) {
    if (typeof launchCwd !== 'string' || !isAbsolute(launchCwd)) {
      fail('the task-scoped configuration must contain an absolute launchCwd whenever it projects any server');
    }
  } else if (launchCwd !== undefined && typeof launchCwd !== 'string') {
    fail('the task-scoped configuration launchCwd must be a string');
  }
  return Object.freeze({
    mcpEnv,
    mcpServers: Object.freeze(mcpServers),
    observation: Object.freeze(observation),
    ...(typeof launchCwd === 'string' ? { launchCwd } : {}),
  });
}

/** Pi's config, environment and drift checks stay on its existing entry path. */
export class McpServerPool implements McpToolCallHost {
  private readonly pool: SharedMcpServerPool;

  constructor(config: TaskScopedMcpConfig, private readonly fail: McpConfigFailure) {
    parsePiMcpEnvironment(config.mcpEnv);
    this.pool = new SharedMcpServerPool((name) => {
      const spec = config.mcpServers[name];
      if (spec === undefined) throw new McpAuthorityError(`MCP server "${name}" is not projected for this task`);
      if (config.launchCwd === undefined) {
        fail(`MCP server "${name}" has no launchCwd; refusing to start it in this process's own directory`);
      }
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(config.mcpEnv)) {
        if (value !== undefined && !BYOK_PI_CONTROL_ENV_PREFIX.test(key)) env[key] = value;
      }
      return {
        spec,
        cwd: config.launchCwd,
        env,
        label: `MCP toolset server "${name}"`,
        frozen: config.observation[name],
      };
    }, {
      describe: (serverName, client, tools) => ({
        serverName,
        serverInfo: client.serverInfo(),
        protocolVersion: client.protocolVersion(),
        tools: tools.map((tool) => parseMcpTool(serverName, tool, fail)),
      }),
    });
  }

  call(tool: McpToolProjection, args: Readonly<Record<string, unknown>>, signal?: AbortSignal) {
    return this.pool.call(tool.serverName, tool.toolName, args, signal);
  }

  async observe(serverName: string): Promise<readonly McpToolDescriptor[]> {
    const tools = await this.pool.listTools(serverName);
    return tools.map((tool) => parseMcpTool(serverName, tool, this.fail));
  }

  close(): Promise<void> {
    return this.pool.close();
  }
}
