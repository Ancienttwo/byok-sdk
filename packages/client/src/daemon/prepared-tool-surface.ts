import type { PreparedAgentMemoryMode } from '@byok-sdk/protocol';
import { observePreparedMemory, preparedMemoryProjection, type PreparedAgentMemoryHelper, type PreparedAgentMemoryState } from './prepared-agent-memory';
import { projectPiMcpEnvironment } from '../adapters/pi/mcp-environment';
import {
  preparedToolBindingDigest,
  preparedToolSurfaceObservationDigest,
  type InputPreparationToolV1,
} from '../input-preparation';
import type { McpStdioServerConfig } from '../types';
import type { McpToolsetServerObservation } from '../mcp/observation';
import { bindMcpToolsetServerObservation } from '../mcp/observation';
import { projectMcpTools, qualifiedMcpToolName, type McpToolProjection } from '../mcp/projection';
import { buildToolExecutorsFromObservation, InputPreparationCompileError } from '../adapters/pi/input-preparation';
import { McpAuthorityError } from '../mcp/client';
import { MCP_TOOLSET_PROBE_ADMISSION_TIMEOUT_MS, probeMcpServer } from './mcp-tools-probe';
import type { McpToolsetRegistry } from './toolset-registry';

/**
 * The ONE place a prepared input's tool surface is assembled.
 *
 * This module is the single entry both preparation paths — the local
 * `input_preparation.prepare` control call and the remote
 * `agent.input.preparation` envelope — reach through
 * `InputPreparationService.prepare`. Nothing else in this package computes a
 * `tools` array or a `toolExecutors` map for a preparation.
 *
 * Two stages, split by whether they SPAWN anything:
 *
 * 1. {@link resolvePreparedToolBinding} — registry snapshot and the
 *    configured argv per projected server. It reads configuration; it starts no child.
 *    Its {@link PreparedToolBinding.toolBindingDigest} is what a replay of an
 *    already-recorded `requestId` is compared against, because re-probing to
 *    detect drift would be exactly the second executor fact the durable
 *    idempotency key exists to prevent.
 * 2. {@link assemblePreparedToolSurface} — the probe, the projection and the
 *    fingerprints. It calls stage 1 first.
 *
 * Fail-closed, and by VALUE rather than by exception: every refusal is a
 * `{ ok: false, code, detail }` the service maps straight onto a typed
 * rejection. An unobservable server is never widened into a smaller manifest.
 */

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** Every way this module refuses. Each maps 1:1 onto an `InputPreparationErrorCodeV1`. */
export type PreparedToolSurfaceRefusalCode =
  /** A named toolset is not configured here, or its servers collide. */
  | 'unsupported_input'
  /** A required server could not be observed, or its answer is ungrantable. */
  | 'toolsets_unobservable';

export interface PreparedToolSurfaceRefusal {
  readonly ok: false;
  readonly code: PreparedToolSurfaceRefusalCode;
  /**
   * A stable code, never provider or stack text — it is written into the
   * durable record's `detail` and reported on the receipt.
   */
  readonly detail: string;
  readonly message: string;
}

/** One projected server, as the binding stage resolved it. */
export interface PreparedToolServerBinding {
  readonly serverName: string;
  readonly toolsetId: string;
  /** Exactly `{command, args}` — the same reduction `TaskRunner` projects. */
  readonly server: Readonly<McpStdioServerConfig>;
}

/** Stage 1: everything that is knowable without starting a server. */
export interface PreparedToolBinding {
  readonly agentMemory: PreparedAgentMemoryMode;
  readonly requiredToolsets: readonly string[];
  /** `toolsetId` -> the registry's definition revision. Every named toolset appears. */
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
  /** Canonically ordered by server name. */
  readonly servers: readonly PreparedToolServerBinding[];
  /** Digest over the definition revisions and the argv. */
  readonly toolBindingDigest: string;
  /** The exact environment stage 2 starts its probe children with, read once. */
  readonly launchEnv: Readonly<Record<string, string>>;
}

