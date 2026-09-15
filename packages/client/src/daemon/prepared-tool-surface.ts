import type { PermissionMode, PermissionPolicy } from '@byok-sdk/protocol';
import {
  preparedToolBindingDigest,
  preparedToolSurfaceObservationDigest,
  type InputPreparationToolV1,
} from '../input-preparation';
import type { McpStdioServerConfig } from '../types';
import type { McpToolsetServerObservation } from '../mcp/observation';
import { classifyMcpToolsetServerObservation } from '../mcp/observation';
import { filterMcpObservationForPolicy, projectMcpTools, qualifiedMcpToolName } from '../mcp/projection';
import { buildToolExecutorsFromObservation, InputPreparationCompileError } from '../adapters/pi/input-preparation';
import { McpAuthorityError } from '../mcp/client';
import { computeEffectivePolicy } from './policy';
import { MCP_TOOLSET_PROBE_ADMISSION_TIMEOUT_MS, probeMcpServer } from './mcp-tools-probe';
import type { McpToolsetRegistry } from './toolset-registry';
import {
  mcpLaunchAttestation,
  resolveTrustedLaunchCwd,
  type McpLaunchAttestation,
  type McpLaunchBinding,
  type McpLaunchCwdConfig,
} from './trusted-launch-cwd';
import {
  resolveToolImplementationIdentity,
  type ToolImplementationAuthority,
  type ToolImplementationFsProbe,
  type ToolImplementationIdentityV1,
} from './tool-implementation-identity';

/**
 * The ONE place a prepared input's tool surface is assembled.
 *
 * Before this module there were two answers to "what tools does this device
 * have, and who executes them": `TaskRunner.handleOffer`, which resolved a
 * trusted launch directory, resolved one implementation identity per projected
 * server and probed each server through that binding; and the remote
 * preparation lane, which probed with a label, a timeout and an environment and
 * nothing else. The second one produced executor fingerprints for servers
 * launched in whatever directory the daemon happened to be in, under no
 * implementation claim at all — so a fingerprint frozen by a preparation and a
 * fingerprint frozen at admission could disagree for reasons neither side
 * recorded.
 *
 * This module is the single entry both preparation paths — the local
 * `input_preparation.prepare` control call and the remote
 * `agent.input.preparation` envelope — reach through
 * `InputPreparationService.prepare`. Nothing else in this package computes a
 * `tools` array or a `toolExecutors` map for a preparation.
 *
 * Two stages, split by whether they SPAWN anything:
 *
 * 1. {@link resolvePreparedToolBinding} — registry snapshot, trusted launch
 *    directory, launcher, and one implementation identity per projected
 *    server. It reads configuration and the filesystem; it starts no child.
 *    Its {@link PreparedToolBinding.toolBindingDigest} is what a replay of an
 *    already-recorded `requestId` is compared against, because re-probing to
 *    detect drift would be exactly the second executor fact the durable
 *    idempotency key exists to prevent.
 * 2. {@link assemblePreparedToolSurface} — the probe, the policy filter, the
 *    projection and the fingerprints. It calls stage 1 first and passes the
 *    resolved identity into every probe, so the shared pre-spawn gate in
 *    `mcp/client.ts` re-measures an attested server before its child starts.
 *
 * Fail-closed, and by VALUE rather than by exception: every refusal is a
 * `{ ok: false, code, detail }` the service maps straight onto a typed
 * rejection. A launch boundary that cannot be proven is never widened into a
 * spawn in an unproven directory, and an unobservable server is never widened
 * into a smaller manifest.
 */

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

/** Every way this module refuses. Each maps 1:1 onto an `InputPreparationErrorCodeV1`. */
export type PreparedToolSurfaceRefusalCode =
  /** A named toolset is not configured here, or its servers collide. */
  | 'unsupported_input'
  /** The declared permission mode exceeds this device's configured ceiling. */
  | 'permission_mode_denied'
  /** No non-writable launch directory / trusted launcher could be proven. */
  | 'launch_boundary_unavailable'
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
  /**
   * The operator's read/mutation classification for this server, or `null`
   * when its toolset declares none at all. A server whose toolset classifies
   * OTHER servers gets an empty list: the declaration exists and grants this
   * server nothing, which is a different fact from "nobody classified it".
   */
  readonly readOnlyTools: readonly string[] | null;
  readonly implementation: ToolImplementationIdentityV1;
}

