import type { PermissionMode, PermissionPolicy } from '@byok-sdk/protocol';
import {
  preparedToolBindingDigest,
  preparedToolSurfaceObservationDigest,
  type InputPreparationToolV1,
  type PreparedNativeToolSelectionV1,
  type PreparedToolBindingServerDigestInputV1,
} from '../../input-preparation';
import type { McpToolsetServerObservation } from '../../mcp/observation';
import { filterMcpObservationForPolicy, projectMcpTools, qualifiedMcpToolName } from '../../mcp/projection';
import type { McpLaunchAttestation } from '../../daemon/trusted-launch-cwd';
import type { ToolImplementationIdentityV1 } from '../../daemon/tool-implementation-identity';
import { buildToolExecutorsFromObservation, InputPreparationCompileError } from './input-preparation';
import { createPiMcpTools, type McpToolCallHost, type PiMcpToolDefinition } from './mcp-tools';
import { resolvePiNativeToolSelection } from './permission-mapping';

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
 * the policy filter and the projection come from the shared core, and the Pi
 * tool shapes come from `./mcp-tools.ts` — the same function the ordinary
 * extension registers from. An entry allowed to re-derive its own tool set
 * would make "the prepared session sees what was counted" a coincidence.
 *
 * ## The native half is PARTIAL, and this is the launch side of that
 *
 * Q1 fixes the prepared Main tool set as "policy-filtered native tools + MCP
 * toolset tools". `daemon/prepared-tool-surface.ts` still assembles a
 * preparation with `nativeTools: []`, because a task-free preparation has no
 * workspace and no descriptor to resolve a runtime policy from. The counted
 * manifest therefore contains the MCP half only.
 *
 * The native API is NOT the limitation: `createAgentSession({ tools, customTools })`
 * (`./prepared-session.ts`) would accept Pi's own built-ins beside the MCP tools.
 * What is missing is on this side: nothing counted them, so registering them
 * here would send the model a tool the artifact's frozen manifest does not
 * contain, and the prepared session refuses the whole run with
 * `prepared_registry_drift`.
 *
 * So the selection is resolved for real, from the WHOLE admitted policy rather
 * than from its mode ({@link resolvePiNativeToolSelection}), and a non-empty
 * result is REFUSED by name instead of being quietly dropped. When the
 * preparation side gains the runtime policy input, the same selection and the
 * policy that produced it are bound into the observation digest through
 * {@link PreparedNativeToolSelectionV1}, and only the refusal below goes away.
 */

/** One authorized tool: the name and executor identity the manifest binds, and its Pi tool definition. */
export interface PreparedPiAuthorizedTool {
  readonly name: string;
  /** The observation fingerprint the counted manifest bound for this name. */
  readonly identity: string;
  readonly tool: PiMcpToolDefinition;
}

export type PreparedPiToolSurfaceRefusalCode =
  /** The admitted policy is one the pi runtime cannot express at all. */
  | 'policy_inexpressible'
  /** The admitted policy selects Pi-native tools, which no preparation counts yet. */
  | 'native_tools_uncounted'
  /** The policy mode differs from the mode the manifest was counted for. */
  | 'permission_mode_mismatch'
  /** The observation cannot be filtered or fingerprinted at all. */
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
  /** The manifest's sealed policy, whole. Native selection reads all of it, not just the mode. */
  readonly policy: PermissionPolicy;
  /** The mode `daemon/prepared-tool-surface.ts` filtered the counted manifest for. */
  readonly countedPermissionMode: PermissionMode;
  /** The daemon's frozen observation, unfiltered. The policy is applied here. */
  readonly observation: Readonly<Record<string, McpToolsetServerObservation>>;
  /** `toolsetId` -> the registry definition revision the preparation bound. */
  readonly toolsetDefinitionRevisions: Readonly<Record<string, string>>;
  /** Canonically ordered by server name, exactly as the preparation ordered them. */
  readonly servers: readonly PreparedPiServerBinding[];
  readonly launch: McpLaunchAttestation;
  readonly toolImplementations: Readonly<Record<string, ToolImplementationIdentityV1>>;
  /** The verified installed native closure identity string. */
  readonly runtimeIdentity: string;
  /** What the durable record says this preparation froze. */
  readonly expectedToolBindingDigest: string;
  readonly expectedObservationDigest: string;
  /** How a registered tool reaches its server — the shared pool, never a second client. */
  readonly host: McpToolCallHost;
}

function refuse(code: PreparedPiToolSurfaceRefusalCode, message: string): PreparedPiToolSurfaceRefusal {
  return Object.freeze({ ok: false as const, code, message });
}

export interface PreparedPiNativeSelection {
  readonly ok: true;
  /** Absent when the admitted policy selects no native tool at all. */
  readonly selection: PreparedNativeToolSelectionV1 | undefined;
}

/**
 * Resolve the Pi-native half of a prepared Main tool set from the whole
 * admitted policy.
 *
 * Exported so the refusal below and a future countable native half read the
 * same selection, and so a test can pin that `allowTools`/`denyTools` — not
 * just `mode` — decide it.
 */
