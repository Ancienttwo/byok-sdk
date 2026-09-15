import { isAbsolute } from 'node:path';
import { PERMISSION_MODES, type PermissionMode } from '@byok-sdk/protocol';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { McpAuthorityError, McpStdioClient, type McpStdioServerSpec } from '../../mcp/client';
import {
  diffMcpObservation,
  GRANTABLE_TOOL_NAME,
  type McpClassifiedToolDescriptor,
  type McpServerObservation,
  type McpToolDescriptor,
  type McpToolsetServerObservation,
} from '../../mcp/observation';
import type { McpToolProjection } from '../../mcp/projection';
import type { McpToolCallHost } from './mcp-tools';
import { isReservedMcpServerName } from '../../sdk-reserved-mcp';
import {
  parseToolImplementationIdentity,
  type ToolImplementationIdentityV1,
} from '../../daemon/tool-implementation-identity';

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
 * Everything in this file is parsing and process lifecycle. The policy filter,
 * the projection and the registered tool shapes stay in the shared core
 * (`../../mcp/`) and in `./mcp-tools.ts`.
 */

/**
 * The SDK's own Pi control variables, by name shape. Every variable the adapter
 * sets on the Pi child to address this SDK's entries
 * (`BYOK_PI_MCP_CONFIG_PATH`, `BYOK_PI_PERMISSION_MODE`) matches it, so a new
 * one is stripped from MCP server children by existing.
 */
const BYOK_PI_CONTROL_ENV_PREFIX = /^BYOK_PI_/u;

/**
 * Ceiling for one `tools/call`. A host tool doing real work (a database query,
 * an API round trip) is not a handshake and must not inherit the admission
 * deadline; the task's own cancellation remains the real bound.
 */
export const MCP_TOOL_CALL_TIMEOUT_MS = 120_000;

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
  readonly mcpServers: Readonly<Record<string, McpStdioServerSpec>>;
  /**
   * Everything the daemon observed, classification included — NOT the subset
   * the policy allows. Registration narrows it; drift verification does not,
   * because a server that grew a tool since admission has drifted whether or
   * not the model would have been shown that tool.
   */
  readonly observation: Readonly<Record<string, McpToolsetServerObservation>>;
  /** This task's permission mode, applied to the observation by the shared core. */
  readonly permissionMode: PermissionMode;
  /**
   * The working directory every server below is spawned in — the one the
   * daemon proved this uid cannot write and probed each server in
   * (`daemon/trusted-launch-cwd.ts`).
   *
   * Required whenever this task projects any server, and NOT defaulted here:
   * omitting it would silently hand the child the Pi process's own cwd, which
   * is the canonical Agent home — a directory the agent writes by design, and
   * from which a `bun --compile` server binary reads `bunfig.toml` `preload`
   * before running its own code.
   */
  readonly launchCwd?: string;
  /**
   * What the daemon established about the implementation behind each projected
   * server, keyed by projected server name
   * (`daemon/tool-implementation-identity.ts`).
   *
   * The values are the daemon's, resolved once at admission; this file does not
   * resolve, repair or default them. An ATTESTED one is re-measured against the
   * filesystem before its server is spawned, so a forged entry buys an
   * immediate refusal rather than a trusted identity — and a malformed one
   * refuses the whole configuration, because a silently dropped identity is a
   * spawn that quietly stopped being checked.
   */
  readonly toolImplementations: Readonly<Record<string, ToolImplementationIdentityV1>>;
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