/** Stage 2: the frozen tool surface one preparation is compiled and counted over. */
export interface PreparedToolSurface {
  readonly memory: PreparedAgentMemoryState | null;
  readonly tools: readonly InputPreparationToolV1[];
  readonly toolExecutors: Readonly<Record<string, string>>;
  /** Digest over the tools and the executors. */
  readonly observationDigest: string;
  readonly toolBindingDigest: string;
  /** The counted model-visible tool names, sorted byte-wise. */
  readonly toolNames: readonly string[];
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
}

export type PreparedToolBindingResult =
  | { readonly ok: true; readonly binding: PreparedToolBinding }
  | PreparedToolSurfaceRefusal;

export type PreparedToolSurfaceResult =
  | { readonly ok: true; readonly surface: PreparedToolSurface }
  | PreparedToolSurfaceRefusal;

/**
 * The seam `input-preparation-service.ts` depends on.
 *
 * Declared as an interface the daemon implements once, so the service never
 * reaches the toolset registry itself — and so a test can hand it an assembler
 * that counts its own probes.
 */
export interface PreparedToolSurfaceAssembler {
  /** Stage 1 only. Starts no server. */
  resolveBinding(input: { readonly requiredToolsets: readonly string[]; readonly agentMemory: PreparedAgentMemoryMode }): Promise<PreparedToolBindingResult>;
  /** Stage 1 + stage 2. The only producer of a prepared `tools`/`toolExecutors` pair. */
  assemble(input: PreparedToolSurfaceInput): Promise<PreparedToolSurfaceResult>;
}

