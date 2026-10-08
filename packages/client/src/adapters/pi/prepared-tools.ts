import type { PreparedAgentMemoryMode } from '@byok-sdk/protocol';
import type { CallToolResult } from '@modelcontextprotocol/client';
import {
  preparedToolBindingDigest,
  preparedToolSurfaceObservationDigest,
  type InputPreparationToolV1,
  type PreparedToolBindingServerDigestInputV1,
} from '../../input-preparation';
import type { McpToolsetServerObservation } from '../../mcp/observation';
import { McpAuthorityError } from '../../mcp/authority-error';
import { projectMcpTools, qualifiedMcpToolName, type McpToolProjection } from '../../mcp/projection';
import { buildToolExecutorsFromObservation, InputPreparationCompileError } from './input-preparation';
import { createPiMcpTools, type McpToolCallHost, type PiMcpToolDefinition } from './mcp-tools';
import { preparedMemoryProjection, type PreparedAgentMemoryState } from '../../daemon/prepared-agent-memory';
import { preparedAgentMemoryTools } from '../../agent-memory/prepared-capability';

/**
 * The ONE place a prepared Pi session's authorized tool closure is assembled.
 *
 * `daemon/prepared-tool-surface.ts` assembles the tool surface a preparation is
 * COUNTED over; this module assembles the tool surface the prepared session is
 * LAUNCHED with, and then proves the two are the same surface by recomputing
 * the preparation's own two digests and comparing them. The digest formulas
 * themselves live in `../../input-preparation.ts` and are shared, so a match
 * here is a real match rather than an agreement between two serializers.
 *
 * Nothing here observes a server. The daemon's frozen observation travels in
 * the task-scoped configuration exactly as it does for the ordinary extension,
 * the projection comes from the shared core, and the Pi
 * tool shapes come from `./mcp-tools.ts` — the same function the ordinary
 * extension registers from. An entry allowed to re-derive its own tool set
 * would make "the prepared session sees what was counted" a coincidence.
 *
 * ## The prepared Main tool set holds MCP tools only
 *
 * `daemon/prepared-tool-surface.ts` assembles a preparation with
 * `nativeTools: []`: a task-free preparation has no workspace to resolve Pi's
 * own built-ins against. The launch therefore registers the MCP half only, and
 * the session refuses any other tool as `prepared_registry_drift`.
 */

/** One authorized tool: the name and executor identity the manifest binds, and its Pi tool definition. */
export interface PreparedPiAuthorizedTool {
  readonly name: string;
  /** The observation fingerprint the counted manifest bound for this name. */
  readonly identity: string;
  readonly tool: PiMcpToolDefinition;
}

export type PreparedPiToolSurfaceRefusalCode =
  /** The observation cannot be projected or fingerprinted at all. */
  | 'tool_surface_unfingerprintable'
  /** The spawn-free launch facts no longer match the ones the preparation froze. */
  | 'tool_binding_drift'
  /** The observed surface no longer matches the one the preparation counted. */
  | 'tool_observation_drift';

export interface PreparedPiToolSurfaceRefusal {
  readonly ok: false;
  readonly code: PreparedPiToolSurfaceRefusalCode;
  readonly message: string;
}

export interface PreparedPiToolSurface {
  readonly ok: true;
  /** In the core's canonical order — the order the model is shown and the manifest binds. */
  readonly tools: readonly PreparedPiAuthorizedTool[];
  /** The same names, for the session's `selectedTools` projection. */
  readonly toolNames: readonly string[];
  /** Recomputed here and proven equal to the preparation's. */
  readonly toolBindingDigest: string;
  readonly observationDigest: string;
}

export type PreparedPiToolSurfaceResult = PreparedPiToolSurface | PreparedPiToolSurfaceRefusal;

/** One projected server's configured argv, as the binding digest commits to it. */
export interface PreparedPiServerBinding {
  readonly serverName: string;
  readonly toolsetId: string;
  readonly command: string;
  readonly args: readonly string[];
}

export interface PreparedPiToolSurfaceInput {
  /** Sealed SDK-owned memory selection; it is distinct from Host MCP toolsets. */
  readonly agentMemory: PreparedAgentMemoryMode;
  /** The descriptor observation counted with the artifact. */
  readonly memory: PreparedAgentMemoryState | null;
  /** The daemon's frozen observation. */
  readonly observation: Readonly<Record<string, McpToolsetServerObservation>>;
  /** `toolsetId` -> the registry definition revision the preparation bound. */
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
  /** Canonically ordered by server name, exactly as the preparation ordered them. */
  readonly servers: readonly PreparedPiServerBinding[];
  /** The pinned official Pi runtime identity string. */
  readonly runtimeIdentity: string;
  /** What the durable record says this preparation froze. */
  readonly expectedToolBindingDigest: string;
  readonly expectedObservationDigest: string;
  /** How a registered tool reaches its server — the shared pool, never a second client. */
  readonly host: McpToolCallHost;
  /** Runtime-worker dispatch for the selected SDK memory helper, never the Host MCP pool. */
  readonly memoryCall?: PreparedPiMemoryCall;
}

