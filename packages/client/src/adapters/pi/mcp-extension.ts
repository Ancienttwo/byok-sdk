import { readFileSync } from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { McpAuthorityError, McpStdioClient, type McpStdioServerSpec } from '../../mcp/client';
import {
  diffMcpObservation,
  GRANTABLE_TOOL_NAME,
  type McpClassifiedToolDescriptor,
  type McpServerObservation,
  type McpToolDescriptor,
  type McpToolsetServerObservation,
} from '../../mcp/observation';
import {
  filterMcpObservationForPolicy,
  projectMcpTools,
  type McpToolProjection,
} from '../../mcp/projection';
import { createPiMcpTools, type McpToolCallHost, type PiMcpToolNaming } from './mcp-tools';
import { BYOK_PI_MCP_CONFIG_PATH } from './mcp-config';
import { isReservedMcpServerName } from '../../sdk-reserved-mcp';
import { compareCodeUnits } from '../../util/compare-code-units';

/**
 * The SDK's own Pi MCP extension, built on the shared core (`../../mcp/`).
 *
 * It registers ONE Pi tool per observed MCP tool, carrying that tool's real
 * schema, in the core's canonical `(toolsetId, serverName, toolName)` order.
 * It derives nothing itself: the task-scoped file the adapter writes carries
 * the daemon's admission observation, and the tool list comes from running the
 * same `projectMcpTools()` the prepared launch path runs. An extension allowed
 * to re-derive its own tool set would make the two entries agree only by
 * coincidence.
 *
 * Replaces the third-party `pi-mcp-adapter`, which registered a single `mcp`
 * proxy tool and reached the servers through its own MCP client. Retiring it
 * collapsed four MCP call sites into one authority and dropped a native
 * keyring binding, a regex-analysis engine, a TOML parser and a browser
 * launcher from the install graph.
 */

/** What the adapter writes for exactly one task. Strict: an unknown shape is refused, never repaired. */
interface TaskScopedMcpConfig {
  readonly mcpServers: Readonly<Record<string, McpStdioServerSpec>>;
  /**
   * Everything the daemon observed, classification included — NOT the subset
   * the policy allows. Registration narrows it; drift verification does not,
   * because a server that grew a tool since admission has drifted whether or
   * not the model would have been shown that tool.
   */
  readonly observation: Readonly<Record<string, McpToolsetServerObservation>>;
  /** This task's permission mode, applied to the observation by the shared core. */
  readonly permissionMode: string;
}

/**
 * The SDK's own Pi control variables, by name shape. Every variable the
 * adapter sets on the Pi child to address this SDK's extensions
 * (`BYOK_PI_MCP_CONFIG_PATH`, `BYOK_PI_PERMISSION_MODE`) matches it, so a new
 * one is stripped from MCP server children by existing.
 */
const BYOK_PI_CONTROL_ENV_PREFIX = /^BYOK_PI_/u;