export interface PreparedToolSurfaceInput {
  readonly agentMemory: PreparedAgentMemoryMode;
  readonly requiredToolsets: readonly string[];
  /** The resolved native runtime identity string every fingerprint binds. */
  readonly runtimeIdentity: string;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface PreparedToolSurfaceDeps {
  readonly memoryAvailable?: () => boolean;
  /** The SDK Agent-memory descriptor helper. Absent means prepared memory is unavailable. */
  readonly agentMemoryDescribe?: PreparedAgentMemoryHelper;
  readonly toolsetRegistry: Pick<McpToolsetRegistry, 'snapshot' | 'status'>;
  /**
   * The exact base environment a RUNTIME child of a task receives
   * (`./environment.ts`'s `buildRuntimeEnv`) — never `process.env`. Resolved
   * per call so an operator's reload is not shadowed by a value captured at
   * construction.
   */
  readonly runtimeEnv: () => Readonly<Record<string, string>>;
  /** Test seam only, the same one `TaskRunnerDeps.mcpToolsetToolsProbe` is. */
  readonly probe?: typeof probeMcpServer;
  readonly probeTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Stage 1 — no spawn
// ---------------------------------------------------------------------------

function refuse(
  code: PreparedToolSurfaceRefusalCode,
  detail: string,
  message: string,
): PreparedToolSurfaceRefusal {
  return Object.freeze({ ok: false as const, code, detail, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function resolvePreparedToolBinding(
  deps: PreparedToolSurfaceDeps,
  input: { readonly requiredToolsets: readonly string[]; readonly agentMemory: PreparedAgentMemoryMode },
): Promise<PreparedToolBindingResult> {
  // ONE immutable snapshot of the registry, taken here and read for the whole
  // resolution. A `toolsets.reload` landing mid-resolution must not be able to
  // contribute a definition revision from one state and a server list from
  // another.
  const snapshot = deps.toolsetRegistry.snapshot();
  const status = deps.toolsetRegistry.status();
  const revisionByToolsetId = new Map(status.toolsets.map((row) => [row.id as string, row.definitionRevision]));

  const toolsetDefinitionRevisions: Record<string, string> = {};
  const servers = new Map<string, {
    toolsetId: string;
    server: Readonly<McpStdioServerConfig>;
  }>();
  for (const toolsetId of input.requiredToolsets) {
    const toolset = snapshot.toolsets.get(toolsetId);
    const definitionRevision = revisionByToolsetId.get(toolsetId);
    if (toolset === undefined || definitionRevision === undefined) {
      return refuse(
        'unsupported_input',
        'required_toolset_unconfigured',
        `required MCP toolset ${JSON.stringify(toolsetId)} is not configured on this device`,
      );
    }
    toolsetDefinitionRevisions[toolsetId] = definitionRevision;
    for (const [serverName, server] of Object.entries(toolset.mcpServers)) {
      if (servers.has(serverName)) {
        return refuse(
          'unsupported_input',
          'required_toolset_server_name_collision',
          `required MCP toolsets collide on server name ${JSON.stringify(serverName)}`,
        );
      }
      servers.set(serverName, {
        toolsetId,
        // Reduced to `{command, args}`, exactly as `TaskRunner` projects it:
        // the fingerprint binds the argv that is spawned, and a server's `env`
        // is task-scoped authority that is not part of its identity.
        server: Object.freeze({
          command: server.command,
          ...(server.args === undefined ? {} : { args: Object.freeze([...server.args]) }),
        }),
      });
    }
  }
  // No servers AND no memory is a valid counted manifest: a tool-less record.
  if (input.agentMemory !== 'none' && (deps.memoryAvailable?.() !== true || deps.agentMemoryDescribe === undefined)) {
    return refuse('unsupported_input', 'agent_memory_unavailable', 'secure Agent memory is unavailable');
  }
  const resolved: PreparedToolServerBinding[] = [...servers.keys()].sort(compareServerNames).map((serverName) => {
    const entry = servers.get(serverName)!;
    return Object.freeze({ serverName, toolsetId: entry.toolsetId, server: entry.server });
  });

  // The formula itself lives in `../input-preparation.ts`, because the prepared
  // LAUNCH entry recomputes this same digest to decide whether the device still
  // matches the artifact (`adapters/pi/prepared-tools.ts`).
  const toolBindingDigest = preparedToolBindingDigest({
    agentMemory: input.agentMemory,
    toolsetDefinitionRevisions,
    servers: resolved.map((entry) => ({
      serverName: entry.serverName,
      toolsetId: entry.toolsetId,
      command: entry.server.command,
      args: [...(entry.server.args ?? [])],
    })),
  });

  return Object.freeze({
    ok: true as const,
    binding: Object.freeze({
      agentMemory: input.agentMemory,
      requiredToolsets: Object.freeze([...input.requiredToolsets]),
      toolsetDefinitionRevisions: Object.freeze(toolsetDefinitionRevisions),
      servers: Object.freeze(resolved),
      toolBindingDigest,
      launchEnv: projectPiMcpEnvironment(deps.runtimeEnv()),
    }),
  });
}

/** Byte order, so the canonical ordering does not depend on the host locale. */
function compareServerNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Stage 2 — the one assembly entry
// ---------------------------------------------------------------------------

/** Assemble the frozen tool surface one preparation is compiled and counted over. */
export async function assemblePreparedToolSurface(
  deps: PreparedToolSurfaceDeps,
  input: PreparedToolSurfaceInput,
): Promise<PreparedToolSurfaceResult> {
  const bound = await resolvePreparedToolBinding(deps, input);
  if (!bound.ok) return bound;
  const binding = bound.binding;

  const probe = deps.probe ?? probeMcpServer;
  const env = binding.launchEnv;
  const timeoutMs = deps.probeTimeoutMs ?? MCP_TOOLSET_PROBE_ADMISSION_TIMEOUT_MS;
  // All servers concurrently under one shared deadline, the same budget
  // admission uses: a serial loop would multiply the timeout by the server
  // count. One failure refuses the whole preparation — a partial tool set is
  // not a smaller preparation, it is a different one.
  const settled = await Promise.allSettled(binding.servers.map(async (entry) => {
    const observation = await probe(entry.serverName, entry.server, {
      label: `MCP toolset server "${entry.serverName}"`,
      timeoutMs,
      env,
    });
    if (observation.tools.length === 0) {
      throw new McpAuthorityError(`MCP toolset server "${entry.serverName}" reported no tools`);
    }
    return [entry.serverName, bindMcpToolsetServerObservation(observation, entry.toolsetId)] as const;
  }));

  const observed: Record<string, McpToolsetServerObservation> = {};
  for (let index = 0; index < binding.servers.length; index += 1) {
    const entry = binding.servers[index]!;
    const result = settled[index]!;
    if (result.status === 'rejected') {
      return refuse(
        'toolsets_unobservable',
        'toolset_server_unobservable',
        `required MCP toolset server ${JSON.stringify(entry.serverName)} could not be observed: ${errorMessage(result.reason)}`,
      );
    }
    observed[result.value[0]] = result.value[1];
  }
  const observation = Object.freeze(observed);

  let memory: PreparedAgentMemoryState | null = null;
  if (binding.agentMemory !== 'none') {
    try { memory = await observePreparedMemory(deps.agentMemoryDescribe!, env); }
    catch (error) { return refuse('toolsets_unobservable', 'agent_memory_descriptor_unobservable', errorMessage(error)); }
  }
  const fingerprinted = await fingerprintPreparedToolSurface({
    agentMemory: input.agentMemory, memory,
    observation,
    runtimeIdentity: input.runtimeIdentity,
    toolsetDefinitionRevisions: binding.toolsetDefinitionRevisions,
  });
  if (!fingerprinted.ok) return fingerprinted;

  return Object.freeze({
    ok: true as const,
    surface: Object.freeze({
      memory,
      tools: fingerprinted.fingerprint.tools,
      toolExecutors: fingerprinted.fingerprint.toolExecutors,
      observationDigest: fingerprinted.fingerprint.observationDigest,
      toolBindingDigest: binding.toolBindingDigest,
      toolNames: fingerprinted.fingerprint.toolNames,
      toolsetDefinitionRevisions: binding.toolsetDefinitionRevisions,
    }),
  });
}

// ---------------------------------------------------------------------------
// Stage 2a — the fingerprint, over an observation somebody else already made
// ---------------------------------------------------------------------------

/** Everything the fingerprint binds, for one already-probed observation. */
export interface PreparedToolSurfaceFingerprintInput {
  readonly agentMemory: PreparedAgentMemoryMode;
  readonly memory: PreparedAgentMemoryState | null;
  /** The live `tools/list` answer for exactly the projected servers. */
  readonly observation: Readonly<Record<string, McpToolsetServerObservation>>;
  /** The resolved native runtime identity string every fingerprint binds. */
  readonly runtimeIdentity: string;
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
}

/** The projection of one observation, plus the digest over it. */
export interface PreparedToolSurfaceFingerprint {
  readonly tools: readonly InputPreparationToolV1[];
  readonly toolExecutors: Readonly<Record<string, string>>;
  readonly observationDigest: string;
  /** The model-visible tool names, sorted byte-wise. */
  readonly toolNames: readonly string[];
}

export type PreparedToolSurfaceFingerprintResult =
  | { readonly ok: true; readonly fingerprint: PreparedToolSurfaceFingerprint }
  | PreparedToolSurfaceRefusal;

/**
 * Project and fingerprint one observation — the half of the assembly above that
 * does not probe.
 *
 * Split out because a prepared LAUNCH has to answer the same question the
 * preparation did ("what tools, what executors, what digest") about a DIFFERENT
 * observation: the live one the task's own admission probe just made
 * (`TaskRunner.handleOffer`). Both sides must reach the same answer for the same
 * facts, and the only way to guarantee that is for both to run this code. A
 * launch-side reimplementation would be a second definition of the counted
 * manifest, and the two could drift for a whole release without anything
 * noticing — which is precisely the class of bug the digests exist to catch.
 */
export async function fingerprintPreparedToolSurface(
  input: PreparedToolSurfaceFingerprintInput,
): Promise<PreparedToolSurfaceFingerprintResult> {
  // One projection, reused for every half below.
  let projected: readonly McpToolProjection[];
  try {
    projected = projectMcpTools(input.observation);
  } catch (error) {
    if (error instanceof McpAuthorityError) return refuse('unsupported_input', 'tool_surface_unfingerprintable', error.message);
    throw error;
  }

  const tools: InputPreparationToolV1[] = projected.map((tool) => ({
    name: qualifiedMcpToolName(tool.serverName, tool.toolName),
    description: tool.description,
    // No `?? {}` fallback: `mcp/observation.ts`'s `validateTool` already
    // refuses a tool whose `inputSchema` is absent or is not a JSON object, so
    // an empty-schema default here would count a schema no model was shown.
    parameters: tool.inputSchema as Readonly<Record<string, unknown>>,
    // `constrainedSampling` is carried from the real tool definition and from
    // nothing else. The MCP tool contract declares none, so it stays ABSENT
    // here, which is the honest statement that this server said nothing about
    // constrained sampling — not `false`, which would be this device deciding
    // it off on the server's behalf and changing the bytes the model is shown.
    // `adapters/pi/prepared-tools.ts` projects the same observation the same
    // way, so a launch cannot reach a different declaration than the count did.
  }));

  let toolExecutors: Readonly<Record<string, string>>;
  try {
    ({ toolExecutors } = await buildToolExecutorsFromObservation({
      observation: input.observation,
      toolsetDefinitionRevisions: input.toolsetDefinitionRevisions,
      // The prepared Main set is MCP tools only: a task-free preparation has
      // no workspace to resolve Pi's own built-ins against, and the prepared
      // launch registers the same MCP-only set (`adapters/pi/prepared-tools.ts`).
      nativeTools: [],
      runtimeIdentity: input.runtimeIdentity,
    }));
  } catch (cause) {
    if (cause instanceof InputPreparationCompileError) {
      return refuse('unsupported_input', 'tool_surface_unfingerprintable', cause.message);
    }
    return refuse('unsupported_input', 'tool_surface_unfingerprintable', errorMessage(cause));
  }

  const memoryProjection = preparedMemoryProjection(input.agentMemory, input.memory, input.runtimeIdentity);
  for (const tool of memoryProjection.tools) {
    if (tools.some(existing => existing.name === tool.name)) return refuse('unsupported_input', 'tool_name_collision', 'memory tool name collision');
    tools.push(tool);
  }
  toolExecutors = Object.freeze({...toolExecutors, ...memoryProjection.toolExecutors});
  const observationDigest = preparedToolSurfaceObservationDigest({
    agentMemory: input.agentMemory, memory: input.memory,
    runtimeIdentity: input.runtimeIdentity,
    toolsetDefinitionRevisions: input.toolsetDefinitionRevisions,
    tools,
    toolExecutors,
  });

  return Object.freeze({
    ok: true as const,
    fingerprint: Object.freeze({
      tools: Object.freeze(tools),
      toolExecutors,
      observationDigest,
      toolNames: Object.freeze(tools.map((tool) => tool.name).sort(compareServerNames)),
    }),
  });
}

/** Bind one set of dependencies into the assembler the service is constructed with. */
export function createPreparedToolSurfaceAssembler(deps: PreparedToolSurfaceDeps): PreparedToolSurfaceAssembler {
  return Object.freeze({
    resolveBinding: (input: { readonly requiredToolsets: readonly string[]; readonly agentMemory: PreparedAgentMemoryMode }) =>
      resolvePreparedToolBinding(deps, input),
    assemble: (input: PreparedToolSurfaceInput) => assemblePreparedToolSurface(deps, input),
  });
}