/** The task-bound execution helper dispatch; its names are fixed SDK vocabulary. */
export interface PreparedPiMemoryCall {
  call(
    toolName: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<CallToolResult>;
}

const SDK_MEMORY_TOOLSET_ID = '@byok-sdk/agent-memory';
const SDK_MEMORY_SERVER_NAME = 'byokagentmemory';

function createPreparedMemoryTools(
  mode: PreparedAgentMemoryMode,
  memory: PreparedAgentMemoryState,
  memoryCall: PreparedPiMemoryCall,
): readonly PiMcpToolDefinition[] {
  // This is an SDK-owned projection used only to reuse Pi's result renderer.
  // It never enters the Host registry/fingerprint and cannot select a Host
  // server: `memoryCall` receives only the fixed bare memory tool name.
  const projection = preparedAgentMemoryTools(mode, memory.observation).map((tool) => Object.freeze({
    toolsetId: SDK_MEMORY_TOOLSET_ID,
    serverName: SDK_MEMORY_SERVER_NAME,
    toolName: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  }));
  return createPiMcpTools(projection, {
    call(tool, args, signal) {
      return memoryCall.call(tool.toolName, args, signal);
    },
  }, 'bare');
}

function refuse(code: PreparedPiToolSurfaceRefusalCode, message: string): PreparedPiToolSurfaceRefusal {
  return Object.freeze({ ok: false as const, code, message });
}

/**
 * Assemble the authorized tool closure for one prepared launch, or refuse.
 *
 * By VALUE rather than by exception, like the daemon-side assembler it mirrors:
 * every refusal is a stable code the launch entry reports without inventing a
 * reason of its own.
 */
export async function assemblePreparedPiToolSurface(
  input: PreparedPiToolSurfaceInput,
): Promise<PreparedPiToolSurfaceResult> {
  if (input.agentMemory === 'none' ? input.memory !== null : input.memory === null) {
    return refuse('tool_surface_unfingerprintable', 'the prepared Agent memory selection has no matching sealed descriptor state');
  }
  if (input.agentMemory !== 'none' && input.memoryCall === undefined) {
    return refuse('tool_surface_unfingerprintable', 'the prepared Agent memory selection has no execution helper dispatch');
  }

  // The SAME projection, in the SAME order, that the preparation counted and
  // that the ordinary extension registers.
  let projected: readonly McpToolProjection[];
  try {
    projected = projectMcpTools(input.observation);
  } catch (error) {
    if (error instanceof McpAuthorityError) return refuse('tool_surface_unfingerprintable', error.message);
    throw error;
  }

  const tools: InputPreparationToolV1[] = projected.map((tool) => ({
    name: qualifiedMcpToolName(tool.serverName, tool.toolName),
    description: tool.description,
    parameters: tool.inputSchema as Readonly<Record<string, unknown>>,
  }));

  let toolExecutors: Readonly<Record<string, string>>;
  try {
    ({ toolExecutors } = await buildToolExecutorsFromObservation({
      observation: input.observation,
      toolsetDefinitionRevisions: input.toolsetDefinitionRevisions,
      // Empty for the same reason the preparation's is.
      nativeTools: [],
      runtimeIdentity: input.runtimeIdentity,
    }));
  } catch (cause) {
    const message = cause instanceof InputPreparationCompileError
      ? cause.message
      : cause instanceof Error ? cause.message : String(cause);
    return refuse('tool_surface_unfingerprintable', message);
  }

  const memoryProjection = preparedMemoryProjection(input.agentMemory, input.memory, input.runtimeIdentity);
  for (const tool of memoryProjection.tools) {
    if (tools.some((existing) => existing.name === tool.name)) {
      return refuse('tool_surface_unfingerprintable', `SDK memory tool name ${JSON.stringify(tool.name)} collides with a Host MCP tool`);
    }
    tools.push(tool);
  }
  toolExecutors = Object.freeze({ ...toolExecutors, ...memoryProjection.toolExecutors });

  const bindingServers: PreparedToolBindingServerDigestInputV1[] = input.servers.map((server) => ({
    serverName: server.serverName,
    toolsetId: server.toolsetId,
    command: server.command,
    args: server.args,
  }));

  const toolBindingDigest = preparedToolBindingDigest({
    agentMemory: input.agentMemory,
    toolsetDefinitionRevisions: input.toolsetDefinitionRevisions,
    servers: bindingServers,
  });
  if (toolBindingDigest !== input.expectedToolBindingDigest) {
    return refuse(
      'tool_binding_drift',
      'the toolset revisions or configured argv of this device no longer match the ones the preparation froze',
    );
  }

  const observationDigest = preparedToolSurfaceObservationDigest({
    agentMemory: input.agentMemory,
    memory: input.memory,
    runtimeIdentity: input.runtimeIdentity,
    toolsetDefinitionRevisions: input.toolsetDefinitionRevisions,
    tools,
    toolExecutors,
  });
  if (observationDigest !== input.expectedObservationDigest) {
    return refuse(
      'tool_observation_drift',
      'the tool schemas or executor fingerprints observed for this launch differ from the ones the preparation counted',
    );
  }

  // Built only after both digests agree: a tool closure is an executable
  // capability, and there is no reason to construct one for a surface that has
  // already been refused.
  const piTools = [
    ...createPiMcpTools(projected, input.host, 'qualified'),
    ...(input.agentMemory === 'none' ? [] : createPreparedMemoryTools(input.agentMemory, input.memory!, input.memoryCall!)),
  ];
  const authorized: PreparedPiAuthorizedTool[] = [];
  for (const tool of piTools) {
    const identity = toolExecutors[tool.name];
    if (identity === undefined) {
      return refuse(
        'tool_surface_unfingerprintable',
        `no executor fingerprint was frozen for ${JSON.stringify(tool.name)}`,
      );
    }
    authorized.push(Object.freeze({ name: tool.name, identity, tool }));
  }

  return Object.freeze({
    ok: true as const,
    tools: Object.freeze(authorized),
    toolNames: Object.freeze(authorized.map((entry) => entry.name)),
    toolBindingDigest,
    observationDigest,
  });
}