export function parseMcpTool(server: string, raw: unknown, fail: McpConfigFailure): McpClassifiedToolDescriptor {
  if (!isPlainObject(raw) || typeof raw.name !== 'string' || !GRANTABLE_TOOL_NAME.test(raw.name)) {
    fail(`observation.${server} carries a tool without a grantable name`);
  }
  const name = raw.name as string;
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    fail(`observation.${server}.${name} has a non-string description`);
  }
  if (!isPlainObject(raw.inputSchema)) fail(`observation.${server}.${name} has no object inputSchema`);
  // Present on every tool of a classified toolset and on none of an
  // unclassified one. A non-boolean is refused rather than coerced: this field
  // decides what a restricted policy may call, and a truthy string would widen
  // the very boundary it describes. Live `tools/list` answers carry no
  // classification at all — the server is not the authority on it.
  if (raw.readOnly !== undefined && typeof raw.readOnly !== 'boolean') {
    fail(`observation.${server}.${name} has a non-boolean readOnly classification`);
  }
  return Object.freeze({
    name,
    description: (raw.description as string | undefined) ?? '',
    inputSchema: raw.inputSchema,
    ...(raw.readOnly === undefined ? {} : { readOnly: raw.readOnly as boolean }),
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
  if (!isPlainObject(parsed.mcpServers)) fail('the task-scoped configuration must contain an mcpServers object');
  if (!isPlainObject(parsed.observation)) fail('the task-scoped configuration must contain an observation object');
  // Validated against the protocol's own enumeration, not merely "a non-empty
  // string": this value decides policy in the shared core, and an unrecognized
  // one would otherwise reach `filterMcpObservationForPolicy` as a mode nobody
  // wrote a rule for.
  if (typeof parsed.permissionMode !== 'string'
    || !(PERMISSION_MODES as readonly string[]).includes(parsed.permissionMode)) {
    fail(`the task-scoped configuration must contain a permissionMode of [${PERMISSION_MODES.join(', ')}]`);
  }
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
  const toolImplementations: Record<string, ToolImplementationIdentityV1> = {};
  if (parsed.toolImplementations !== undefined) {
    if (!isPlainObject(parsed.toolImplementations)) {
      fail('the task-scoped configuration toolImplementations must be an object');
    }
    for (const [name, raw] of Object.entries(parsed.toolImplementations)) {
      if (mcpServers[name] === undefined) {
        fail(`toolImplementations.${name} names a server this task does not project`);
      }
      const identity = parseToolImplementationIdentity(raw);
      if (identity === undefined) fail(`toolImplementations.${name} is not an implementation identity this SDK issued`);
      toolImplementations[name] = identity;
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
    mcpServers: Object.freeze(mcpServers),
    observation: Object.freeze(observation),
    permissionMode: parsed.permissionMode as PermissionMode,
    toolImplementations: Object.freeze(toolImplementations),
    ...(typeof launchCwd === 'string' ? { launchCwd } : {}),
  });
}

/**
 * One connected server per projected server, opened on first use and verified
 * against the frozen observation before any tool runs.
 *
 * Lazy because a session that never calls a toolset tool should not pay to
 * start its servers, and eager startup would move a server fault into session
 * start where neither entry can report it usefully.
 *
 * Verified because admission and execution are two different spawns of the same
 * command. Between them a server can be upgraded, and the tools the model was
 * shown would then not be the tools it is calling. The comparison is set
 * equality with the frozen descriptors — a tool that appeared is as much a
 * refusal as one that vanished, because an extra tool is authority nobody
 * admitted this task for.
 */
export class McpServerPool implements McpToolCallHost {
  private readonly clients = new Map<string, Promise<McpStdioClient>>();
  private closed = false;

  constructor(private readonly config: TaskScopedMcpConfig, private readonly fail: McpConfigFailure) {}

  /**
   * The environment an MCP server child is spawned with.
   *
   * This process's own environment minus the SDK's own Pi control variables.
   * They address this SDK's Pi entries — the path to the task-scoped config
   * file, the task's permission mode — and a host toolset server has no
   * business reading either: the config file names every server this task
   * projects and the exact observation it was admitted with, which is a
   * different toolset's configuration from the point of view of any one server.
   * Nothing else is filtered: this process was already spawned with a filtered
   * environment by the adapter, so PATH, HOME and the rest are the task's, not
   * the daemon's.
   */
  private childEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (value === undefined || BYOK_PI_CONTROL_ENV_PREFIX.test(name)) continue;
      env[name] = value;
    }
    return env;
  }

  private async open(serverName: string): Promise<McpStdioClient> {
    const server = this.config.mcpServers[serverName];
    if (server === undefined) {
      throw new McpAuthorityError(`MCP server "${serverName}" is not projected for this task`);
    }
    const frozen = this.config.observation[serverName];
    const launchCwd = this.config.launchCwd;
    if (launchCwd === undefined) {
      this.fail(`MCP server "${serverName}" has no launchCwd; refusing to start it in this process's own directory`);
    }
    const implementation = this.config.toolImplementations[serverName];
    const client = new McpStdioClient(server, {
      label: `MCP toolset server "${serverName}"`,
      // The core re-measures an ATTESTED identity before it spawns the child and
      // refuses the connection if the install no longer measures the way the
      // daemon attested it — never downgrading it to unavailable-and-continue.
      // A server with no identity (an SDK-reserved helper, or any server on an
      // unconfigured daemon) carries no claim, so there is nothing to
      // re-measure.
      ...(implementation === undefined ? {} : { implementation }),
      env: this.childEnv(),
      // Passed explicitly rather than inherited: this process's cwd is the Agent
      // home. `spawn` chdirs in the child before exec, so the server binary's
      // own runtime initialisation — `bunfig.toml` preload included — already
      // sees the trusted directory.
      cwd: launchCwd,
    });
    try {
      await client.connect();
      const observed: McpServerObservation = {
        serverName,
        serverInfo: client.serverInfo(),
        protocolVersion: client.protocolVersion(),
        tools: (await client.listTools()).map((tool) => parseMcpTool(serverName, tool, this.fail)),
      };
      // An SDK-reserved helper has no daemon observation to compare against —
      // its tool set is fixed by the protocol the SDK itself defines, and it is
      // read live below rather than frozen at admission.
      if (frozen !== undefined) {
        const drifts = diffMcpObservation(frozen, observed);
        if (drifts.length > 0) {
          throw new McpAuthorityError(
            `MCP toolset server "${serverName}" no longer matches the tools this task was admitted with: `
            + drifts.map((drift) => `${drift.reason} (${drift.detail})`).join('; '),
          );
        }
      }
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  private client(serverName: string): Promise<McpStdioClient> {
    let pending = this.clients.get(serverName);
    if (pending === undefined) {
      pending = this.open(serverName);
      this.clients.set(serverName, pending);
      // A failed open must not be cached as a permanently poisoned entry with an
      // unhandled rejection attached; the next call re-opens and fails again
      // with its own reason.
      pending.catch(() => this.clients.delete(serverName));
    }
    return pending;
  }

  async call(
    tool: McpToolProjection,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    if (this.closed) throw new McpAuthorityError('the MCP toolset connections for this task are closed');
    const client = await this.client(tool.serverName);
    return client.callTool(tool.toolName, args, {
      ...(signal === undefined ? {} : { signal }),
      // A tool call is the model's work, not a handshake: it gets a real budget
      // rather than the admission deadline.
      timeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
    });
  }

  /** Connect if needed and report what the server says its tools are. */
  async observe(serverName: string): Promise<readonly McpToolDescriptor[]> {
    const client = await this.client(serverName);
    return (await client.listTools()).map((tool) => parseMcpTool(serverName, tool, this.fail));
  }

  async close(): Promise<void> {
    this.closed = true;
    const pending = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(pending.map(async (entry) => {
      const client = await entry.catch(() => undefined);
      await client?.close();
    }));
  }
}