/** Stage 1: everything that is knowable without starting a server. */
export interface PreparedToolBinding {
  readonly requiredToolsets: readonly string[];
  readonly launch: McpLaunchAttestation;
  /** `toolsetId` -> the registry's definition revision. Every named toolset appears. */
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
  /** Canonically ordered by server name. */
  readonly servers: readonly PreparedToolServerBinding[];
  /** Digest over the launch attestation, the definition revisions, the argv and the identities. */
  readonly toolBindingDigest: string;
  /**
   * The exact environment object every identity above was measured against,
   * carried forward so stage 2 spawns with the object stage 1 measured rather
   * than with a second `deps.runtimeEnv()` answer. Asking twice is how a
   * preparation measures one environment and starts its probe children in
   * another — `launch_env_drift` at the spawn gate, for a difference nobody
   * introduced on purpose.
   */
  readonly launchEnv: Readonly<Record<string, string>>;
}

/** Stage 2: the frozen tool surface one preparation is compiled and counted over. */
export interface PreparedToolSurface {
  readonly tools: readonly InputPreparationToolV1[];
  readonly toolExecutors: Readonly<Record<string, string>>;
  /** Digest over the tools, the executors, the launch attestation and the identities. */
  readonly observationDigest: string;
  readonly toolBindingDigest: string;
  readonly launch: McpLaunchAttestation;
  /** Model-visible tool name -> `attested` | `unavailable:<reason>`. */
  readonly toolImplementationKinds: Readonly<Record<string, string>>;
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
 * reaches the toolset registry, the launch-cwd config or the implementation
 * authority itself — and so a test can hand it an assembler that counts its own
 * probes.
 */
export interface PreparedToolSurfaceAssembler {
  /** Stage 1 only. Starts no server. */
  resolveBinding(input: { readonly requiredToolsets: readonly string[] }): Promise<PreparedToolBindingResult>;
  /** Stage 1 + stage 2. The only producer of a prepared `tools`/`toolExecutors` pair. */
  assemble(input: PreparedToolSurfaceInput): Promise<PreparedToolSurfaceResult>;
}

export interface PreparedToolSurfaceInput {
  readonly requiredToolsets: readonly string[];
  readonly permissionMode: PermissionMode;
  /** The resolved native runtime identity string every fingerprint binds. */
  readonly runtimeIdentity: string;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface PreparedToolSurfaceDeps {
  readonly toolsetRegistry: Pick<McpToolsetRegistry, 'snapshot' | 'status'>;
  /** The operator's `DaemonConfig.mcpLaunchCwd`, already validated. */
  readonly mcpLaunchCwd?: McpLaunchCwdConfig;
  /**
   * The exact base environment a RUNTIME child of a task receives
   * (`./environment.ts`'s `buildRuntimeEnv`) — never `process.env`. Resolved
   * per call so an operator's reload is not shadowed by a value captured at
   * construction.
   */
  readonly runtimeEnv: () => Readonly<Record<string, string>>;
  /**
   * `DaemonConfig.permissionDefaults` — the operator's policy ceiling, the
   * SAME value `TaskRunner.handleOffer` merges a task offer's `policy` against
   * (`task-runner.ts`'s `computeEffectivePolicy(payload.policy, ...)` call).
   * Absent means no ceiling is configured and every mode is admissible, which
   * is exactly what an offer means by it.
   */
  readonly permissionCeiling?: PermissionPolicy;
  /** `DaemonConfig.toolImplementationAuthority`. Absent means every identity is `resolver_unconfigured`. */
  readonly toolImplementationAuthority?: ToolImplementationAuthority;
  /** Test seam only; production passes nothing and the real `node:fs` probe is used. */
  readonly toolImplementationFsProbe?: ToolImplementationFsProbe;
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

/**
 * Resolve the launch binding for a preparation, with the SAME two functions
 * `TaskRunner.handleOffer` resolves an offer's binding with.
 *
 * The launcher half is resolved for the `direct-cwd` shape, because that is
 * what the runtime this preparation compiles for uses: the artifact is bound
 * to the verified installed pi closure (`adapters/pi/input-preparation.ts`),
 * and the pi adapter declares `mcpServerLaunch: 'direct-cwd'` — it hands the
 * directory to `spawn` and needs no launcher. A preparation that attested a
 * launcher the pi path never uses would produce fingerprints that can never
 * match the admission it is meant to be compared against.
 */
async function resolveLaunch(deps: PreparedToolSurfaceDeps): Promise<McpLaunchBinding | PreparedToolSurfaceRefusal> {
  const trusted = await resolveTrustedLaunchCwd(deps.mcpLaunchCwd);
  if (trusted.kind === 'unavailable') {
    return refuse(
      'launch_boundary_unavailable',
      `launch_boundary_unavailable:${trusted.reason}`,
      `no non-writable MCP launch directory could be proven on this device (${trusted.reason});`
        + ' a preparation never observes a server in a directory this uid can write',
    );
  }
  return Object.freeze({ cwd: trusted.dir });
}

export async function resolvePreparedToolBinding(
  deps: PreparedToolSurfaceDeps,
  input: { readonly requiredToolsets: readonly string[] },
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
    readOnlyTools: readonly string[] | null;
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
        readOnlyTools: toolset.readOnlyTools === undefined ? null : toolset.readOnlyTools[serverName] ?? [],
      });
    }
  }
  if (servers.size === 0) {
    return refuse(
      'unsupported_input',
      'required_toolsets_resolved_to_no_servers',
      'the required MCP toolsets resolved to no servers',
    );
  }

  const launchBinding = await resolveLaunch(deps);
  if ('ok' in launchBinding) return launchBinding;
  const launch = mcpLaunchAttestation(launchBinding);

  // Resolved ONCE per server, here, and consumed by the probe spawn below.
  // Resolution never refuses: this SDK ships no resolver, so the unconfigured
  // answer is `resolver_unconfigured` for every server and the preparation
  // still completes — it simply proves nothing about them, and the receipt
  // says so. What refuses is the re-measurement at spawn, and only for a
  // server that WAS attested.
  const resolved: PreparedToolServerBinding[] = [];
  // The exact environment the stage-2 probe spawns each server with, taken
  // ONCE and carried on the binding as `launchEnv`: the identity binds the
  // environment this SDK hands to `spawn`, so a second `deps.runtimeEnv()`
  // call could measure one value and spawn with another.
  const launchEnv = deps.runtimeEnv();
  for (const serverName of [...servers.keys()].sort(compareServerNames)) {
    const entry = servers.get(serverName)!;
    const implementation = await resolveToolImplementationIdentity(
      deps.toolImplementationAuthority,
      {
        toolsetId: entry.toolsetId,
        serverName,
        command: entry.server.command,
        args: Object.freeze([...(entry.server.args ?? [])]),
        launch,
      },
      launchEnv,
      deps.toolImplementationFsProbe,
    );
    resolved.push(Object.freeze({
      serverName,
      toolsetId: entry.toolsetId,
      server: entry.server,
      readOnlyTools: entry.readOnlyTools === null ? null : Object.freeze([...entry.readOnlyTools]),
      implementation,
    }));
  }

  // The formula itself lives in `../input-preparation.ts`, because the prepared
  // LAUNCH entry recomputes this same digest to decide whether the device still
  // matches the artifact (`adapters/pi/prepared-tools.ts`).
  const toolBindingDigest = preparedToolBindingDigest({
    launch,
    toolsetDefinitionRevisions,
    servers: resolved.map((entry) => ({
      serverName: entry.serverName,
      toolsetId: entry.toolsetId,
      command: entry.server.command,
      args: [...(entry.server.args ?? [])],
      implementation: entry.implementation,
    })),
  });

  return Object.freeze({
    ok: true as const,
    binding: Object.freeze({
      requiredToolsets: Object.freeze([...input.requiredToolsets]),
      launch,
      toolsetDefinitionRevisions: Object.freeze(toolsetDefinitionRevisions),
      servers: Object.freeze(resolved),
      toolBindingDigest,
      launchEnv,
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

function implementationKind(identity: ToolImplementationIdentityV1): string {
  return identity.kind === 'attested' ? 'attested' : `unavailable:${identity.reason}`;
}

/**
 * Assemble the frozen tool surface one preparation is compiled and counted
 * over.
 *
 * The policy filter runs BEFORE the projection, not only before the
 * fingerprints: the tools the model is shown and the executors the manifest
 * binds must be the same set, and projecting the unfiltered observation while
 * fingerprinting the filtered one is how a manifest ends up narrower than the
 * schemas that were counted.
 */
export async function assemblePreparedToolSurface(
  deps: PreparedToolSurfaceDeps,
  input: PreparedToolSurfaceInput,
): Promise<PreparedToolSurfaceResult> {
  // ADMISSION, before anything else — before a directory is probed for
  // writability and long before a server is started.
  //
  // The requester's `permissionMode` is INTENT. Turning it into an admitted
  // mode is the same merge a task offer goes through (`./policy.ts`'s
  // `computeEffectivePolicy`, which `TaskRunner.handleOffer` calls with the
  // very same `permissionDefaults` ceiling), so a preparation cannot be
  // counted for a mode this device would refuse to run. Parsing the enum is
  // not admission; a device that accepted any well-formed mode would be
  // counting manifests it has no authority to produce.
  //
  // A refused mode is REFUSED, never narrowed: a preparation counts one
  // concrete manifest, and silently counting the ceiling's narrower one would
  // answer a question nobody asked while looking like success.
  const admitted = computeEffectivePolicy({ mode: input.permissionMode }, deps.permissionCeiling);
  if (!admitted.ok) {
    return refuse('permission_mode_denied', 'permission_mode_denied', admitted.reason ?? 'the declared permission mode is not admissible on this device');
  }
  if (admitted.policy.mode !== input.permissionMode) {
    // `computeEffectivePolicy` does not lower a mode today; this is the guard
    // that keeps a future merge from turning a refusal into a downgrade
    // nobody notices.
    return refuse(
      'permission_mode_denied',
      'permission_mode_downgrade_refused',
      `this device admitted mode ${JSON.stringify(admitted.policy.mode)} for a preparation declared as`
        + ` ${JSON.stringify(input.permissionMode)}; a preparation is never counted for a mode it did not declare`,
    );
  }

  const bound = await resolvePreparedToolBinding(deps, input);
  if (!bound.ok) return bound;
  const binding = bound.binding;

  const probe = deps.probe ?? probeMcpServer;
  // The environment stage 1 MEASURED the identities against, not a fresh
  // `deps.runtimeEnv()` answer: the identity binds the object handed to
  // `spawn`, so asking again here could measure one value and spawn with
  // another.
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
      // The trusted directory, and the implementation identity resolved above.
      // `mcp/client.ts`'s connect gate re-measures an attested one before this
      // child starts; a failure is an `McpAuthorityError`.
      cwd: binding.launch.launchCwd,
      implementation: entry.implementation,
    });
    if (observation.tools.length === 0) {
      throw new McpAuthorityError(`MCP toolset server "${entry.serverName}" reported no tools`);
    }
    return [
      entry.serverName,
      classifyMcpToolsetServerObservation(observation, {
        toolsetId: entry.toolsetId,
        readOnlyTools: entry.readOnlyTools,
      }),
    ] as const;
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

  const implementations: Record<string, ToolImplementationIdentityV1> = {};
  for (const entry of binding.servers) implementations[entry.serverName] = entry.implementation;

  const fingerprinted = await fingerprintPreparedToolSurface({
    observation,
    permissionMode: input.permissionMode,
    runtimeIdentity: input.runtimeIdentity,
    launch: binding.launch,
    toolsetDefinitionRevisions: binding.toolsetDefinitionRevisions,
    implementations: Object.freeze(implementations),
  });
  if (!fingerprinted.ok) return fingerprinted;

  return Object.freeze({
    ok: true as const,
    surface: Object.freeze({
      tools: fingerprinted.fingerprint.tools,
      toolExecutors: fingerprinted.fingerprint.toolExecutors,
      observationDigest: fingerprinted.fingerprint.observationDigest,
      toolBindingDigest: binding.toolBindingDigest,
      launch: binding.launch,
      toolImplementationKinds: fingerprinted.fingerprint.toolImplementationKinds,
      toolsetDefinitionRevisions: binding.toolsetDefinitionRevisions,
    }),
  });
}

// ---------------------------------------------------------------------------
// Stage 2a — the fingerprint, over an observation somebody else already made
// ---------------------------------------------------------------------------

/** Everything the fingerprint binds, for one already-probed observation. */
export interface PreparedToolSurfaceFingerprintInput {
  /** The live, already-classified `tools/list` answer for exactly the projected servers. */
  readonly observation: Readonly<Record<string, McpToolsetServerObservation>>;
  readonly permissionMode: PermissionMode;
  /** The resolved native runtime identity string every fingerprint binds. */
  readonly runtimeIdentity: string;
  readonly launch: McpLaunchAttestation;
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
  readonly implementations: Readonly<Record<string, ToolImplementationIdentityV1>>;
}

/** The policy-filtered projection of one observation, plus the digest over it. */
export interface PreparedToolSurfaceFingerprint {
  readonly tools: readonly InputPreparationToolV1[];
  readonly toolExecutors: Readonly<Record<string, string>>;
  readonly observationDigest: string;
  /** Model-visible tool name -> `attested` | `unavailable:<reason>`. */
  readonly toolImplementationKinds: Readonly<Record<string, string>>;
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
 *
 * The policy filter runs BEFORE the projection, not only before the
 * fingerprints: the tools the model is shown and the executors the manifest
 * binds must be the same set, and projecting the unfiltered observation while
 * fingerprinting the filtered one is how a manifest ends up narrower than the
 * schemas that were counted.
 */
export async function fingerprintPreparedToolSurface(
  input: PreparedToolSurfaceFingerprintInput,
): Promise<PreparedToolSurfaceFingerprintResult> {
  // One policy resolution, reused for every half below.
  const allowed = filterMcpObservationForPolicy(input.observation, input.permissionMode);
  if (!allowed.ok) {
    return refuse('unsupported_input', 'permission_mode_policy_inexpressible', allowed.reason);
  }

  const tools: InputPreparationToolV1[] = projectMcpTools(allowed.observation).map((tool) => ({
    name: qualifiedMcpToolName(tool.serverName, tool.toolName),
    description: tool.description,
    // No `?? {}` fallback: `mcp/observation.ts`'s `validateTool` already
    // refuses a tool whose `inputSchema` is absent or is not a JSON object, so
    // an empty-schema default here would count a schema no model was shown.
    parameters: tool.inputSchema as Readonly<Record<string, unknown>>,
  }));

  let toolExecutors: Readonly<Record<string, string>>;
  try {
    ({ toolExecutors } = await buildToolExecutorsFromObservation({
      observation: input.observation,
      permissionMode: input.permissionMode,
      toolsetDefinitionRevisions: input.toolsetDefinitionRevisions,
      launch: input.launch,
      implementations: input.implementations,
      // PARTIAL — the prepared NATIVE tool set is not connected to preparation
      // yet. Pi's own tools are selected by a runtime policy that is resolved
      // from a task's workspace and descriptor, and a task-free preparation has
      // neither; inventing one here would put a tool in the counted manifest
      // that no authority admitted. The final Main set (Q1 = policy-filtered
      // native + MCP) therefore remains the runtime's decision, and a
      // preparation counts the MCP half only. Removing this limit means giving
      // this entry the runtime policy input — and changing the test that pins
      // this state.
      nativeTools: [],
      runtimeIdentity: input.runtimeIdentity,
    }));
  } catch (cause) {
    if (cause instanceof InputPreparationCompileError) {
      return refuse('unsupported_input', 'tool_surface_unfingerprintable', cause.message);
    }
    return refuse('unsupported_input', 'tool_surface_unfingerprintable', errorMessage(cause));
  }

  const toolImplementationKinds: Record<string, string> = {};
  for (const tool of projectMcpTools(allowed.observation)) {
    const identity = input.implementations[tool.serverName];
    toolImplementationKinds[qualifiedMcpToolName(tool.serverName, tool.toolName)] =
      identity === undefined ? 'unavailable:implementation_identity_unattested' : implementationKind(identity);
  }

  const observationDigest = preparedToolSurfaceObservationDigest({
    launch: input.launch,
    permissionMode: input.permissionMode,
    runtimeIdentity: input.runtimeIdentity,
    toolsetDefinitionRevisions: input.toolsetDefinitionRevisions,
    tools,
    toolExecutors,
    implementations: input.implementations,
    // PARTIAL, for the same reason `nativeTools: []` above is: this entry
    // assembles no native half, so there is no admitted policy selection to
    // bind. The day the native half becomes countable here, the selection and
    // the policy that produced it are bound by passing `nativeSelection`.
  });

  return Object.freeze({
    ok: true as const,
    fingerprint: Object.freeze({
      tools: Object.freeze(tools),
      toolExecutors,
      observationDigest,
      toolImplementationKinds: Object.freeze(toolImplementationKinds),
    }),
  });
}

/** Bind one set of dependencies into the assembler the service is constructed with. */
export function createPreparedToolSurfaceAssembler(deps: PreparedToolSurfaceDeps): PreparedToolSurfaceAssembler {
  return Object.freeze({
    resolveBinding: (input: { readonly requiredToolsets: readonly string[] }) =>
      resolvePreparedToolBinding(deps, input),
    assemble: (input: PreparedToolSurfaceInput) => assemblePreparedToolSurface(deps, input),
  });
}
