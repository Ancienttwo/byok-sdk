import { readFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import {
  filterMcpObservationForPolicy,
  projectMcpTools,
  type McpToolProjection,
} from '../../mcp/projection';
import { createPiMcpTools, type PiMcpToolNaming } from './mcp-tools';
import {
  McpServerPool,
  parseTaskScopedMcpConfig,
  type TaskScopedMcpConfig,
} from './mcp-server-pool';
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

function fail(message: string): never {
  throw new Error(`BYOK Pi MCP extension: ${message}`);
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
  return parseTaskScopedMcpConfig(parsed, fail);
}

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

/** Explicit task authority for the SDK-owned inline entry. */
export function createByokMcpExtension(config: TaskScopedMcpConfig): ExtensionFactory {
  return (pi) => registerByokMcpToolsWithConfig(pi, config);
}

export default function registerByokMcpTools(pi: ExtensionAPI): void {
  registerByokMcpToolsWithConfig(pi, loadTaskScopedConfig());
}

function registerByokMcpToolsWithConfig(pi: ExtensionAPI, config: TaskScopedMcpConfig): void {
  const pool = new McpServerPool(config, fail);
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
      // 0.85.1005, whose registered tools carry these schemas verbatim.
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