export function preparedNativeToolSelection(
  policy: PermissionPolicy,
): PreparedPiNativeSelection | PreparedPiToolSurfaceRefusal {
  const resolved = resolvePiNativeToolSelection(policy);
  if (!resolved.ok) {
    return refuse('policy_inexpressible', resolved.reason);
  }
  if (resolved.names.length === 0) return Object.freeze({ ok: true as const, selection: undefined });
  return Object.freeze({
    ok: true as const,
    selection: Object.freeze({
      names: Object.freeze([...resolved.names]),
      policy: Object.freeze({
        mode: policy.mode,
        ...(policy.allowTools === undefined ? {} : { allowTools: Object.freeze([...policy.allowTools]) }),
        ...(policy.denyTools === undefined ? {} : { denyTools: Object.freeze([...policy.denyTools]) }),
      }),
    }),
  });
}

/** Admission and launch share the same refusal before a preparation can be consumed. */
export function validatePreparedPiNativeToolPolicy(
  policy: PermissionPolicy,
): { readonly ok: true } | PreparedPiToolSurfaceRefusal {
  const native = preparedNativeToolSelection(policy);
  if (!native.ok) return native;
  const selection = native.selection;
  if (selection !== undefined) {
    // See the module comment: the session would take these tools, but no
    // preparation counted them, so registering them is guaranteed drift.
    return refuse(
      'native_tools_uncounted',
      `the admitted policy selects the pi-native tools [${selection.names.join(', ')}], and no preparation counts a`
      + ' native tool set yet (daemon/prepared-tool-surface.ts assembles `nativeTools: []`); a prepared launch is'
      + ' only assembled for a policy whose native half is empty',
    );
  }

  return { ok: true };
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
  // The counted manifest is the policy-filtered set for exactly ONE mode. A
  // task admitted under a different mode registers a different set, so it is
  // refused here rather than discovered later as tool drift with no explanation.
  if (input.policy.mode !== input.countedPermissionMode) {
    return refuse(
      'permission_mode_mismatch',
      `this operation was admitted under permission mode ${JSON.stringify(input.policy.mode)} but its prepared`
      + ` manifest was counted for ${JSON.stringify(input.countedPermissionMode)}`,
    );
  }

  const native = validatePreparedPiNativeToolPolicy(input.policy);
  if (!native.ok) return native;

  const allowed = filterMcpObservationForPolicy(input.observation, input.countedPermissionMode);
  if (!allowed.ok) return refuse('tool_surface_unfingerprintable', allowed.reason);

  // The SAME projection, in the SAME order, that the preparation counted and
  // that the ordinary extension registers.
  const projected = projectMcpTools(allowed.observation);
  if (projected.length === 0) {
    return refuse('tool_surface_unfingerprintable', 'the admitted observation projects no tools at all');
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
      permissionMode: input.countedPermissionMode,
      toolsetDefinitionRevisions: input.toolsetDefinitionRevisions,
      launch: input.launch,
      implementations: input.toolImplementations,
      // Empty for the same reason the preparation's is; the refusal above is
      // what keeps the two from disagreeing silently.
      nativeTools: [],
      runtimeIdentity: input.runtimeIdentity,
    }));
  } catch (cause) {
    const message = cause instanceof InputPreparationCompileError
      ? cause.message
      : cause instanceof Error ? cause.message : String(cause);
    return refuse('tool_surface_unfingerprintable', message);
  }

  // Every projected server must arrive with the identity the daemon resolved
  // for it. A missing one is a refusal, never a substituted "unattested": those
  // are different facts, and only one of them was ever digested.
  const bindingServers: PreparedToolBindingServerDigestInputV1[] = [];
  for (const server of input.servers) {
    const implementation = input.toolImplementations[server.serverName];
    if (implementation === undefined) {
      return refuse(
        'tool_binding_drift',
        `MCP server ${JSON.stringify(server.serverName)} arrived without the implementation identity the preparation`
        + ' bound for it',
      );
    }
    bindingServers.push({
      serverName: server.serverName,
      toolsetId: server.toolsetId,
      command: server.command,
      args: server.args,
      implementation,
    });
  }

  const toolBindingDigest = preparedToolBindingDigest({
    launch: input.launch,
    toolsetDefinitionRevisions: input.toolsetDefinitionRevisions,
    servers: bindingServers,
  });
  if (toolBindingDigest !== input.expectedToolBindingDigest) {
    return refuse(
      'tool_binding_drift',
      'the launch boundary, toolset revisions, configured argv or implementation identities of this device no longer'
      + ' match the ones the preparation froze',
    );
  }

  const observationDigest = preparedToolSurfaceObservationDigest({
    launch: input.launch,
    permissionMode: input.countedPermissionMode,
    runtimeIdentity: input.runtimeIdentity,
    toolsetDefinitionRevisions: input.toolsetDefinitionRevisions,
    tools,
    toolExecutors,
    implementations: input.toolImplementations,
  });
  if (observationDigest !== input.expectedObservationDigest) {
    return refuse(
      'tool_observation_drift',
      'the tool schemas, executor fingerprints or implementation identities observed for this launch differ from the'
      + ' ones the preparation counted',
    );
  }

  // Built only after both digests agree: a tool closure is an executable
  // capability, and there is no reason to construct one for a surface that has
  // already been refused.
  const piTools = createPiMcpTools(projected, input.host, 'qualified');
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