function fail(message: string): never {
  throw new Error(`BYOK Pi MCP extension: ${message}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseServer(name: string, raw: unknown): McpStdioServerSpec {
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

function parseTool(server: string, raw: unknown): McpClassifiedToolDescriptor {
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

function parseObservation(name: string, raw: unknown): McpToolsetServerObservation {
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
    tools: Object.freeze(tools.map((tool) => parseTool(name, tool))),
  });
}

function loadTaskScopedConfig(): TaskScopedMcpConfig {
  const configPath = process.env[BYOK_PI_MCP_CONFIG_PATH];
  if (!configPath) fail(`${BYOK_PI_MCP_CONFIG_PATH} is required`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (cause) {
    fail(`${configPath} could not be read as JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (!isPlainObject(parsed)) fail('the task-scoped configuration must be an object');
  if (!isPlainObject(parsed.mcpServers)) fail('the task-scoped configuration must contain an mcpServers object');
  if (!isPlainObject(parsed.observation)) fail('the task-scoped configuration must contain an observation object');
  if (typeof parsed.permissionMode !== 'string' || parsed.permissionMode.length === 0) {
    fail('the task-scoped configuration must contain a permissionMode string');
  }
  const mcpServers: Record<string, McpStdioServerSpec> = {};
  for (const [name, raw] of Object.entries(parsed.mcpServers)) mcpServers[name] = parseServer(name, raw);
  const observation: Record<string, McpToolsetServerObservation> = {};
  for (const [name, raw] of Object.entries(parsed.observation)) {
    if (mcpServers[name] === undefined) fail(`observation.${name} names a server this task does not project`);
    if (isReservedMcpServerName(name)) fail(`observation.${name} is an SDK-reserved server and is never observed by the daemon`);
    observation[name] = parseObservation(name, raw);
  }
  // Every non-reserved server MUST arrive with the daemon's observation. A
  // host toolset server the daemon never observed is one whose tools nobody
  // admitted this task for, and discovering them here would make the extension
  // the authority instead of the daemon.
  for (const name of Object.keys(mcpServers)) {
    if (!isReservedMcpServerName(name) && observation[name] === undefined) {
      fail(`mcpServers.${name} has no daemon observation; refusing to discover its tools here`);
    }
  }
  return Object.freeze({
    mcpServers: Object.freeze(mcpServers),
    observation: Object.freeze(observation),
    permissionMode: parsed.permissionMode,
  });
}

/**
 * One connected server per projected server, opened on first use and verified
 * against the frozen observation before any tool runs.
 *
 * Lazy because a session that never calls a toolset tool should not pay to
 * start its servers, and eager startup would move a server fault into session
 * start where Pi cannot report it usefully.
 *
 * Verified because admission and execution are two different spawns of the
 * same command. Between them a server can be upgraded, and the tools the model
 * was shown would then not be the tools it is calling. The comparison is set
 * equality with the frozen descriptors — a tool that appeared is as much a
 * refusal as one that vanished, because an extra tool is authority nobody
 * admitted this task for.
 */
class McpServerPool implements McpToolCallHost {
  private readonly clients = new Map<string, Promise<McpStdioClient>>();
  private closed = false;

  constructor(private readonly config: TaskScopedMcpConfig) {}

  /**
   * The environment an MCP server child is spawned with.
   *
   * This process's own environment minus the SDK's own Pi control variables.
   * They address THIS extension and the sibling policy extension — the path to
   * the task-scoped config file, the task's permission mode — and a host
   * toolset server has no business reading either: the config file names every
   * server this task projects and the exact observation it was admitted with,
   * which is a different toolset's configuration from the point of view of any
   * one server. Nothing else is filtered: the Pi child was already spawned
   * with a filtered environment by the adapter, so PATH, HOME and the rest are
   * the task's, not the daemon's.
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
    const client = new McpStdioClient(server, {
      label: `MCP toolset server "${serverName}"`,
      // The extension runs INSIDE the Pi child the adapter already spawned
      // with a filtered environment, so this process's own environment is the
      // task's environment — it is not the daemon's. The SDK's own Pi control
      // variables are still stripped; see `childEnv`.
      env: this.childEnv(),
    });
    try {
      await client.connect();
      const observed: McpServerObservation = {
        serverName,
        serverInfo: client.serverInfo(),
        protocolVersion: client.protocolVersion(),
        tools: (await client.listTools()).map((tool) => parseTool(serverName, tool)),
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
      // A failed open must not be cached as a permanently poisoned entry with
      // an unhandled rejection attached; the next call re-opens and fails
      // again with its own reason.
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
      // A tool call is the model's work, not a handshake: it gets a real
      // budget rather than the admission deadline.
      timeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
    });
  }

  /** Connect if needed and report what the server says its tools are. */
  async observe(serverName: string): Promise<readonly McpToolDescriptor[]> {
    const client = await this.client(serverName);
    return (await client.listTools()).map((tool) => parseTool(serverName, tool));
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

/**
 * Ceiling for one `tools/call`. A host tool doing real work (a database query,
 * an API round trip) is not a handshake and must not inherit the admission
 * deadline; the task's own cancellation remains the real bound.
 */
const MCP_TOOL_CALL_TIMEOUT_MS = 120_000;

/**
 * Read one SDK-reserved helper's own tools.
 *
 * Reserved servers are the one case the daemon does not observe: they are this
 * SDK's own binaries, their tool names are fixed by the protocol each defines
 * (`../mcp-tool-grants.ts` grants them from a constant, never from an
 * observation), and only the binary itself knows their schemas. They are read
 * live, at session start, and never enter the canonical toolset projection —
 * no host toolset, no billing artifact and no frozen manifest includes them.
 */
async function reservedServerTools(
  pool: McpServerPool,
  serverNames: readonly string[],
): Promise<readonly McpToolProjection[]> {
  const projections: McpToolProjection[] = [];
  for (const serverName of [...serverNames].sort(compareCodeUnits)) {
    // Sorted, like the host-toolset projection: registration order is what the
    // model is shown, so it must not depend on the order a helper happened to
    // list its tools in.
    const tools = [...await pool.observe(serverName)].sort((left, right) => compareCodeUnits(left.name, right.name));
    for (const tool of tools) {
      projections.push(Object.freeze({
        toolsetId: serverName,
        serverName,
        toolName: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
    }
  }
  return Object.freeze(projections);
}

export default function registerByokMcpTools(pi: ExtensionAPI): void {
  const config = loadTaskScopedConfig();
  const pool = new McpServerPool(config);
  const registered = new Set<string>();
  const register = (tools: readonly McpToolProjection[], naming: PiMcpToolNaming): void => {
    for (const tool of createPiMcpTools(tools, pool, naming)) {
      // Two tools under one name is a model that cannot address one of them,
      // and silently keeping the first would pick a winner on its behalf.
      if (registered.has(tool.name)) {
        throw new Error(`BYOK Pi MCP extension: two MCP tools claim the name ${JSON.stringify(tool.name)}`);
      }
      registered.add(tool.name);
      // Pi types `ToolDefinition.parameters` as a TypeBox schema object; an
      // MCP tool's `inputSchema` is a plain runtime JSON Schema that no
      // compile-time type can describe, and rebuilding it as TypeBox would
      // make this file the authority on a schema the server owns. Pi treats
      // the value as JSON Schema at runtime — empirically honoured by
      // 0.85.1002, whose registered tools carry these schemas verbatim.
      (pi.registerTool as (definition: unknown) => void)(tool);
    }
  };
  // The daemon's observation is the single authority for host toolsets, the
  // order comes from the core rather than from this file, and so does the
  // policy filter: the adapter admitted this task on exactly this call, so
  // running it again here registers the set the task was admitted with rather
  // than a second opinion about it. A tool the mode excludes is never
  // registered at all — the model does not see it, so there is no call to
  // refuse and no tokens spent attempting one.
  const allowed = filterMcpObservationForPolicy(config.observation, config.permissionMode);
  if (!allowed.ok) fail(allowed.reason);
  register(projectMcpTools(allowed.observation), 'qualified');

  const reserved = Object.keys(config.mcpServers).filter((name) => isReservedMcpServerName(name));
  if (reserved.length > 0) {
    // Registration must be synchronous — Pi refuses tools registered after
    // extension loading — so the reserved helpers are read during
    // `session_start`, which may await.
    // Bare names: a reserved helper's tools are named by a protocol this SDK
    // owns, and the relay prompts and docs reference those names verbatim.
    pi.on('session_start', async () => { register(await reservedServerTools(pool, reserved), 'bare'); });
  }
  pi.on('session_shutdown', () => { void pool.close(); });
}
